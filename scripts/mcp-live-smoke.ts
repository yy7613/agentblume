/**
 * MCPクライアントの実地スモークテスト。実在のMCPサーバーへ接続してツール一覧と
 * 任意の1ツール呼び出しを確認する開発用ユーティリティ（自動テストには含めない）。
 *
 * 使い方: npx tsx scripts/mcp-live-smoke.ts [url] [toolName] [argsJson]
 * 例:     npx tsx scripts/mcp-live-smoke.ts https://learn.microsoft.com/api/mcp microsoft_docs_search {"question":"..."}
 */
import { SdkMcpClient } from '../src/adapters/mcp/sdk-mcp-client';
import { createMcpServerConfig } from '../src/domain/mcp/mcp-server';

const url = process.argv[2] ?? 'https://learn.microsoft.com/api/mcp';
const toolName = process.argv[3];
const argsJson = process.argv[4];

const config = createMcpServerConfig({
  scope: { tenantId: 'local', workspaceId: 'default' },
  name: 'live-smoke',
  transport: { kind: 'http', url, headers: {} },
  updatedAt: new Date().toISOString(),
});

const client = new SdkMcpClient();
try {
  const started = Date.now();
  const tools = await client.listTools(config);
  console.log(`listTools: ${tools.length} tools in ${Date.now() - started}ms from ${url}`);
  for (const tool of tools) {
    console.log(`- ${tool.name}: ${(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  if (toolName !== undefined) {
    const args = argsJson !== undefined ? JSON.parse(argsJson) as Record<string, unknown> : {};
    const callStarted = Date.now();
    const result = await client.callTool(config, toolName, args);
    console.log(`\ncallTool ${toolName}: isError=${result.isError}, ${result.content.length} chars in ${Date.now() - callStarted}ms`);
    console.log(result.content.slice(0, 1500));
  }
} finally {
  await client.close();
}
