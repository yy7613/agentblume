/**
 * api層: リクエストレート制限（固定ウィンドウ）。
 *
 * ## なぜ `@fastify/rate-limit` を使わないか
 *
 * Fastify の `register()` は**プラグインの実行を `ready()` まで遅延**する。一方フックは
 * 「登録済みのルート」には後から効かない。したがって `buildServer` のように**同期的に**
 * ルートを登録する組み立てでは、`void app.register(rateLimit)` を先頭へ置いても
 * 一切効かない（実測: 上限2に対して4回とも200）。効かせるには全ルート登録を
 * `app.register(async (instance) => { await instance.register(rateLimit); ...routes })`
 * の中へ入れ子にする必要があり、
 *
 *   - `buildServer` は同期関数として60箇所以上から呼ばれている
 *   - `collectingApiPrefixes` の同期的な切り替え（＝認証の締め出し防止ロジック）が
 *     ready 時実行へずれて壊れる
 *
 * という代償が大きい。ここで必要なのは「暴走したクライアントと課金APIの浪費を止める」
 * ことであって分散カウンタではないので、`onRequest` フック1本で足りる。
 *
 * ## 何を守るか
 *
 * - 既定バケット: 全APIの合計（無限ループ・暴走リトライ）。
 * - `search` バケット: `POST /web-searches` は**外部の課金APIを消費する**ので別枠かつ厳しく。
 * - `mcp-test` バケット: `POST /mcp-servers/:name/test` は**子プロセスの起動**を伴うので別枠。
 *
 * バケットを分けるのは、重い経路が軽い経路の予算を食い合わないようにするためである
 * （合計上限だけだと、検索を1回叩くたびに画面の一覧取得の残枠が減る）。
 *
 * ## 既知の限界
 *
 * このフックは**認証フックの後**に走る（認証は `buildServer` がルート登録前に張るため）。
 * よって 401 で弾かれるリクエストは数えられない ＝ **トークン総当たりはここでは止まらない**。
 * 資格情報の試行回数制限は認証側の責務として別途必要（申し送り事項）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PUBLIC_PATHS, pathOf } from './authentication';

export interface RateLimitRule {
  /** ウィンドウ内に許す回数。 */
  readonly max: number;
  /** ウィンドウ幅（ミリ秒）。 */
  readonly windowMs: number;
}

/**
 * 既定の上限。**通常操作では絶対に当たらない**高さにする。
 * 画面遷移で十数リクエストが同時に飛ぶので、これを絞ると普通の操作が壊れる。
 */
export const DEFAULT_RATE_LIMIT: RateLimitRule = { max: 600, windowMs: 60_000 };
/** 外部の課金APIを消費する経路。1分に30回叩けば人間の操作としては十分すぎる。 */
export const SEARCH_RATE_LIMIT: RateLimitRule = { max: 30, windowMs: 60_000 };
/** 子プロセス起動・外部接続を伴う経路。 */
export const MCP_TEST_RATE_LIMIT: RateLimitRule = { max: 30, windowMs: 60_000 };

/** カウンタの上限。想定は「利用者数 × バケット数」で数十件。異常時でもメモリを食わせない。 */
export const MAX_RATE_LIMIT_KEYS = 10_000;

export interface RateLimitOptions {
  readonly default?: RateLimitRule;
  readonly search?: RateLimitRule;
  readonly mcpTest?: RateLimitRule;
  /** テスト用の時刻源。 */
  readonly now?: () => number;
}

type Bucket = 'default' | 'search' | 'mcp-test';

/** リクエストをバケットへ割り当てる。重い経路は軽い経路と予算を分ける。 */
export function bucketOf(method: string, url: string): Bucket {
  const path = pathOf(url);
  if (method === 'POST' && path === '/web-searches') return 'search';
  if (method === 'POST' && /^\/mcp-servers\/[^/]+\/test$/.test(path)) return 'mcp-test';
  return 'default';
}

/**
 * 計数の単位。認証済みなら主体、そうでなければ送信元IP。
 *
 * 主体で数えるのは、同じマシンから複数のトークンで使う構成（開発時の検証）で
 * 互いの枠を食い合わないようにするためである。
 */
function keyOf(request: FastifyRequest): string {
  return request.principal?.subject ?? request.ip;
}

interface Counter { count: number; resetAt: number }

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** ウィンドウが空くまでの秒数（切り上げ）。 */
  readonly resetSeconds: number;
}

/** 固定ウィンドウのカウンタ。Fastify から切り離して単体テストできるようにしてある。 */
export class RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly rules: Readonly<Record<Bucket, RateLimitRule>>;
  private readonly now: () => number;

  constructor(options: RateLimitOptions = {}) {
    this.rules = {
      default: options.default ?? DEFAULT_RATE_LIMIT,
      search: options.search ?? SEARCH_RATE_LIMIT,
      'mcp-test': options.mcpTest ?? MCP_TEST_RATE_LIMIT,
    };
    this.now = options.now ?? (() => Date.now());
  }

  /** 1回ぶん数えて判定する。 */
  hit(key: string, bucket: Bucket): RateLimitDecision {
    const rule = this.rules[bucket];
    const now = this.now();
    this.sweep(now);
    const id = `${bucket}:${key}`;
    const counter = this.counters.get(id);
    if (counter === undefined || counter.resetAt <= now) {
      this.counters.set(id, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, limit: rule.max, remaining: rule.max - 1, resetSeconds: Math.ceil(rule.windowMs / 1000) };
    }
    counter.count += 1;
    const resetSeconds = Math.max(1, Math.ceil((counter.resetAt - now) / 1000));
    return {
      allowed: counter.count <= rule.max,
      limit: rule.max,
      remaining: Math.max(0, rule.max - counter.count),
      resetSeconds,
    };
  }

  /** 期限切れのカウンタを捨てる。上限に達していたら期限切れでなくても古い順に捨てる。 */
  private sweep(now: number): void {
    for (const [id, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(id);
    }
    if (this.counters.size < MAX_RATE_LIMIT_KEYS) return;
    // ここへ来るのは異常系（多数の送信元）。取りこぼしよりメモリを守るほうを優先する。
    const excess = this.counters.size - MAX_RATE_LIMIT_KEYS + 1;
    for (const id of [...this.counters.keys()].slice(0, excess)) this.counters.delete(id);
  }

  /** 保持しているカウンタ数（テスト・診断用）。 */
  get size(): number { return this.counters.size; }
}

/**
 * レート制限フックを登録する。
 *
 * `/health` `/ready` は監視から資格情報なしで叩かれるので数えない
 * （ここで 429 を返すと、負荷とは無関係に「落ちている」と判定されてしまう）。
 */
export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions = {}): RateLimiter {
  const limiter = new RateLimiter(options);
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(pathOf(request.url))) return;
    const decision = limiter.hit(keyOf(request), bucketOf(request.method, request.url));
    void reply.header('ratelimit-limit', String(decision.limit))
      .header('ratelimit-remaining', String(decision.remaining))
      .header('ratelimit-reset', String(decision.resetSeconds));
    if (decision.allowed) return;
    void reply.status(429)
      .header('retry-after', String(decision.resetSeconds))
      .send({ error: { code: 'RATE_LIMITED', message: `too many requests; retry after ${decision.resetSeconds}s` } });
  });
  return limiter;
}
