/**
 * ドメイン: Tool コンテキストのエラー型（v2 実装契約 §3）
 *
 * Tool ドメイン内の例外は全てここで定義した型を投げる。
 * `throw new Error()` の直接使用は禁止。
 */

/** Tool ドメインの基底エラー。`code` で機械判別する。 */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** 不正メタ / 不正 SemVer / グラフ検証失敗。code は 'TOOL_VALIDATION'。 */
export class ToolValidationError extends ToolError {
  constructor(message: string) {
    super('TOOL_VALIDATION', message);
    this.name = 'ToolValidationError';
  }
}

/** 指定 Tool（バージョン）が存在しない。code は 'TOOL_NOT_FOUND'。 */
export class ToolNotFoundError extends ToolError {
  constructor(message: string) {
    super('TOOL_NOT_FOUND', message);
    this.name = 'ToolNotFoundError';
  }
}

/** 既存バージョンへの再保存。code は 'TOOL_VERSION_CONFLICT'。 */
export class VersionConflictError extends ToolError {
  constructor(message: string) {
    super('TOOL_VERSION_CONFLICT', message);
    this.name = 'VersionConflictError';
  }
}
