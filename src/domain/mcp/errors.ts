/**
 * ドメイン: MCP（Model Context Protocol）クライアント設定のエラー。
 *
 * 接続先サーバーの設定は「保存できる形」であることだけをドメインが保証する。
 * 実際の接続失敗（プロセス起動失敗・HTTPエラー等）はadapter層の McpClientError であり、
 * ここには含めない（ドメインは外部I/Oを知らない）。
 */

/** MCPサーバー設定の不変条件違反（入力不正）。api で 400。 */
export class McpValidationError extends Error {
  readonly code = 'MCP_VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'McpValidationError';
  }
}

/** 指定名のMCPサーバー設定が見つからない。api で 404。 */
export class McpNotFoundError extends Error {
  readonly code = 'MCP_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'McpNotFoundError';
  }
}
