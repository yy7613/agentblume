/**
 * application層: 保存済みMCPサーバーへの接続テスト。
 *
 * 「設定が正しいか」をUIから確かめるための機能なので、**接続失敗は例外にせず結果として返す**
 * （エラー表示はUIの通常フローであり、HTTPエラーではない）。設定が見つからない場合だけ
 * McpNotFoundError を投げる（404）。disabled なサーバーもテストは実行できる
 * （無効化したまま設定を直して検証できるようにするため）。
 */
import type { TenantScope } from '../../domain/tool/ids';
import { McpNotFoundError } from '../../domain/mcp/errors';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import type { McpClientPort } from './mcp-client';

export interface McpServerTestTool {
  readonly name: string;
  readonly description?: string;
}

export interface McpServerTestResult {
  readonly ok: boolean;
  readonly tools?: readonly McpServerTestTool[];
  readonly error?: string;
}

export class TestMcpServerUseCase {
  constructor(private readonly repo: McpServerRepository, private readonly client: McpClientPort) {}

  async execute(scope: TenantScope, name: string, signal?: AbortSignal): Promise<McpServerTestResult> {
    const config = await this.repo.find(scope, name);
    if (config === null) throw new McpNotFoundError(`MCP server not found: ${name}`);
    try {
      const tools = await this.client.listTools(config, signal);
      return { ok: true, tools: tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) })) };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
