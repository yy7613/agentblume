/**
 * application層: 外部MCPサーバーへのクライアントPort。
 *
 * 実装（SDK・接続プール・トランスポート）はadapters層の責務。application/domainは
 * 「設定を渡すとツール一覧が得られ、ツールを呼べる」ことだけを知る。
 */
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { JsonObject } from '../model/model-provider';

/** MCPサーバーが公開するツール1件。inputSchema は JSON Schema（object）。 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

/**
 * ツール呼び出し結果。
 * content はMCPのcontentブロックを平坦化したテキスト、isError はサーバーが返した実行エラー標識。
 * 「呼び出しに失敗した（接続断など）」場合は例外（McpClientError）であり、この型では表さない。
 */
export interface McpToolCallResult {
  readonly content: string;
  readonly isError: boolean;
}

/**
 * MCP接続の失敗。api で 502（外部依存の失敗）。
 *
 * メッセージにはサーバー名と失敗した操作を含めるが、**認証情報（env / headers の値）は
 * 決して含めない**（実装側で原因メッセージから値を伏せ字化する）。
 */
export class McpClientError extends Error {
  readonly code = 'MCP_CLIENT';
  constructor(message: string) {
    super(message);
    this.name = 'McpClientError';
  }
}

export interface McpClientPort {
  listTools(config: McpServerConfig, signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(config: McpServerConfig, toolName: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolCallResult>;
  /** プール済み接続をすべて閉じる（サーバーshutdown用）。 */
  close(): Promise<void>;
}
