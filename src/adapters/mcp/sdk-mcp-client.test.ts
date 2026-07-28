import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpClientError } from '../../application/mcp/mcp-client';
import { createMcpServerConfig, type McpTransportConfig } from '../../domain/mcp/mcp-server';
import { UNRESTRICTED_MCP_POLICY } from '../../domain/mcp/transport-policy';
import { SdkMcpClient } from './sdk-mcp-client';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const stdio: McpTransportConfig = { kind: 'stdio', command: 'node', args: ['server.js'], env: {} };

function config(overrides: { name?: string; transport?: McpTransportConfig } = {}) {
  return createMcpServerConfig({ scope, name: overrides.name ?? 'fixture', transport: overrides.transport ?? stdio, updatedAt: '2026-07-26T00:00:00.000Z' });
}

/** テスト用のMCPサーバー。InMemoryTransportでクライアントと同一プロセス内で会話する。 */
function buildServer(): McpServer {
  const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echoes the input', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
  server.registerTool('multi', { description: 'Returns mixed content blocks' }, async () => ({
    content: [{ type: 'text', text: 'first' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: 'second' }],
  }));
  server.registerTool('boom', { description: 'Fails' }, async () => ({ content: [{ type: 'text', text: 'tool exploded' }], isError: true }));
  server.registerTool('huge', { description: 'Returns a huge payload' }, async () => ({ content: [{ type: 'text', text: 'x'.repeat(100 * 1024) }] }));
  return server;
}

/**
 * transport生成をfactory注入で差し替える。生成のたびにサーバーを1台立ち上げ、
 * 何度生成されたか（＝再接続が起きたか）を数える。
 */
function transportFactory() {
  const servers: McpServer[] = [];
  let created = 0;
  const create = (): Transport => {
    created += 1;
    const server = buildServer();
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // InMemoryTransport は start() 前のメッセージをキューイングするため、接続の同期待ちは不要。
    void server.connect(serverTransport);
    return clientTransport;
  };
  return { create, servers, get created() { return created; }, close: async () => { await Promise.all(servers.map((server) => server.close())); } };
}

describe('SdkMcpClient', () => {
  const clients: SdkMcpClient[] = [];
  const factories: { close: () => Promise<void> }[] = [];
  function make(options: { idleTtlMs?: number; now?: () => number } = {}) {
    const factory = transportFactory();
    factories.push(factory);
    const client = new SdkMcpClient({ createTransport: factory.create, ...options });
    clients.push(client);
    return { client, factory };
  }
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
  });

  it('listTools がツール記述子（name/description/inputSchema）を返す', async () => {
    const { client } = make();
    const tools = await client.listTools(config());
    expect(tools.map((tool) => tool.name).sort()).toEqual(['boom', 'echo', 'huge', 'multi']);
    const echo = tools.find((tool) => tool.name === 'echo');
    expect(echo?.description).toBe('Echoes the input');
    expect(echo?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
  });

  it('callTool がtextブロックを連結して返す', async () => {
    const { client } = make();
    expect(await client.callTool(config(), 'echo', { text: 'hello' })).toEqual({ content: 'hello', isError: false });
  });

  it('非textブロックはプレースホルダにする', async () => {
    const { client } = make();
    expect((await client.callTool(config(), 'multi', {})).content).toBe('first\n[image]\nsecond');
  });

  it('サーバーが返した isError を反映する（例外にはしない）', async () => {
    const { client } = make();
    expect(await client.callTool(config(), 'boom', {})).toEqual({ content: 'tool exploded', isError: true });
  });

  it('content を64KiBでクリップする', async () => {
    const { client } = make();
    const result = await client.callTool(config(), 'huge', {});
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(64 * 1024 + 32);
    expect(result.content.endsWith('[truncated]')).toBe(true);
  });

  it('同一設定への連続呼び出しは接続を再利用する', async () => {
    const { client, factory } = make();
    await client.listTools(config());
    await client.listTools(config());
    await client.callTool(config(), 'echo', { text: 'x' });
    expect(factory.created).toBe(1);
    expect(client.pooledConnections).toBe(1);
  });

  it('サーバー名が違えば別接続としてプールする', async () => {
    const { client, factory } = make();
    await client.listTools(config({ name: 'first' }));
    await client.listTools(config({ name: 'second' }));
    expect(factory.created).toBe(2);
    expect(client.pooledConnections).toBe(2);
  });

  it('設定が変わったら（ハッシュ不一致）旧接続を捨てて張り直す', async () => {
    const { client, factory } = make();
    await client.listTools(config());
    await client.listTools(config({ transport: { kind: 'stdio', command: 'node', args: ['other.js'], env: {} } }));
    expect(factory.created).toBe(2);
    // 同じ name なのでプールは1本のまま（旧接続は閉じられている）。
    expect(client.pooledConnections).toBe(1);
  });

  it('env の値だけが違う設定でも再接続する（資格情報の差し替えを見落とさない）', async () => {
    const { client, factory } = make();
    const base = { kind: 'stdio' as const, command: 'node', args: [], env: { TOKEN: 'old-token-value' } };
    await client.listTools(config({ transport: base }));
    await client.listTools(config({ transport: { ...base, env: { TOKEN: 'new-token-value' } } }));
    expect(factory.created).toBe(2);
  });

  it('アイドル接続をスイープで閉じる', async () => {
    let clock = 1_000;
    const { client } = make({ idleTtlMs: 60_000, now: () => clock });
    await client.listTools(config());
    expect(client.pooledConnections).toBe(1);

    clock += 30_000;
    await client.sweep();
    expect(client.pooledConnections).toBe(1);

    clock += 60_000;
    await client.sweep();
    expect(client.pooledConnections).toBe(0);
  });

  it('close で全接続を閉じる', async () => {
    const { client } = make();
    await client.listTools(config({ name: 'first' }));
    await client.listTools(config({ name: 'second' }));
    await client.close();
    expect(client.pooledConnections).toBe(0);
  });

  it('接続失敗は McpClientError へ正規化し、プールに残さない', async () => {
    const client = new SdkMcpClient({ createTransport: () => { throw new Error('spawn ENOENT'); } });
    clients.push(client);
    await expect(client.listTools(config({ name: 'broken' }))).rejects.toBeInstanceOf(McpClientError);
    await expect(client.listTools(config({ name: 'broken' }))).rejects.toThrow(/MCP server "broken" connect failed: spawn ENOENT/);
    expect(client.pooledConnections).toBe(0);
  });

  it('接続確立（handshake）の失敗も McpClientError にし、半端な接続を残さない', async () => {
    const client = new SdkMcpClient({
      // トランスポート生成は成功するが start() で失敗する（プロセスは起きたが喋らない状況）。
      createTransport: (): Transport => ({ start: async () => { throw new Error('handshake refused'); }, send: async () => {}, close: async () => {} }),
    });
    clients.push(client);
    await expect(client.listTools(config({ name: 'silent' }))).rejects.toThrow(/MCP server "silent" connect failed: handshake refused/);
    expect(client.pooledConnections).toBe(0);
  });

  it('callTool 中の通信失敗も McpClientError にしてプールから除去する', async () => {
    const factory = transportFactory();
    factories.push(factory);
    const client = new SdkMcpClient({ createTransport: factory.create });
    clients.push(client);
    await client.listTools(config());

    await factory.servers[0]?.close();
    await expect(client.callTool(config(), 'echo', { text: 'x' })).rejects.toThrow(/MCP server "fixture" callTool echo failed/);
    expect(client.pooledConnections).toBe(0);
  });

  it('エラーメッセージに env / headers の値を含めない', async () => {
    const secretEnv = 'super-secret-token';
    const client = new SdkMcpClient({ createTransport: () => { throw new Error(`failed with TOKEN=${secretEnv}`); } });
    clients.push(client);
    await expect(client.listTools(config({ transport: { kind: 'stdio', command: 'node', args: [], env: { TOKEN: secretEnv } } })))
      .rejects.toThrow(/failed with TOKEN=\*\*\*/);

    const secretHeader = 'Bearer very-secret-header';
    const httpClient = new SdkMcpClient({ createTransport: () => { throw new Error(`auth rejected: ${secretHeader}`); } });
    clients.push(httpClient);
    const error = await httpClient.listTools(config({ transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: secretHeader } } })).catch((cause: unknown) => cause);
    expect(String(error)).not.toContain('very-secret-header');
    expect(String(error)).toContain('***');
  });

  it('未知のツール名はMCP仕様どおり例外ではなく isError で返る（接続は維持する）', async () => {
    const { client } = make();
    const result = await client.callTool(config(), 'missing-tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('missing-tool');
    expect(client.pooledConnections).toBe(1);
  });

  describe('接続直前のポリシー検査（保存済みの行にも効く最後の防壁）', () => {
    /** ポリシー導入前に保存された設定を模す。use case を通さずクライアントへ直接渡す。 */
    function forbidden(transport: McpTransportConfig) {
      const factory = transportFactory();
      factories.push(factory);
      const client = new SdkMcpClient({ createTransport: factory.create });
      clients.push(client);
      return { client, factory, config: config({ name: 'legacy', transport }) };
    }

    it('許可外コマンドは接続を試みずに拒否する（プロセスを起こさない）', async () => {
      const { client, factory, config: stored } = forbidden({ kind: 'stdio', command: 'whoami', args: [], env: {} });
      await expect(client.listTools(stored)).rejects.toBeInstanceOf(McpClientError);
      await expect(client.listTools(stored)).rejects.toThrow(/is not allowed to start/);
      expect(factory.created).toBe(0);
      expect(client.pooledConnections).toBe(0);
    });

    it('cmd /c の中身が許可外でも拒否する', async () => {
      const { client, factory, config: stored } = forbidden({ kind: 'stdio', command: 'cmd', args: ['/c', 'calc.exe'], env: {} });
      await expect(client.listTools(stored)).rejects.toThrow(/is not allowed to start/);
      expect(factory.created).toBe(0);
    });

    it('私設・リンクローカル宛のURLは接続を試みずに拒否する', async () => {
      const { client, factory, config: stored } = forbidden({ kind: 'http', url: 'http://169.254.169.254/mcp', headers: {} });
      await expect(client.listTools(stored)).rejects.toThrow(/link-local/);
      expect(factory.created).toBe(0);
    });

    it('ポリシーを緩めれば通る（既存利用を壊さない逃げ道）', async () => {
      const factory = transportFactory();
      factories.push(factory);
      const client = new SdkMcpClient({ createTransport: factory.create, policy: UNRESTRICTED_MCP_POLICY });
      clients.push(client);
      await expect(client.listTools(config({ name: 'legacy', transport: { kind: 'stdio', command: 'whoami', args: [], env: {} } }))).resolves.toBeDefined();
    });
  });

  describe('DNS再検査（リバインディング対策）', () => {
    function withResolver(addresses: readonly string[] | Error) {
      const factory = transportFactory();
      factories.push(factory);
      const client = new SdkMcpClient({
        createTransport: factory.create,
        resolveHost: async () => { if (addresses instanceof Error) throw addresses; return addresses; },
      });
      clients.push(client);
      return { client, factory };
    }
    const remote = config({ name: 'remote', transport: { kind: 'http', url: 'https://mcp.example.com/mcp', headers: {} } });

    it('公開アドレスへ解決されるホストは通る', async () => {
      const { client, factory } = withResolver(['93.184.216.34']);
      await expect(client.listTools(remote)).resolves.toBeDefined();
      expect(factory.created).toBe(1);
    });

    it('私設アドレスへ解決されるホストは拒否する', async () => {
      const { client, factory } = withResolver(['10.0.0.5']);
      await expect(client.listTools(remote)).rejects.toThrow(/private network/);
      expect(factory.created).toBe(0);
    });

    it('複数アドレスのうち1つでも内部なら拒否する', async () => {
      const { client } = withResolver(['93.184.216.34', '169.254.169.254']);
      await expect(client.listTools(remote)).rejects.toThrow(/link-local/);
    });

    it('解決できないホストは拒否する（検査の回避手段にしない）', async () => {
      const { client, factory } = withResolver(new Error('ENOTFOUND'));
      await expect(client.listTools(remote)).rejects.toThrow(/could not be resolved/);
      expect(factory.created).toBe(0);
    });

    it('拒否メッセージに解決先アドレスを載せない', async () => {
      const { client } = withResolver(['10.11.12.13']);
      const error = await client.listTools(remote).catch((cause: unknown) => cause);
      expect(String(error)).not.toContain('10.11.12.13');
    });

    it('stdio には DNS 検査を行わない', async () => {
      const { client, factory } = withResolver(new Error('should not be called'));
      await expect(client.listTools(config())).resolves.toBeDefined();
      expect(factory.created).toBe(1);
    });
  });

  it('接続断などの通信失敗後はプールから除去し、次回は新しい接続を張る', async () => {
    const factory = transportFactory();
    factories.push(factory);
    const client = new SdkMcpClient({ createTransport: factory.create });
    clients.push(client);
    await client.listTools(config());
    expect(client.pooledConnections).toBe(1);

    // サーバー側を落とすとトランスポートが切れ、以降のリクエストは送信自体が失敗する。
    await factory.servers[0]?.close();
    await expect(client.listTools(config())).rejects.toBeInstanceOf(McpClientError);
    expect(client.pooledConnections).toBe(0);

    await client.listTools(config());
    expect(factory.created).toBe(2);
    expect(client.pooledConnections).toBe(1);
  });
});
