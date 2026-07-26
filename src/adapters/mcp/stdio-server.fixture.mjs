// 実プロセス起動のsmokeテスト専用の最小MCPサーバー（stdio）。
// テストからのみ `node stdio-server.fixture.mjs` として起動される。
// .mjs なのでtsc（.tsのみ）の対象外。SDKはリポジトリ直下のnode_modulesから解決される。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' });

server.registerTool(
  'greet',
  { description: 'Greets by name', inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: 'text', text: `hello ${name}` }] }),
);

// 設定の env が子プロセスへ実際に渡っていることを確認するためのツール。
server.registerTool(
  'env-echo',
  { description: 'Echoes the FIXTURE_TOKEN environment variable' },
  async () => ({ content: [{ type: 'text', text: process.env.FIXTURE_TOKEN ?? 'unset' }] }),
);

await server.connect(new StdioServerTransport());
