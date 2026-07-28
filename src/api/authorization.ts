/**
 * api層: 認可（RBAC）フックと監査ログの記録点
 *
 * ## なぜ「表 + フック」なのか
 *
 * ルートは152本ある。各 `app.post(...)` の中へ判定を1行ずつ書く形にすると、
 * **足し忘れが「認可の無いエンドポイント」として表に出ない**（テストは通り、画面も動く）。
 * ここでは「メソッド + ルートURL → 必要な権限」を1枚の表にして、フックが機械的に適用する。
 * 表に無いルートは既定（読みは `read` / 書きは `edit` / 削除は `delete`）へ落ちるが、
 * `authorization.test.ts` が**登録済みの全ルートが表に載っていること**を検査するので、
 * ルートを足して表を忘れると赤くなる。
 *
 * ボディの中身で必要な権限が変わるルート（Harnessの応答は「入力」か「承認」か）は、
 * 表では最小権限を要求し、ハンドラが `authorizeOf(request)` で追加判定する。
 *
 * ## 監査をここでまとめて取る理由
 *
 * 「誰が」「何に」「どうなったか」はすべてこのフックの位置に揃っている
 * （Principal・ルート・パラメータ・最終ステータス）。ハンドラ側へ書くと記録漏れが起きるので、
 * 表の `audit` フラグで宣言し、`onResponse` が結果と一緒に1件書く。
 * ハンドラが足したい情報（承認の可否など）は `recordAuditDetail(request, ...)` で渡す。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditSink } from '../application/security/audit';
import type { AuthorizationPort } from '../application/security/authorization';
import { createAuditEntry, type AuditDetailValue, type AuditOutcome, type AuditResource, UNAUTHENTICATED_SUBJECT } from '../domain/security/audit';
import { decideAuthorization, type AuthorizationAction, type AuthorizationResource, type AuthorizationResourceKind } from '../domain/security/authorization';
import { principalScope } from '../domain/security/principal';
import type { TenantScope } from '../domain/tool/ids';
import { pathOf } from './authentication';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * 表（`ROUTE_RULES`）に無く、既定へ落ちたルート（`GET /foo` 形式）。
     *
     * 認可の割り当ては**宣言的であるべき**で、既定はあくまで保険。ここが空でないことは
     * 「誰かがルートを足して権限を決め忘れた」を意味する。テストがこれを検査する。
     */
    readonly unmappedAuthorizationRoutes: string[];
    /** 認可の対象になったルート（`GET /foo` 形式）。網羅性テストが使う。 */
    readonly authorizedRoutes: string[];
  }

  interface FastifyRequest {
    /** このルートの認可要件（`onResponse` の監査が読む）。 */
    routeAuthorization?: RouteAuthorization;
    /** ハンドラが本文を見て追加判定するための入口（`authorizeOf`）。 */
    authorizeAction?: (action: AuthorizationAction, resource?: AuthorizationResource) => Promise<void>;
    /** ハンドラが監査へ足した補足。 */
    auditDetail?: Record<string, AuditDetailValue>;
  }
}

/** 認可で拒否された（403 FORBIDDEN）。メッセージには**必要な権限だけ**を書く。 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** 1ルートに割り当てる認可要件。 */
export interface RouteAuthorization {
  readonly action: AuthorizationAction;
  readonly kind: AuthorizationResourceKind;
  /** true なら結果（成功・失敗）を監査ログへ残す。拒否は `audit` に関係なく必ず残す。 */
  readonly audit?: boolean;
}

/** 表の1行。 */
interface RouteRule extends RouteAuthorization {
  readonly method: string;
  readonly url: string;
}

/**
 * 認可判定を行わないルート。
 *
 * - `/health` `/ready`: 認証すらしない（監視用）。
 * - `/auth/session`: 「自分は誰か」を返すだけ。ここを閉じると、権限の足りない利用者が
 *   **自分に何の権限が無いのかを画面で確認できなくなる**（403の理由を読む手段が消える）。
 */
export const AUTHORIZATION_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/health', '/ready', '/auth/session']);

const rule = (method: string, url: string, action: AuthorizationAction, kind: AuthorizationResourceKind, audit = false): RouteRule =>
  ({ method, url, action, kind, audit });

/**
 * ルート → 必要な権限の対応表（`docs/04-api-spec.md` §3 の「認可アクション」列に対応）。
 *
 * ## 割り当ての方針
 *
 * - 参照（GET）は `read`。§3.2 の表で全ロールが持つ。
 * - 資産の作成・更新は `create` / `edit`（Editor以上）。
 * - 実行は `execute`（Editor以上）。
 * - **承認は `approve`（Publisher以上）**。§4 の「実行前承認は approve 権限を認可判定」に従う。
 *   ツール承認（`/runs/:runId/resume`）・昇格承認・記憶提案の採否がこれにあたる。
 * - **運用は `operate`（Operator以上）**。稼働状況・保持期限・バックアップ・サンプル投入。
 *   保持期間を0日にして適用すれば全実行履歴が消えるので、実行系とは別の権限にする。
 * - **削除は `delete`（実質 Workspace Admin）**。§3.2 は Editor/Publisher に「自作のみ」を
 *   認めているが、作成者の subject を保存していないため所有者を判定できない。
 *   §3.1 のフェイルセーフに従い、判定できない場合は拒否する。
 * - モデル設定はAPIキーを預かるので、参照は `read`、変更と接続テストは `operate`。
 *
 * ## 監査（`audit: true`）を付ける基準
 *
 * 全リクエストを記録すると台帳が実行ログの写しになり、肝心の行が埋もれる。
 * 「後から必ず問われる操作」だけを残す:
 * 削除 / 承認 / 昇格の申請と決定 / 運用操作（保持期限・バックアップ・設定変更）/
 * 実行の開始（Agent・Harness・Factory・シナリオ）/
 * **接続テスト**（子プロセスの起動・保存済み資格情報の外部送出を伴うため、保存を伴わなくても残す）。
 * 参照と、資産の作成・更新はバージョン履歴が別に残るので対象外。
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // --- tools ---
  rule('GET', '/tools', 'read', 'tool'),
  rule('POST', '/tools', 'create', 'tool'),
  rule('GET', '/tools/:internalId', 'read', 'tool'),
  rule('GET', '/tools/:internalId/versions', 'read', 'tool'),
  rule('DELETE', '/tools/:internalId', 'delete', 'tool', true),
  rule('POST', '/tools/:internalId/infer-schema', 'edit', 'tool'),
  rule('POST', '/tools/:internalId/preview', 'execute', 'tool'),
  rule('POST', '/tool-drafts/infer-schema', 'edit', 'tool'),
  rule('POST', '/tool-drafts/preview', 'execute', 'tool'),
  rule('POST', '/tool-drafts/suggest-analysis-config', 'edit', 'tool'),
  rule('GET', '/runtime/capabilities', 'read', 'workspace'),

  // --- skills ---
  rule('POST', '/skills', 'create', 'skill'),
  rule('GET', '/skills', 'read', 'skill'),
  rule('GET', '/skills/:internalId', 'read', 'skill'),
  rule('GET', '/skills/:internalId/versions', 'read', 'skill'),
  rule('DELETE', '/skills/:internalId', 'delete', 'skill', true),
  rule('POST', '/skill-drafts/generate-prompt', 'edit', 'skill'),
  rule('POST', '/skills/:internalId/generate-prompt', 'edit', 'skill'),

  // --- agents ---
  rule('POST', '/agents', 'create', 'agent'),
  rule('GET', '/agents', 'read', 'agent'),
  rule('GET', '/agents/:internalId', 'read', 'agent'),
  rule('GET', '/agents/:internalId/versions', 'read', 'agent'),
  rule('DELETE', '/agents/:internalId', 'delete', 'agent', true),
  rule('POST', '/agent-drafts/generate-prompt', 'edit', 'agent'),
  rule('POST', '/agents/:internalId/generate-prompt', 'edit', 'agent'),

  // --- runs（Agent実行と承認） ---
  rule('POST', '/runs', 'execute', 'agent', true),
  // ツール実行の事前承認。§4 の「approve 権限を認可判定」に対応する唯一の同期的な承認点。
  rule('POST', '/runs/:runId/resume', 'approve', 'run', true),
  rule('GET', '/runs', 'read', 'run'),
  rule('GET', '/runs/:runId/trace', 'read', 'run'),
  rule('PUT', '/runs/:runId/feedback', 'edit', 'run'),
  rule('GET', '/runs/:runId/feedback', 'read', 'run'),

  // --- harness ---
  rule('POST', '/harnesses', 'create', 'harness'),
  rule('GET', '/harnesses', 'read', 'harness'),
  rule('GET', '/harnesses/:internalId', 'read', 'harness'),
  rule('GET', '/harnesses/:internalId/versions', 'read', 'harness'),
  rule('DELETE', '/harnesses/:internalId', 'delete', 'harness', true),
  rule('POST', '/harness-drafts/validate', 'edit', 'harness'),
  rule('POST', '/harness-drafts/compile', 'edit', 'harness'),
  rule('POST', '/harness-runs', 'execute', 'harness', true),
  /**
   * Handoffの追加入力（`kind: 'input'`）と Magentic の計画承認（`kind: 'approval'`）が
   * 同じ入口に同居している。表では実行と同じ `execute` を要求し、
   * 承認の場合だけハンドラが `approve` を追加で判定する（`harness-run-routes.ts`）。
   */
  rule('POST', '/harness-runs/:runId/responses', 'execute', 'harness', true),
  rule('POST', '/harness-runs/:runId/cancel', 'execute', 'harness'),
  rule('GET', '/harness-runs', 'read', 'run'),
  rule('GET', '/harness-runs/:runId', 'read', 'run'),
  rule('GET', '/harness-runs/:runId/events', 'read', 'run'),

  // --- factory ---
  rule('POST', '/factory-runs', 'execute', 'factory', true),
  rule('GET', '/factory-runs', 'read', 'factory'),
  rule('GET', '/factory-runs/:runId', 'read', 'factory'),
  rule('GET', '/factory-runs/:runId/events', 'read', 'factory'),
  // 計画承認しか来ない入口なので、表の時点で approve を要求する。
  rule('POST', '/factory-runs/:runId/responses', 'approve', 'factory', true),
  rule('POST', '/factory-runs/:runId/retry', 'execute', 'factory', true),
  rule('POST', '/factory-runs/:runId/cancel', 'execute', 'factory'),

  // --- 検証（persona / scenario） ---
  rule('POST', '/personas', 'create', 'evaluation'),
  rule('GET', '/personas', 'read', 'evaluation'),
  rule('GET', '/personas/:internalId', 'read', 'evaluation'),
  rule('GET', '/personas/:internalId/versions', 'read', 'evaluation'),
  rule('DELETE', '/personas/:internalId', 'delete', 'evaluation', true),
  rule('POST', '/personas/:internalId/register-agent', 'create', 'agent'),
  rule('POST', '/scenarios', 'create', 'evaluation'),
  rule('GET', '/scenarios', 'read', 'evaluation'),
  rule('GET', '/scenarios/:internalId', 'read', 'evaluation'),
  rule('GET', '/scenarios/:internalId/versions', 'read', 'evaluation'),
  rule('DELETE', '/scenarios/:internalId', 'delete', 'evaluation', true),
  rule('POST', '/scenarios/:internalId/run', 'execute', 'evaluation', true),
  rule('GET', '/scenario-runs', 'read', 'run'),
  rule('GET', '/scenario-runs/:id', 'read', 'run'),

  // --- 評価資産 ---
  rule('POST', '/evaluations', 'execute', 'evaluation'),
  rule('POST', '/evaluation-datasets', 'create', 'evaluation'),
  rule('POST', '/evaluation-datasets/import', 'create', 'evaluation'),
  rule('GET', '/evaluation-datasets', 'read', 'evaluation'),
  rule('GET', '/evaluation-datasets/:internalId', 'read', 'evaluation'),
  rule('GET', '/evaluation-datasets/:internalId/versions', 'read', 'evaluation'),
  rule('GET', '/evaluation-datasets/:internalId/export', 'read', 'evaluation'),
  rule('DELETE', '/evaluation-datasets/:internalId', 'delete', 'evaluation', true),
  rule('POST', '/evaluator-profiles', 'create', 'evaluation'),
  rule('GET', '/evaluator-profiles', 'read', 'evaluation'),
  rule('GET', '/evaluator-profiles/:internalId', 'read', 'evaluation'),
  rule('GET', '/evaluator-profiles/:internalId/versions', 'read', 'evaluation'),
  rule('DELETE', '/evaluator-profiles/:internalId', 'delete', 'evaluation', true),
  rule('POST', '/judge-rubrics', 'create', 'evaluation'),
  rule('GET', '/judge-rubrics', 'read', 'evaluation'),
  rule('GET', '/judge-rubrics/:internalId', 'read', 'evaluation'),
  rule('GET', '/judge-rubrics/:internalId/versions', 'read', 'evaluation'),
  rule('DELETE', '/judge-rubrics/:internalId', 'delete', 'evaluation', true),

  // --- 実験 ---
  rule('POST', '/experiments', 'execute', 'evaluation', true),
  rule('GET', '/experiments', 'read', 'evaluation'),
  rule('GET', '/experiments/:id', 'read', 'evaluation'),
  rule('GET', '/experiments/:id/results', 'read', 'evaluation'),
  rule('POST', '/experiments/:id/cancel', 'execute', 'evaluation'),
  rule('POST', '/experiments/:id/resume', 'execute', 'evaluation'),

  // --- 品質ゲートと昇格 ---
  rule('POST', '/experiment-comparisons', 'read', 'evaluation'),
  rule('POST', '/gate-policies', 'create', 'evaluation'),
  rule('GET', '/gate-policies', 'read', 'evaluation'),
  rule('GET', '/gate-policies/:id', 'read', 'evaluation'),
  rule('GET', '/gate-policies/:id/versions', 'read', 'evaluation'),
  rule('DELETE', '/gate-policies/:id', 'delete', 'evaluation', true),
  rule('POST', '/gate-reports', 'execute', 'evaluation'),
  rule('GET', '/gate-reports', 'read', 'evaluation'),
  rule('GET', '/gate-reports/:id', 'read', 'evaluation'),
  rule('POST', '/agents/:id/versions/:version/promotion-requests', 'create', 'promotion', true),
  rule('GET', '/promotion-requests', 'read', 'promotion'),
  rule('POST', '/promotion-requests/:id/approve', 'approve', 'promotion', true),
  rule('POST', '/promotion-requests/:id/reject', 'approve', 'promotion', true),

  // --- 記憶（wiki / proposals） ---
  rule('GET', '/wikis', 'read', 'memory'),
  rule('POST', '/wikis', 'create', 'memory'),
  rule('GET', '/wikis/:id', 'read', 'memory'),
  rule('DELETE', '/wikis/:id', 'delete', 'memory', true),
  rule('GET', '/wikis/:wikiId/pages', 'read', 'memory'),
  rule('POST', '/wikis/:wikiId/pages', 'create', 'memory'),
  rule('GET', '/wikis/:wikiId/pages/:id', 'read', 'memory'),
  rule('GET', '/wiki', 'read', 'memory'),
  rule('POST', '/wiki', 'create', 'memory'),
  rule('GET', '/wiki/:id', 'read', 'memory'),
  rule('DELETE', '/wiki/:id', 'delete', 'memory', true),
  rule('POST', '/memory/reflect', 'edit', 'memory'),
  rule('GET', '/memory/proposals', 'read', 'memory'),
  rule('POST', '/memory/proposals/:id/approve', 'approve', 'memory', true),
  rule('POST', '/memory/proposals/:id/reject', 'approve', 'memory', true),

  // --- セッションと成果物 ---
  rule('POST', '/agent-sessions', 'create', 'session'),
  rule('GET', '/agent-sessions/:sessionId', 'read', 'session'),
  rule('POST', '/agent-sessions/:sessionId/close', 'edit', 'session'),
  rule('GET', '/agent-sessions/:sessionId/artifacts', 'read', 'session'),
  rule('GET', '/agent-sessions/:sessionId/artifacts/:artifactId', 'read', 'session'),
  /**
   * セッション成果物は実行の副産物で、セッションが閉じれば消える一時データ。
   * 版管理された資産の削除（`delete`）と同じ重みで縛ると通常の後片付けができなくなるため、
   * `edit` として扱う（監査には残す）。
   */
  rule('DELETE', '/agent-sessions/:sessionId/artifacts/:artifactId', 'edit', 'session', true),

  // --- データソース ---
  rule('GET', '/data-sources', 'read', 'data-source'),
  rule('GET', '/data-sources/connections', 'read', 'data-source'),
  rule('POST', '/data-sources/files', 'create', 'data-source'),
  rule('POST', '/data-sources/databases', 'create', 'data-source'),
  rule('POST', '/data-sources/connections/:connectionId/test', 'execute', 'data-source'),
  rule('DELETE', '/data-sources/:id', 'delete', 'data-source', true),
  rule('GET', '/search-providers', 'read', 'data-source'),
  rule('POST', '/web-searches', 'execute', 'data-source'),

  // --- MCP（別Waveが所有するルートだが、認可の割り当てはこの表が持つ） ---
  rule('GET', '/mcp-servers', 'read', 'mcp-server'),
  rule('POST', '/mcp-servers', 'create', 'mcp-server', true),
  rule('PUT', '/mcp-servers', 'edit', 'mcp-server', true),
  rule('DELETE', '/mcp-servers/:name', 'delete', 'mcp-server', true),
  // 接続テストは**子プロセスの起動と外部接続**そのもの。保存を伴わなくても「実行した」事実は残す。
  rule('POST', '/mcp-servers/:name/test', 'execute', 'mcp-server', true),

  // --- モデル設定（APIキーを預かるので変更は運用権限） ---
  rule('GET', '/model-settings', 'read', 'model-settings'),
  rule('PUT', '/model-settings', 'operate', 'model-settings', true),
  // 接続テストは**保存済みAPIキーを利用者指定の宛先へ送出する**。誰がどこへ試したかを残す。
  rule('POST', '/model-settings/test', 'operate', 'model-settings', true),
  rule('GET', '/model-catalog', 'read', 'model-settings'),
  rule('GET', '/model-catalog/:providerId/models', 'read', 'model-settings'),
  rule('POST', '/model-catalog/openai-compatible-models', 'operate', 'model-settings'),

  // --- 運用 ---
  rule('GET', '/operations/status', 'operate', 'workspace'),
  rule('GET', '/operations/retention', 'operate', 'workspace'),
  rule('PUT', '/operations/retention', 'operate', 'workspace', true),
  rule('POST', '/operations/retention/apply', 'operate', 'workspace', true),
  rule('POST', '/operations/backups', 'operate', 'workspace', true),
  rule('GET', '/operations/backups', 'operate', 'workspace'),
  rule('GET', '/operations/audit', 'read', 'audit-log'),

  // --- サンプルデータ（ワークスペースへ一括で書き込む） ---
  rule('POST', '/sample-data', 'operate', 'workspace', true),
];

const ruleKey = (method: string, url: string): string => `${method.toUpperCase()} ${url}`;
const RULES_BY_KEY: ReadonlyMap<string, RouteRule> = new Map(ROUTE_RULES.map((entry) => [ruleKey(entry.method, entry.url), entry]));

/** 表に明示された要件（無ければ `undefined`）。表の網羅性テストが使う。 */
export function explicitRouteAuthorization(method: string, url: string): RouteAuthorization | undefined {
  return RULES_BY_KEY.get(ruleKey(method, url));
}

/**
 * 表に無いルートの既定。
 *
 * 「読み取りは全ロール可、書き込みは Editor 以上」を最低線として必ず引く。
 * 新しいルートが無防備なまま増えないための保険で、**表に載せるのが正しい姿**
 * （テストが表への追加を強制する）。
 */
export function defaultRouteAuthorization(method: string): RouteAuthorization {
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS') return { action: 'read', kind: 'workspace' };
  if (upper === 'DELETE') return { action: 'delete', kind: 'workspace', audit: true };
  return { action: 'edit', kind: 'workspace' };
}

/**
 * ルートに適用する要件（表 → 既定の順）。
 *
 * **HEAD は GET として引く**。Fastify は `exposeHeadRoutes`（既定 true）でGETごとにHEADを
 * 自動生成するが、表はGETの行しか持たない。正規化しないと `HEAD /operations/audit` が
 * 既定（`workspace:read`＝全ロール許可）へ落ち、`audit-log:read` や `operate` の縛りが消える。
 * 本文は返らなくてもハンドラは実行され（ファイルI/O・集計クエリが走る）、
 * `content-length` が結果件数で変わるため**監査ログの検索オラクル**にもなる。
 */
export function routeAuthorizationFor(method: string, url: string): RouteAuthorization {
  const normalized = method.toUpperCase() === 'HEAD' ? 'GET' : method;
  return explicitRouteAuthorization(normalized, url) ?? defaultRouteAuthorization(normalized);
}

/** パスパラメータから「対象の識別子」を1つ選ぶ（監査の `resource.id`）。 */
const ID_PARAM_NAMES = ['internalId', 'runId', 'sessionId', 'wikiId', 'name', 'connectionId', 'providerId', 'id'] as const;

function resourceOf(request: FastifyRequest, kind: AuthorizationResourceKind): AuditResource {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const idName = ID_PARAM_NAMES.find((name) => typeof params[name] === 'string' && params[name] !== '');
  const version = typeof params['version'] === 'string' ? params['version'] : undefined;
  return {
    kind,
    ...(idName === undefined ? {} : { id: String(params[idName]) }),
    ...(version === undefined ? {} : { version }),
  };
}

/**
 * `buildServer` に `authorization` を渡さなかったときの既定。
 *
 * ドメインの判定表をそのまま使う（adapters の `RoleMatrixAuthorization` と同じ挙動）。
 * api層は adapters を import できない（depcruise `api-production-no-adapters-composition`）ため、
 * 認証と同じくここに最小形を置く。**「省略したら素通し」にはしない**。
 */
export function defaultAuthorization(): AuthorizationPort {
  return { authorize: async (principal, action, resource) => decideAuthorization(principal, action, resource) };
}

/** 監査の書き込み先と、認証前イベント（401）に使うスコープ。 */
export interface AuditOptions {
  readonly sink: AuditSink;
  /**
   * 認証に失敗したリクエストを記録するときのスコープ。
   *
   * 誰か分からない以上テナントも分からないので、サーバーが構成されている既定スコープへ寄せる
   * （運用者が自分のワークスペースの監査画面で「弾かれた試行」を見られるようにするため）。
   */
  readonly fallbackScope: TenantScope;
}

/** 認可フックの依存。 */
export interface AuthorizationOptions {
  readonly authorization: AuthorizationPort;
  readonly audit?: AuditOptions;
  /** 記録時刻（テストで固定する）。 */
  readonly now?: () => Date;
}

/**
 * 主体不明の401を、同一送信元・同一分あたり何件まで台帳へ書くか。
 *
 * 401は**資格情報を持たない相手**でも好きなだけ発生させられる。1件1行で書くと、
 * 認証を通れない相手がリモートからディスクを埋められる（レート制限で回数は抑えるが、
 * 上限そのものは通常操作を壊さない高さなので、それだけでは書き込み量を絞れない）。
 * 「弾いた事実」は数行あれば伝わり、規模は集約行の件数で伝わるので、束ねて書く。
 */
export const MAX_UNAUTHENTICATED_AUDIT_PER_WINDOW = 5;
/** 集約の窓（1分）。 */
export const UNAUTHENTICATED_AUDIT_WINDOW_MS = 60_000;
/** 集約カウンタの上限。多数の送信元から叩かれてもメモリを食わせない。 */
export const MAX_UNAUTHENTICATED_AUDIT_KEYS = 10_000;

interface FailureWindow { window: number; written: number; suppressed: number }

/**
 * 主体不明の401を送信元ごと・分ごとに束ねる集約器。
 *
 * `record` は「この1件を書くか」を返し、窓が変わった時点で前の窓の抑制件数を
 * 集約行として吐き出す（`summary`）。抑制した件数を捨てないので、
 * 「静かになった」のか「束ねられた」のかを台帳から区別できる。
 */
export class UnauthenticatedAuditThrottle {
  private readonly windows = new Map<string, FailureWindow>();

  constructor(
    private readonly max: number = MAX_UNAUTHENTICATED_AUDIT_PER_WINDOW,
    private readonly windowMs: number = UNAUTHENTICATED_AUDIT_WINDOW_MS,
  ) {}

  /**
   * 1件ぶん数える。`write` が true ならそのまま記録してよい。
   * `summary` が付いていれば、直前の窓で抑制した件数を1行として併せて記録する。
   */
  record(key: string, at: number): { readonly write: boolean; readonly summary?: { readonly suppressed: number } } {
    const window = Math.floor(at / this.windowMs);
    const current = this.windows.get(key);
    if (current === undefined || current.window !== window) {
      this.sweep(window);
      this.windows.set(key, { window, written: 1, suppressed: 0 });
      const suppressed = current?.suppressed ?? 0;
      return suppressed > 0 ? { write: true, summary: { suppressed } } : { write: true };
    }
    if (current.written < this.max) {
      current.written += 1;
      return { write: true };
    }
    current.suppressed += 1;
    return { write: false };
  }

  /** 古い窓を捨てる。上限に達していたら古い順に捨てる（抑制件数の報告よりメモリを優先する）。 */
  private sweep(window: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.window < window) this.windows.delete(key);
    }
    if (this.windows.size < MAX_UNAUTHENTICATED_AUDIT_KEYS) return;
    const excess = this.windows.size - MAX_UNAUTHENTICATED_AUDIT_KEYS + 1;
    for (const key of [...this.windows.keys()].slice(0, excess)) this.windows.delete(key);
  }

  /** 保持している送信元数（テスト・診断用）。 */
  get size(): number { return this.windows.size; }
}

/**
 * ハンドラから追加の認可判定を行う（本文の中身で必要な権限が変わるルート用）。
 *
 * 拒否は `ForbiddenError`（403）。フックを通っていないリクエストで呼ぶのは配線ミスなので、
 * 素通しにせず拒否する。
 */
export function authorizeOf(request: FastifyRequest): (action: AuthorizationAction, resource?: AuthorizationResource) => Promise<void> {
  const authorize = request.authorizeAction;
  if (authorize === undefined) {
    return async (action) => { throw new ForbiddenError(`this operation requires the '${action}' permission`); };
  }
  return authorize;
}

/** 監査エントリへ足す補足（秘密値はドメイン側で落とされる）。 */
export function recordAuditDetail(request: FastifyRequest, detail: Readonly<Record<string, AuditDetailValue>>): void {
  request.auditDetail = { ...(request.auditDetail ?? {}), ...detail };
}

function outcomeOfStatus(status: number): AuditOutcome {
  return status >= 400 ? 'failed' : 'succeeded';
}

/**
 * 認可フックと監査フックを登録する。**認証フックより後**に呼ぶこと
 * （Fastify のフックは登録順に走るので、`request.principal` が載ってから判定できる）。
 */
export function registerAuthorization(app: FastifyInstance, options: AuthorizationOptions): void {
  const { authorization } = options;
  const audit = options.audit;
  const now = options.now ?? (() => new Date());
  const throttle = new UnauthenticatedAuditThrottle();

  /**
   * ルート登録の時点で「表に載っているか」を記録する。
   *
   * HEAD / OPTIONS は Fastify が GET から自動生成するので数えない。
   * `AUTHORIZATION_EXEMPT_PATHS` と、APIが所有しないパス（ビルド済みUI）も対象外。
   */
  const unmapped: string[] = [];
  const authorized: string[] = [];
  app.decorate('unmappedAuthorizationRoutes', unmapped);
  app.decorate('authorizedRoutes', authorized);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      if (AUTHORIZATION_EXEMPT_PATHS.has(route.url)) continue;
      authorized.push(`${method} ${route.url}`);
      if (explicitRouteAuthorization(method, route.url) === undefined) unmapped.push(`${method} ${route.url}`);
    }
  });

  /** 監査の書き込みは失敗しても本処理を止めない（台帳が満杯でも操作は続けられるべき）。 */
  const write = async (entry: Parameters<AuditSink['record']>[0]): Promise<void> => {
    if (audit === undefined) return;
    try { await audit.sink.record(entry); }
    catch (error) { app.log.warn({ err: error }, 'failed to write an audit entry'); }
  };

  app.addHook('onRequest', async (request, reply) => {
    const principal = request.principal;
    // 公開パス（認証を通っていない）はここでは何もしない。401 は認証フックが既に返している。
    if (principal === undefined) return;
    const routeUrl = request.routeOptions?.url;
    // ルートが解決できない＝404。存在しない経路の認可を問う意味はない。
    if (routeUrl === undefined) return;
    if (AUTHORIZATION_EXEMPT_PATHS.has(pathOf(request.url))) return;

    const required = routeAuthorizationFor(request.method, routeUrl);
    const resource = resourceOf(request, required.kind);
    request.routeAuthorization = required;
    request.authorizeAction = async (action, target) => {
      const decision = await authorization.authorize(principal, action, target ?? resource).catch(() => ({ kind: 'deny' as const, reason: `this operation requires the '${action}' permission` }));
      if (decision.kind === 'allow') return;
      await write(createAuditEntry({
        at: now().toISOString(), subject: principal.subject, scope: principalScope(principal),
        action, resource: target ?? resource, outcome: 'denied',
        detail: { method: request.method, route: routeUrl, reason: decision.reason },
      }));
      throw new ForbiddenError(decision.reason);
    };

    // 認可プロバイダーが例外を投げた場合も拒否（§3.1 フェイルセーフ）。
    const decision = await authorization.authorize(principal, required.action, resource)
      .catch(() => ({ kind: 'deny' as const, reason: `this operation requires the '${required.kind}:${required.action}' permission` }));
    if (decision.kind === 'allow') return;

    await write(createAuditEntry({
      at: now().toISOString(), subject: principal.subject, scope: principalScope(principal),
      action: required.action, resource, outcome: 'denied',
      detail: { method: request.method, route: routeUrl, reason: decision.reason },
    }));
    void reply.status(403).send({ error: { code: 'FORBIDDEN', message: decision.reason } });
  });

  app.addHook('onResponse', async (request, reply) => {
    if (audit === undefined) return;
    const principal = request.principal;
    const routeUrl = request.routeOptions?.url;

    /**
     * 認証に失敗した試行。誰かは分からないが「弾かれた」ことは残す価値がある。
     *
     * ただし**送信元ごと・分ごとに上限を設ける**。ここは資格情報を持たない相手が
     * 何度でも到達できる位置なので、1件1行で書くと台帳が書き込み増幅装置になる。
     */
    if (principal === undefined) {
      if (reply.statusCode !== 401 || routeUrl === undefined) return;
      const at = now();
      const decision = throttle.record(request.ip, at.getTime());
      const entry = (detail: Record<string, AuditDetailValue>): Parameters<AuditSink['record']>[0] => createAuditEntry({
        at: at.toISOString(), subject: UNAUTHENTICATED_SUBJECT, scope: audit.fallbackScope,
        action: 'read', resource: { kind: 'workspace' }, outcome: 'denied', detail,
      });
      if (decision.summary !== undefined) {
        // 直前の窓で書かなかった分。件数だけを残す（経路は既に上限まで記録済み）。
        await write(entry({ reason: 'authentication failed', suppressed: decision.summary.suppressed }));
      }
      if (!decision.write) return;
      await write(entry({ method: request.method, route: routeUrl, status: reply.statusCode, reason: 'authentication failed' }));
      return;
    }

    const required = request.routeAuthorization;
    if (required === undefined || required.audit !== true) return;
    // 403 は onRequest 側で既に1件書いている（同じ拒否を二重に残さない）。
    if (reply.statusCode === 403) return;

    await write(createAuditEntry({
      at: now().toISOString(), subject: principal.subject, scope: principalScope(principal),
      action: required.action, resource: resourceOf(request, required.kind), outcome: outcomeOfStatus(reply.statusCode),
      detail: { method: request.method, route: routeUrl ?? request.url, status: reply.statusCode, ...(request.auditDetail ?? {}) },
    }));
  });
}
