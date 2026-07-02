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

/** HTTP エラーレスポンス表現。 */
export interface HttpError {
  readonly status: number;
  readonly body: { error: { code: string; message: string } };
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
 * | その他 | 500 | INTERNAL（message 'internal error' 固定） |
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof BadRequestError) return httpError(400, err.code, err.message);

  // Tool ドメイン: 具象クラスを ToolValidationError より先に判定する。
  if (err instanceof ToolNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof VersionConflictError) return httpError(409, err.code, err.message);
  if (err instanceof ToolValidationError) return httpError(400, err.code, err.message);

  // ETL ドメイン: いずれも 422。
  if (err instanceof GraphError) return httpError(422, err.code, err.message);
  if (err instanceof ConfigError) return httpError(422, err.code, err.message);
  if (err instanceof SchemaError) return httpError(422, err.code, err.message);

  // 未知の例外は詳細を漏らさない。
  return httpError(500, 'INTERNAL', 'internal error');
}
