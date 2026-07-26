/**
 * api層: ドメインエラー → HTTP ステータス/ボディ変換（v4 実装契約 §2）
 *
 * instanceof 判定は具象クラス優先の順序で行う
 * （ToolNotFoundError / VersionConflictError は ToolError 派生の独立クラスだが、
 * 基底 ToolError を継承する ToolValidationError より先に判定して意図を明示する）。
 * 未知の例外は 500 とし、message は 'internal error' 固定（詳細を漏らさない）。
 */
import { GraphError, ConfigError, SchemaError } from '../domain/etl/errors';
import {
  ToolNotFoundError,
  ToolValidationError,
  VersionConflictError,
} from '../domain/tool/errors';
import { AgentRunError, ToolArgumentsError, UnsafeToolError } from '../application/agent/errors';
import { ModelProviderError } from '../application/model/model-provider';
import { RunFailedError } from '../application/agent/errors';
import { RunNotFoundError } from '../domain/run/errors';
import { AgentNotFoundError, AgentValidationError, AgentVersionConflictError } from '../domain/agent/errors';
import { SkillNotFoundError, SkillValidationError, SkillVersionConflictError } from '../domain/skill/errors';
import { PersonaNotFoundError, ScenarioNotFoundError, ScenarioRunNotFoundError, ValidationDomainError } from '../domain/validation/errors';
import { EvaluationAssetVersionConflictError, EvaluationDatasetNotFoundError, EvaluationDomainError, EvaluatorProfileNotFoundError, ExperimentConflictError, ExperimentNotFoundError, JudgeEvaluationError, JudgeRubricNotFoundError, QualityGateConflictError, QualityGateNotFoundError } from '../domain/evaluation/errors';
import { MemoryDomainError, MemoryProposalNotFoundError, WikiPageNotFoundError, WikiSpaceNotFoundError } from '../domain/memory/errors';
import { FeedbackValidationError } from '../domain/operations/errors';
import { AgentSessionClosedError, AgentSessionExpiredError, AgentSessionNotFoundError, SessionArtifactNotFoundError, SessionDomainError, SessionQuotaExceededError } from '../domain/session/errors';
import { DataSourceValidationError } from '../application/data-source/manage-data-sources';
import { InvalidFileContentError } from '../domain/data-source/errors';
import { WebSearchValidationError } from '../application/search/web-search';
import { HarnessNotFoundError, HarnessRunError, HarnessRunNotFoundError, HarnessValidationError, HarnessVersionConflictError } from '../domain/harness/errors';
import { FactoryNotFoundError, FactoryValidationError } from '../domain/factory/errors';
import { McpNotFoundError, McpValidationError } from '../domain/mcp/errors';
import { McpClientError } from '../application/mcp/mcp-client';

/** HTTP エラーレスポンス表現。 */
export interface HttpError {
  readonly status: number;
  readonly body: { error: { code: string; message: string; runId?: string } };
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
 * | RunFailedError | 元例外のstatus/code + runId |
 * | その他 | 500 | INTERNAL（message 'internal error' 固定） |
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof RunFailedError) {
    const mapped = toHttpError(err.cause);
    return { status: mapped.status, body: { error: { ...mapped.body.error, runId: err.runId } } };
  }
  if (err instanceof BadRequestError) return httpError(400, err.code, err.message);

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
  if (err instanceof EvaluationDomainError) return httpError(400, err.code, err.message);

  // 記憶ドメイン: NotFound系は404、不変条件違反（入力不正・不正な状態遷移）は400。
  if (err instanceof WikiPageNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof WikiSpaceNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof MemoryProposalNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof MemoryDomainError) return httpError(400, err.code, err.message);
  if (err instanceof FeedbackValidationError) return httpError(422, err.code, err.message);
  if (err instanceof AgentSessionNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof SessionArtifactNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof AgentSessionClosedError) return httpError(409, err.code, err.message);
  if (err instanceof AgentSessionExpiredError) return httpError(410, err.code, err.message);
  if (err instanceof SessionQuotaExceededError) return httpError(413, err.code, err.message);
  if (err instanceof SessionDomainError) return httpError(400, err.code, err.message);
  if (err instanceof DataSourceValidationError) return httpError(400, err.code, err.message);
  if (err instanceof InvalidFileContentError) return httpError(400, err.code, err.message);

  // Agent Factory ドメイン（v33）: NotFoundは404、その他の不変条件違反は400。
  if (err instanceof FactoryNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof FactoryValidationError) return httpError(400, err.code, err.message);

  // MCPクライアント: 設定の不変条件違反は400、未登録サーバーは404。
  // 接続失敗（McpClientError）は外部依存の失敗なので ModelProviderError と同じ502。
  // ただし接続テストは ok:false として200で返るため、502に至るのは実行経路のみ。
  if (err instanceof McpNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof McpValidationError) return httpError(400, err.code, err.message);
  if (err instanceof McpClientError) return httpError(502, err.code, err.message);

  if (err instanceof UnsafeToolError) return httpError(403, err.code, err.message);
  if (err instanceof ToolArgumentsError) return httpError(422, err.code, err.message);
  if (err instanceof AgentRunError) return httpError(422, err.code, err.message);
  if (err instanceof ModelProviderError) return httpError(502, err.code, err.message);

  // ETL ドメイン: いずれも 422。
  if (err instanceof GraphError) return httpError(422, err.code, err.message);
  if (err instanceof ConfigError) return httpError(422, err.code, err.message);
  if (err instanceof SchemaError) return httpError(422, err.code, err.message);

  // 未知の例外は詳細を漏らさない。
  return httpError(500, 'INTERNAL', 'internal error');
}
