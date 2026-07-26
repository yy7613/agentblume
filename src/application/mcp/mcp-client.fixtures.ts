/**
 * テスト用の McpClientPort フェイク（実接続なし）。
 *
 * `tools` / `results` は Map なので、テストの途中で応答を差し替えられる
 * （例: 承認待ちの前後でサーバーを到達不能にする）。
 */
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { JsonObject } from '../model/model-provider';
import type { McpClientPort, McpToolCallResult, McpToolDescriptor } from './mcp-client';

export interface FakeMcpToolCall {
  readonly server: string;
  readonly tool: string;
  readonly args: JsonObject;
}

export class FakeMcpClient implements McpClientPort {
  /** listTools を呼ばれたサーバー名（呼ばれた順）。 */
  readonly listed: string[] = [];
  readonly calls: FakeMcpToolCall[] = [];
  /** サーバー名 → ツール一覧、または listTools が投げるエラー。 */
  readonly tools: Map<string, readonly McpToolDescriptor[] | Error>;
  /** `<server>/<tool>` → 呼び出し結果、または callTool が投げるエラー。 */
  readonly results: Map<string, McpToolCallResult | Error>;
  closed = 0;

  constructor(
    tools: Readonly<Record<string, readonly McpToolDescriptor[] | Error>> = {},
    results: Readonly<Record<string, McpToolCallResult | Error>> = {},
  ) {
    this.tools = new Map(Object.entries(tools));
    this.results = new Map(Object.entries(results));
  }

  async listTools(server: McpServerConfig): Promise<readonly McpToolDescriptor[]> {
    this.listed.push(server.name);
    const entry = this.tools.get(server.name);
    if (entry instanceof Error) throw entry;
    return entry ?? [];
  }

  async callTool(server: McpServerConfig, toolName: string, args: JsonObject): Promise<McpToolCallResult> {
    this.calls.push({ server: server.name, tool: toolName, args });
    const entry = this.results.get(`${server.name}/${toolName}`);
    if (entry instanceof Error) throw entry;
    return entry ?? { content: `${toolName} ok`, isError: false };
  }

  async close(): Promise<void> { this.closed += 1; }
}
