/**
 * api層: ドメインエラー → HTTP ステータス/ボディ変換（v4 実装契約 §2）
 *
 * instanceof 判定は具象クラス優先の順序で行う
 * （ToolNotFoundError / VersionConflictError は ToolError 派生の独立クラスだが、
 * 基底 ToolError を継承する ToolValidationError より先に判定して意図を明示する）。
 * 未知の例外は 500 とし、message は 'internal error' 固定（詳細を漏らさない）。
 */
import { UnauthenticatedError } from './authentication';
import { ForbiddenError } from './authorization';
import { GraphError, ConfigError, SchemaError } from '../domain/etl/errors';
import {
  ToolNotFoundError,
  ToolValidationError,
  VersionConflictError,
} from '../domain/tool/errors';
import { AgentRunError, ToolArgumentsError, ToolExecutionError, UnsafeToolError } from '../application/agent/errors';
import type { RunFailureToolRef } from '../domain/run/run';
import { ModelProviderError } from '../application/model/model-provider';
import { RunFailedError } from '../application/agent/errors';
import { RunNotFoundError } from '../domain/run/errors';
import { AgentNotFoundError, AgentValidationError, AgentVersionConflictError } from '../domain/agent/errors';
import { SkillNotFoundError, SkillValidationError, SkillVersionConflictError } from '../domain/skill/errors';
import { PersonaNotFoundError, ScenarioNotFoundError, ScenarioRunNotFoundError, ValidationDomainError } from '../domain/validation/errors';
import { EvaluationAssetVersionConflictError, EvaluationDatasetNotFoundError, EvaluationDomainError, EvaluatorProfileNotFoundError, ExperimentConflictError, ExperimentNotFoundError, JudgeEvaluationError, JudgeModelNotConfiguredError, JudgeRubricNotFoundError, JudgeTraceUnavailableError, QualityGateConflictError, QualityGateNotFoundError } from '../domain/evaluation/errors';
import { MemoryDomainError, MemoryProposalNotFoundError, WikiPageNotFoundError, WikiSpaceNotFoundError } from '../domain/memory/errors';
import { BackupNotFoundError, BackupValidationError, FeedbackValidationError } from '../domain/operations/errors';
import { AgentSessionClosedError, AgentSessionExpiredError, AgentSessionNotFoundError, SessionArtifactNotFoundError, SessionDomainError, SessionQuotaExceededError } from '../domain/session/errors';
import { DataSourceValidationError } from '../application/data-source/manage-data-sources';
import { DataSourceDomainError, InvalidFileContentError } from '../domain/data-source/errors';
import { WebSearchValidationError } from '../application/search/web-search';
import { HarnessNotFoundError, HarnessRunError, HarnessRunNotFoundError, HarnessValidationError, HarnessVersionConflictError } from '../domain/harness/errors';
import { FactoryNotFoundError, FactoryValidationError } from '../domain/factory/errors';
import { McpNotFoundError, McpValidationError } from '../domain/mcp/errors';
import { McpClientError } from '../application/mcp/mcp-client';
import { ModelSettingsValidationError } from '../domain/model-settings/errors';
import { SecretCipherError } from '../application/model-settings/secret-cipher';
import { ModelCatalogError } from '../application/model-settings/model-catalog';
import { SharedValidationError } from '../domain/shared/errors';
import { ToolCheckNotFoundError, ToolCheckValidationError } from '../domain/tool-check/errors';

/**
 * HTTP エラーレスポンス表現。
 * `tool` / `nodeId` はツール実行由来の失敗（ToolExecutionError）だけが持ち、
 * 利用者がどのToolのどのノードを直せばよいかをUIが示すために使う。
 * `rubric` は judge の tracePolicy と事例種別の矛盾（JudgeTraceUnavailableError）だけが持ち、
 * どのルーブリックを直せばよいかを UI が示すために使う。
 */
export interface HttpError {
  readonly status: number;
  readonly body: { error: { code: string; message: string; runId?: string; tool?: RunFailureToolRef; nodeId?: string; rubric?: { id: string; version: string } } };
}

/**
 * api層ローカルの 400 用エラー（Zod 検証失敗・不正 version 文字列など）。
 * code は 'BAD_REQUEST' 固定。
 */
export class BadRequestError extends Error {
  readonly code = 'BAD_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** status と例外から HttpError を組み立てる（code は例外の code プロパティ）。 */
function httpError(status: number, code: string, message: string): HttpError {
  return { status, body: { error: { code, message } } };
}

/**
 * 例外を HTTP エラーへ変換する（§2 マッピング表）。
 *
 * | 例外 | status | code |
 * |---|---|---|
 * | ToolNotFoundError | 404 | TOOL_NOT_FOUND |
 * | VersionConflictError | 409 | TOOL_VERSION_CONFLICT |
 * | ToolValidationError | 400 | TOOL_VALIDATION |
 * | GraphError | 422 | ETL_GRAPH |
 * | ConfigError | 422 | ETL_CONFIG |
 * | SchemaError | 422 | ETL_SCHEMA |
 * | BadRequestError | 400 | BAD_REQUEST |
 * | InvalidFileContentError | 400 | INVALID_FILE_CONTENT |
 * | UnsafeToolError | 403 | UNSAFE_TOOL |
 * | ToolArgumentsError / AgentRunError | 422 | TOOL_ARGUMENTS / AGENT_RUN |
 * | ModelProviderError | 502 | MODEL_PROVIDER |
 * | RunNotFoundError | 404 | RUN_NOT_FOUND |
 * | JudgeModelNotConfiguredError | 409 | JUDGE_MODEL_NOT_CONFIGURED |
 * | JudgeTraceUnavailableError | 409 | JUDGE_TRACE_UNAVAILABLE + rubric |
 * | RunFailedError | 元例外のstatus/code + runId |
 * | ToolExecutionError | 元例外のstatus/code + tool（+ nodeId） |
 * | その他 | 500 | INTERNAL（message 'internal error' 固定） |
 */
/**
 * Fastify 自身が投げる 4xx（不正な JSON 本文 `FST_ERR_CTP_INVALID_JSON_BODY`、空本文 `FST_ERR_CTP_EMPTY_JSON_BODY`、
 * 本文サイズ超過 `FST_ERR_CTP_BODY_TOO_LARGE`、未対応 content-type など）。
 * カスタムの errorHandler を置くと Fastify 既定の写像が消え、これらが 500 'internal error' に化けていた
 * （利用者は「送った JSON が壊れている」ことを知る手段が無かった）。code は FST_ 接頭辞、statusCode は数値で判別する。
 * 5xx の FST_ エラーは Fastify 内部の失敗なので、従来どおり 500 に落として詳細を漏らさない。
 */
function isFastifyClientError(err: unknown): err is Error & { readonly code: string; readonly statusCode: number } {
  if (!(err instanceof Error)) return false;
  const { code, statusCode } = err as { code?: unknown; statusCode?: unknown };
  return typeof code === 'string' && code.startsWith('FST_') && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

export function toHttpError(err: unknown): HttpError {
  if (isFastifyClientError(err)) return httpError(err.statusCode, err.code, err.message);
  if (err instanceof RunFailedError) {
    const mapped = toHttpError(err.cause);
    return { status: mapped.status, body: { error: { ...mapped.body.error, runId: err.runId } } };
  }
  // ツール実行の失敗は元例外のstatus/codeを保ったまま、どのTool・どのノードで起きたかを足す
  // （RunFailedError(ToolExecutionError(cause)) なら runId + tool + nodeId が揃う）。
  if (err instanceof ToolExecutionError) {
    const mapped = toHttpError(err.cause);
    return { status: mapped.status, body: { error: { ...mapped.body.error, tool: err.tool, ...(err.nodeId === undefined ? {} : { nodeId: err.nodeId }) } } };
  }
  if (err instanceof BadRequestError) return httpError(400, err.code, err.message);
  // 認証フックを通っていないのにスコープを要求した（＝公開パスの設定ミス）。
  if (err instanceof UnauthenticatedError) return httpError(401, err.code, err.message);
  // 認可で拒否した。メッセージは「必要な権限」だけで、持っているロールも他人の情報も出さない。
  if (err instanceof ForbiddenError) return httpError(403, err.code, err.message);

  // Tool ドメイン: 具象クラスを ToolValidationError より先に判定する。
  if (err instanceof ToolNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof VersionConflictError) return httpError(409, err.code, err.message);
  if (err instanceof ToolValidationError) return httpError(400, err.code, err.message);
  if (err instanceof WebSearchValidationError) return httpError(400, err.code, err.message);
  if (err instanceof RunNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof AgentNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof AgentVersionConflictError) return httpError(409, err.code, err.message);
  if (err instanceof AgentValidationError) return httpError(400, err.code, err.message);
  if (err instanceof HarnessNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof HarnessRunNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof HarnessVersionConflictError) return httpError(409, err.code, err.message);
  if (err instanceof HarnessValidationError) return httpError(400, err.code, err.message);
  if (err instanceof HarnessRunError) return httpError(422, err.code, err.message);
  if (err instanceof SkillNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof SkillVersionConflictError) return httpError(409, err.code, err.message);
  if (err instanceof SkillValidationError) return httpError(400, err.code, err.message);

  // 検証（シナリオ検証）ドメイン: NotFound系は404、その他の不変条件違反は400。
  if (err instanceof PersonaNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof ScenarioNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof ScenarioRunNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof ValidationDomainError) return httpError(400, err.code, err.message);

  // 評価ドメイン: 入力不正など不変条件違反は 400。
  if (err instanceof EvaluationDatasetNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof EvaluatorProfileNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof EvaluationAssetVersionConflictError) return httpError(409, err.code, err.message);
  if (err instanceof ExperimentNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof ExperimentConflictError) return httpError(409, err.code, err.message);
  if (err instanceof QualityGateNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof QualityGateConflictError) return httpError(409, err.code, err.message);
  if (err instanceof JudgeRubricNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof JudgeEvaluationError) return httpError(422, err.code, err.message);
  // 起票時の judge ガード: どちらも利用者の設定変更で直せるので 409。trace の方はどのルーブリックを直すかを本文へ載せる。
  if (err instanceof JudgeModelNotConfiguredError) return httpError(409, err.code, err.message);
  if (err instanceof JudgeTraceUnavailableError) return { status: 409, body: { error: { code: err.code, message: err.message, rubric: { ...err.rubric } } } };
  if (err instanceof EvaluationDomainError) return httpError(400, err.code, err.message);

  // 記憶ドメイン: NotFound系は404、不変条件違反（入力不正・不正な状態遷移）は400。
  if (err instanceof WikiPageNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof WikiSpaceNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof MemoryProposalNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof MemoryDomainError) return httpError(400, err.code, err.message);
  if (err instanceof FeedbackValidationError) return httpError(422, err.code, err.message);
  // バックアップ: 前提が満たされていない（揮発DB・壊れたバックアップ・スキーマが新しすぎる）は
  // すべて利用者の操作で直せるので400。存在しないバックアップ名は404。
  if (err instanceof BackupNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof BackupValidationError) return httpError(400, err.code, err.message);
  if (err instanceof AgentSessionNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof SessionArtifactNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof AgentSessionClosedError) return httpError(409, err.code, err.message);
  if (err instanceof AgentSessionExpiredError) return httpError(410, err.code, err.message);
  if (err instanceof SessionQuotaExceededError) return httpError(413, err.code, err.message);
  if (err instanceof SessionDomainError) return httpError(400, err.code, err.message);
  if (err instanceof DataSourceValidationError) return httpError(400, err.code, err.message);
  if (err instanceof InvalidFileContentError) return httpError(400, err.code, err.message);
  // データソースドメイン: 保存済みレコードの構造不正などの不変条件違反は 400。
  if (err instanceof DataSourceDomainError) return httpError(400, err.code, err.message);

  // Agent Factory ドメイン（v33）: NotFoundは404、その他の不変条件違反は400。
  if (err instanceof FactoryNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof FactoryValidationError) return httpError(400, err.code, err.message);

  // ツール検証: 未知のケースは404、ケース定義の不変条件違反は400（実行自体の失敗は結果として200で返る）。
  if (err instanceof ToolCheckNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof ToolCheckValidationError) return httpError(400, err.code, err.message);

  // MCPクライアント: 設定の不変条件違反は400、未登録サーバーは404。
  // 接続失敗（McpClientError）は外部依存の失敗なので ModelProviderError と同じ502。
  // ただし接続テストは ok:false として200で返るため、502に至るのは実行経路のみ。
  if (err instanceof McpNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof McpValidationError) return httpError(400, err.code, err.message);
  if (err instanceof McpClientError) return httpError(502, err.code, err.message);

  // モデル設定（v34）: 入力不正は400。復号失敗は「保存し直しが必要」な状態なので409
  // （メッセージに秘密値は含まれない）。鍵ファイル自体が読めない場合は再入力しても直らない
  // 運用上の障害なので 500 にする。モデル一覧の取得失敗は外部依存の失敗なので502。
  if (err instanceof ModelSettingsValidationError) return httpError(400, err.code, err.message);
  if (err instanceof SecretCipherError) return httpError(err.reason === 'key-unavailable' ? 500 : 409, err.code, err.message);
  if (err instanceof ModelCatalogError) return httpError(502, err.code, err.message);

  if (err instanceof UnsafeToolError) return httpError(403, err.code, err.message);
  if (err instanceof ToolArgumentsError) return httpError(422, err.code, err.message);
  if (err instanceof AgentRunError) return httpError(422, err.code, err.message);
  if (err instanceof ModelProviderError) return httpError(502, err.code, err.message);

  // ETL ドメイン: いずれも 422。engine が付けた nodeId（どのノードで落ちたか）は、下書きプレビューの
  // ように Run を経由しない経路でも UI が「そのノードを開いて直す」導線に使うので本文へ載せる。
  if (err instanceof GraphError || err instanceof ConfigError || err instanceof SchemaError) {
    const mapped = httpError(422, err.code, err.message);
    return err.nodeId === undefined ? mapped : { ...mapped, body: { error: { ...mapped.body.error, nodeId: err.nodeId } } };
  }

  // domain/shared の検証ヘルパー既定エラー（ADR-0035）。BC は通常 fail 注入で自 BC の
  // エラー型を投げるため本来ここへは来ないが、注入漏れで検証エラーが 500/'internal error'
  // に化けて詳細が失われるのを防ぐ安全網として 400 に写す。
  if (err instanceof SharedValidationError) return httpError(400, err.code, err.message);

  // 未知の例外は詳細を漏らさない。
  return httpError(500, 'INTERNAL', 'internal error');
}
