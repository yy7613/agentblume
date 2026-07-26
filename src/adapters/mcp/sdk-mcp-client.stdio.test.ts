/**
 * 実プロセス起動のsmokeテスト。InMemoryTransportのユニットテストでは検証できない
 * 「StdioClientTransportで子プロセスを起動し、実際にJSON-RPCで会話できる」ことを1本だけ確かめる。
 * 依存はNode本体とリポジトリ内のfixtureのみで、ネットワークも外部パッケージ取得も伴わない。
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMcpServerConfig } from '../../domain/mcp/mcp-server';
import { SdkMcpClient } from './sdk-mcp-client';

const fixture = fileURLToPath(new URL('./stdio-server.fixture.mjs', import.meta.url));

describe('SdkMcpClient（stdio実プロセス）', () => {
  it('子プロセスのMCPサーバーへ接続してツール一覧・呼び出しができる', async () => {
    const client = new SdkMcpClient();
    const config = createMcpServerConfig({
      scope: { tenantId: 'tenant', workspaceId: 'workspace' },
      name: 'stdio-fixture',
      // process.execPath を使い、PATH上のnode解決に依存しない（Windowsのnpx問題も回避）。
      transport: { kind: 'stdio', command: process.execPath, args: [fixture], env: { FIXTURE_TOKEN: 'from-config' } },
      updatedAt: '2026-07-26T00:00:00.000Z',
    });
    try {
      const tools = await client.listTools(config);
      expect(tools.map((tool) => tool.name).sort()).toEqual(['env-echo', 'greet']);

      expect(await client.callTool(config, 'greet', { name: 'agentblume' })).toEqual({ content: 'hello agentblume', isError: false });

      // 設定の env が子プロセスへ届き、かつ getDefaultEnvironment() のPATH等と共存している。
      expect((await client.callTool(config, 'env-echo', {})).content).toBe('from-config');

      // 2回目の呼び出しは同じ子プロセスを再利用する（起動コストを払い直さない）。
      expect(client.pooledConnections).toBe(1);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('http transport は接続不能なエンドポイントを McpClientError として報告する', async () => {
    const client = new SdkMcpClient({ requestTimeoutMs: 5_000 });
    // ループバックのポート1は待ち受けが無く、即座に接続拒否される（外部ネットワークへは出ない）。
    const config = createMcpServerConfig({
      scope: { tenantId: 'tenant', workspaceId: 'workspace' },
      name: 'unreachable',
      transport: { kind: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer unused-secret-value' } },
      updatedAt: '2026-07-26T00:00:00.000Z',
    });
    try {
      const error = await client.listTools(config).catch((cause: unknown) => cause);
      expect(String(error)).toMatch(/MCP server "unreachable" connect failed/);
      expect(String(error)).not.toContain('unused-secret-value');
      expect(client.pooledConnections).toBe(0);
    } finally {
      await client.close();
    }
  }, 30_000);
});
