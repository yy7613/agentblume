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
 * ## なぜ認証より前に走るのか
 *
 * 以前はこのフックを認証・認可の**後**に登録していた。Fastify は各フックの前に `reply.sent` を
 * 見るため、認証が401を送った時点で以降のフックは走らない ＝ **401も403も一切数えられない**
 * （実測: `max:3` に対して不正トークン12回が全て401、429はゼロ）。一方 `onResponse` の監査は
 * 走るので、401ごとに `audit_log` へ1行入る。つまりレート制限が効かないだけでなく、
 * **資格情報を持たないリモートがディスクを埋められる書き込み増幅装置**になっていた。
 *
 * よってレート制限は**最初に数える**。認証の成否に関わらず1リクエストは1リクエストである。
 *
 * ## 計数の単位が送信元IPだけになる件
 *
 * 認証より前なので `request.principal` はまだ無く、鍵は送信元IPに限られる。
 * 以前の「主体ごとに数える」は諦める。理由は単純で、**主体で数えるには主体が分かるまで
 * 待つ必要があり、待った時点で401が数えられなくなる**（上記の穴そのもの）。
 * 副作用として、同じマシン・同じNAT・同じリバースプロキシの背後にいる利用者は枠を共有する。
 * 既定の上限（600/分）は通常操作では当たらない高さに置いてあるのでこれを許容する。
 * 共有IPで足りなくなる規模の運用では `rateLimit` で上限を上げること。
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
 * 計数の単位。**送信元IPだけ**。
 *
 * このフックは認証より前に走るため、ここで分かる識別子はIPしかない
 * （モジュール冒頭「なぜ認証より前に走るのか」を参照）。
 */
export function keyOf(request: Pick<FastifyRequest, 'ip'>): string {
  return request.ip;
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
 * レート制限フックを登録する。**認証フックより前**に呼ぶこと
 * （後に置くと401・403が数えられない。理由はモジュール冒頭）。
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
