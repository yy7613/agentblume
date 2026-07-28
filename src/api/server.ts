/**
 * api層: buildServer — Fastify インスタンスの組み立て（v4 実装契約 §5）
 *
 * Fastify 生成 → setErrorHandler（toHttpError）→ registerToolRoutes →
 * `GET /health`（liveness）/ `GET /ready`（readiness）→ ビルド済みUIの静的配信を追加して返す。
 * **listen はしない**（エントリポイント src/server.ts の責務）。
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { LogLevel } from '../config/environment';
import type { AuthenticationPort } from '../application/security/authentication';
import type { AuthorizationPort } from '../application/security/authorization';
import { defaultAuthentication, registerAuthRoutes, registerAuthentication } from './authentication';
import { defaultAuthorization, registerAuthorization, type AuditOptions } from './authorization';
import { registerHostCheck, type HostCheckOptions } from './host-check';
import { registerRateLimit, type RateLimitOptions } from './rate-limit';
import { loggerOptions } from './logging';
import { registerDraftToolRoutes } from './draft-tool-routes';
import type { DraftToolRouteDeps } from './draft-tool-routes';
import { toHttpError } from './error-mapping';
import { registerToolRoutes } from './tool-routes';
import type { ToolRouteDeps } from './tool-routes';
import { registerRunRoutes } from './run-routes';
import type { RunRouteDeps } from './run-routes';
import { registerAgentRoutes, type AgentRouteDeps } from './agent-routes';
import { registerSkillRoutes, type SkillRouteDeps } from './skill-routes';
import { registerValidationRoutes, type ValidationRouteDeps } from './validation-routes';
import { registerEvaluationRoutes, type EvaluationRouteDeps } from './evaluation-routes';
import { registerMemoryRoutes, type MemoryRouteDeps } from './memory-routes';
import { registerEvaluationAssetRoutes, type EvaluationAssetRouteDeps } from './evaluation-asset-routes';
import { registerExperimentRoutes, type ExperimentRouteDeps } from './experiment-routes';
import { registerQualityGateRoutes, type QualityGateRouteDeps } from './quality-gate-routes';
import { registerOperationsRoutes, type OperationsRouteDeps } from './operations-routes';
import { registerSessionRoutes, type SessionRouteDeps } from './session-routes';
import { registerDataSourceRoutes, type DataSourceRouteDeps } from './data-source-routes';
import { registerHarnessRoutes, type HarnessRouteDeps } from './harness-routes';
import { registerHarnessRunRoutes, type HarnessRunRouteDeps } from './harness-run-routes';
import { registerFactoryRoutes, type FactoryRouteDeps } from './factory-routes';
import { registerMcpRoutes, type McpRouteDeps } from './mcp-routes';
import { registerModelSettingsRoutes, type ModelSettingsRouteDeps } from './model-settings-routes';
import { registerSampleDataRoutes, type SampleDataRouteDeps } from './sample-data-routes';

/**
 * チャットの画像（最大2枚・各3 MiB）はBase64化で合計約8 MiBになる。
 * JSONのメタデータ分も含めて受理できるよう、10 MiBまで許可する。
 */
export const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * **リクエストを受信し終える**までの上限（Node の `server.requestTimeout`）。
 *
 * 応答（ハンドラの実行時間）はこの対象ではない。実測でも `requestTimeout=800ms` のサーバーで
 * 2.5秒かかるハンドラは正常に 200 を返す。よって Harness 実行（最大1時間）や
 * モデル呼び出し（既定10分）を殺さない。Fastify の既定は `0`（＝無効）なので、
 * ボディを少しずつしか送らない接続がソケットを握り続けられる状態だった。
 * 10 MiB のアップロードを想定して十分に長い2分を上限にする。
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * 応答完了後のkeep-aliveソケットを閉じるまでの待ち時間（Node の `server.keepAliveTimeout`）。
 * 実行中のリクエストには影響しない。Fastify の既定値（72秒）を明示する。
 */
export const KEEP_ALIVE_TIMEOUT_MS = 72_000;

/**
 * ソケットの無通信タイムアウト（Node の `server.timeout`）。**0（無効）のまま**にする。
 *
 * これを有効にすると「モデルが長考していて何も流れていない」状態のソケットが切られ、
 * Harness実行・Agent実行（HTTPリクエスト内で最大1時間動く）が落ちる。
 * 長時間経路のワーカー化（リクエストから切り離す）は別タスク。それが済むまでは無効を維持する。
 */
export const CONNECTION_TIMEOUT_MS = 0;

/** `/ready` が確認する必須依存。 */
export interface ReadinessCheck {
  /** 応答に出す名前（例: `database`）。 */
  readonly name: string;
  /** 到達できなければ throw する。 */
  probe(): Promise<void>;
}

/** `buildServer` のログ設定。`true` は「既定レベル（info）で有効」の短縮形。 */
export type LoggerOption = boolean | { readonly level: LogLevel };

/** ログを有効にしたときの既定レベル（`logger: true` の短縮形が指す先）。 */
export const DEFAULT_SERVER_LOG_LEVEL: LogLevel = 'info';

/**
 * `ServerOptions.logger` を Fastify のロガー設定へ落とす。
 *
 * 有効なときは**必ず** `loggerOptions()` を通す。`logger: true` をそのまま Fastify へ渡すと
 * redact 無しの素の pino になるため、この関数を挟むことで「有効化したのにマスクされない」経路を無くす。
 */
export function resolveLoggerOption(option: LoggerOption | undefined): FastifyServerOptions['logger'] {
  if (option === undefined || option === false) return false;
  return loggerOptions(option === true ? DEFAULT_SERVER_LOG_LEVEL : option.level);
}

/** buildServer のオプション。 */
export interface ServerOptions {
  /** `false`／省略でロガー無効（テスト用）。`true` で既定レベル、`{ level }` でレベル指定。 */
  readonly logger?: LoggerOption;
  /**
   * ビルド済みUI（`index.html` を含むディレクトリ）の絶対パス。
   * 指定したときだけ静的配信とSPAフォールバックを有効にする（開発時は Vite が配信するので指定しない）。
   */
  readonly uiRoot?: string;
  /** `/ready` の確認対象。省略時は依存チェック無しで ready を返す。 */
  readonly readiness?: readonly ReadinessCheck[];
  /** `/health` `/ready` に載せるソース版（`AGENTCONTEXT_SOURCE_REVISION`）。 */
  readonly revision?: string;
  /**
   * 資格情報 → Principal の解決。**省略時は単一ユーザーモード**（既定テナントを常に返す）。
   *
   * 本番経路（`src/server.ts`）は composition が env から組み立てた実装を必ず渡す。
   * 省略はテストと埋め込み利用のための互換動作で、`127.0.0.1` 以外へバインドする構成では
   * `serverSettings`（`src/config/environment.ts`）が起動を拒否する。
   */
  readonly authentication?: AuthenticationPort;
  /**
   * Principal + action → 許可/拒否。**省略時もロール表による判定が入る**
   * （`defaultAuthorization()`）。単一ユーザーモードの Principal は全ロールを持つので、
   * 省略しても従来どおり全操作が通る。
   */
  readonly authorization?: AuthorizationPort;
  /**
   * 監査ログの書き込み先。**省略すると監査を取らない**（テスト・埋め込み用）。
   * 本番経路（`src/server.ts`）は composition が組み立てた sink を必ず渡す。
   */
  readonly audit?: AuditOptions;
  /**
   * レート制限の上限。省略時は既定（`rate-limit.ts`）で**必ず有効**。
   * `false` で無効化できるが、これは埋め込み利用のための逃げ道であって本番の選択肢ではない。
   */
  readonly rateLimit?: RateLimitOptions | false;
  /**
   * `Host` ヘッダの許可リスト（DNSリバインディング対策）。省略時は検査しない。
   * 本番経路（`src/server.ts`）はループバックへバインドしたときだけ渡す。
   */
  readonly hostCheck?: HostCheckOptions;
}

/** `/foo/bar?x=1` → `/foo`。ルートパスや空文字は `undefined`。 */
function firstSegment(url: string): string | undefined {
  const path = url.split('?')[0] ?? '';
  const match = /^(\/[^/?#]+)/.exec(path);
  return match?.[1];
}

/** `/assets/index-a1b2.js` のように拡張子つきに見えるパスか（存在しない静的ファイルの判定に使う）。 */
function looksLikeFile(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.');
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** ルート・エラーハンドラ設定済みの Fastify インスタンスを組み立てる（listen しない）。 */
export function buildServer(
  deps: ToolRouteDeps & DraftToolRouteDeps & RunRouteDeps & AgentRouteDeps & HarnessRouteDeps & HarnessRunRouteDeps & SkillRouteDeps & ValidationRouteDeps & EvaluationRouteDeps & EvaluationAssetRouteDeps & ExperimentRouteDeps & QualityGateRouteDeps & MemoryRouteDeps & OperationsRouteDeps & SessionRouteDeps & DataSourceRouteDeps & FactoryRouteDeps & McpRouteDeps & ModelSettingsRouteDeps & SampleDataRouteDeps,
  options?: ServerOptions,
): FastifyInstance {
  const app = Fastify({
    logger: resolveLoggerOption(options?.logger),
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });

  // ハンドラから throw された例外を §2 のマッピングで HTTP へ変換する。
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toHttpError(error);
    void reply.status(status).send(body);
  });

  // APIが所有するパス接頭辞を登録しながら集める。SPAフォールバックの除外条件に使う
  // （`/tools/typo` のように**既知のAPI接頭辞の下**の綴り間違いへ index.html を返すと、
  // UIは「JSONでない応答」で失敗して原因が分からなくなる）。
  // 接頭辞そのものが未知の `/toolz` はUIのルートと区別できないため、SPAへ倒すのが正しい。
  const apiPrefixes = new Set<string>();
  /**
   * 収集を止めるタイミングが要る。`@fastify/static` は `wildcard: false` のときファイル単位で
   * ルートを張るため、止めないと `/assets` まで「APIの接頭辞」に混ざる。そうなると
   * 認証フックが `/assets/*.js` を保護対象と見なし、**トークン入力画面のJSが401で落ちて
   * 誰もサインインできなくなる**（復旧不能な締め出し）。
   */
  let collectingApiPrefixes = true;
  app.addHook('onRoute', (route) => {
    if (!collectingApiPrefixes) return;
    const prefix = firstSegment(route.url);
    if (prefix !== undefined) apiPrefixes.add(prefix);
  });

  /**
   * `Host` 検査は**最初**に置く。ここを通す時点で「このオリジンからの操作を受け付ける」と
   * 決めているので、認証・認可より手前で切るのが筋（DNSリバインディングは、
   * 攻撃者のドメインを 127.0.0.1 へ解決させて被害者のブラウザに叩かせる手口なので、
   * 単一ユーザーモードでは認証が無い＝Hostだけが最後の識別子になる）。
   */
  if (options?.hostCheck !== undefined) registerHostCheck(app, options.hostCheck);

  /**
   * レート制限は**認証より前**。Fastify は各フックの前に `reply.sent` を見るので、
   * 認証の後ろに置くと 401 / 403 が一切数えられない（＝資格情報を持たない相手からの
   * 総当たりが無制限に通り、その1回ごとに監査ログが1行増える）。詳細は `rate-limit.ts` 冒頭。
   * 認証前なので計数の鍵は送信元IPになる。
   *
   * CORS（`@fastify/cors`）は**入れない**。UIは同一オリジンで配信され（`registerUi`）、
   * 開発時も Vite の proxy 経由なのでブラウザから見れば同一オリジンである。
   * つまりクロスオリジンでこのAPIを叩く正当な利用者は存在せず、**何も付けない
   * ＝ブラウザの既定で拒否**が最も安全な設定になる。ヘッダを足す必要が出るのは
   * 「別オリジンのUIから使う」構成を導入したときで、そのときに許可オリジンを
   * 明示列挙して入れるべきもの（ワイルドカードで先回りしない）。
   */
  if (options?.rateLimit !== false) registerRateLimit(app, options?.rateLimit ?? {});

  /**
   * 認証は**ルート登録より前**に置く（Fastify のフックは、そのインスタンスへ後から登録される
   * ルートに適用される）。`apiPrefixes` は上の onRoute が埋めるSetの参照をそのまま渡すので、
   * リクエストが来る時点では全ルート分が入っている。
   */
  const authentication = options?.authentication ?? defaultAuthentication();
  registerAuthentication(app, authentication, apiPrefixes);
  /**
   * 認可は**認証の直後**に登録する。フックは登録順に走るので、`request.principal` が
   * 載ったあとで判定でき、ボディをパースする前に 403 を返せる。
   */
  registerAuthorization(app, {
    authorization: options?.authorization ?? defaultAuthorization(),
    ...(options?.audit === undefined ? {} : { audit: options.audit }),
  });

  registerAuthRoutes(app, authentication);

  registerToolRoutes(app, deps);
  registerDraftToolRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerAgentRoutes(app, deps);
  registerHarnessRoutes(app, deps);
  registerHarnessRunRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerValidationRoutes(app, deps);
  registerEvaluationRoutes(app, deps);
  registerEvaluationAssetRoutes(app, deps);
  registerExperimentRoutes(app, deps);
  registerQualityGateRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerOperationsRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerDataSourceRoutes(app, deps);
  registerFactoryRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerModelSettingsRoutes(app, deps);
  registerSampleDataRoutes(app, deps);

  const revision = options?.revision;
  const buildInfo = { node: process.version, ...(revision === undefined ? {} : { revision }) };

  /**
   * liveness: プロセスが生きているかだけを見る。**依存は一切叩かない**。
   * これが落ちたら再起動するしかない、という判断に使う（DB断で再起動しても直らない）。
   */
  app.get('/health', async () => ({ status: 'ok', ...buildInfo, uptimeSeconds: Math.floor(process.uptime()) }));

  /**
   * readiness: 必須依存（DB）へ実際に到達できるかを見る。
   * 落ちている間はトラフィックを流すべきでない、という判断に使うので 503 を返す。
   */
  app.get('/ready', async (_request, reply) => {
    const checks = await Promise.all((options?.readiness ?? []).map(async (check) => {
      try {
        await check.probe();
        return { name: check.name, status: 'ok' as const };
      } catch (error) {
        return { name: check.name, status: 'error' as const, error: messageOf(error) };
      }
    }));
    const ready = checks.every((check) => check.status === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unready', ...buildInfo, checks });
  });

  // ここまでに登録されたものがAPIのパス。以降（静的ファイル）はUI側として扱う。
  collectingApiPrefixes = false;
  if (options?.uiRoot !== undefined) registerUi(app, options.uiRoot, apiPrefixes);

  return app;
}

/**
 * ビルド済みUIを配信する（`npm start` 用）。
 *
 * `wildcard: false` を選ぶ理由: 既定の `/*` は「未登録のAPIパス」まで飲み込むため、
 * どこまでがAPIでどこからがUIかを Fastify のルータではなくプラグイン側の 404 経路で
 * 判断することになる。ファイル単位でルートを張れば、残りは素直に notFound へ落ちる。
 */
function registerUi(app: FastifyInstance, uiRoot: string, apiPrefixes: ReadonlySet<string>): void {
  void app.register(fastifyStatic, { root: uiRoot, wildcard: false, index: ['index.html'] });

  app.setNotFoundHandler((request, reply) => {
    const prefix = firstSegment(request.url);
    const isApi = prefix !== undefined && apiPrefixes.has(prefix);
    // SPAへ倒してよいのは「APIでもファイル要求でもないGET」だけ。
    // 存在しない `/assets/*.js` に index.html を返すと、ブラウザは HTML を JS として実行しようとして失敗する。
    const spa = (request.method === 'GET' || request.method === 'HEAD') && !isApi && !looksLikeFile(request.url);
    if (!spa) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: `Route ${request.method}:${request.url} not found` });
    }
    return reply.sendFile('index.html');
  });
}
