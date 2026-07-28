import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpClientError, type McpClientPort, type McpToolDescriptor } from '../application/mcp/mcp-client';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

/** 実接続しないテスト用クライアント。listTools の応答を差し替えて接続テストの分岐を検証する。 */
class FakeMcpClient implements McpClientPort {
  result: readonly McpToolDescriptor[] | Error = [];
  async listTools(): Promise<readonly McpToolDescriptor[]> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async callTool(): Promise<never> { throw new Error('not used'); }
  async close(): Promise<void> {}
}

describe('mcp routes', () => {
  let app: App; let server: FastifyInstance; let client: FakeMcpClient;
  beforeEach(() => {
    client = new FakeMcpClient();
    app = createApp({ profile: 'test', mcpClient: client });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
  });
  afterEach(async () => { await server.close(); app.close(); });

  const stdioServer = { name: 'filesystem', transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'], env: { LOG: 'debug' } } };

  it('MCPサーバー設定を保存・一覧・削除できる', async () => {
    expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json()).toEqual({ servers: [] });

    const saved = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: stdioServer } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().server).toMatchObject({
      scope, name: 'filesystem', disabled: false,
      transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'], env: { LOG: 'debug' } },
    });
    expect(typeof saved.json().server.updatedAt).toBe('string');

    const listed = await server.inject({ method: 'GET', url: '/mcp-servers', query: scope });
    expect(listed.json().servers.map((item: { name: string }) => item.name)).toEqual(['filesystem']);

    // 同名POSTは upsert（重複を作らない）。
    const updated = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { ...stdioServer, disabled: true } } });
    expect(updated.statusCode).toBe(201);
    expect(updated.json().server.disabled).toBe(true);
    expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json().servers).toHaveLength(1);

    const deleted = await server.inject({ method: 'DELETE', url: '/mcp-servers/filesystem', query: scope });
    expect(deleted.statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json()).toEqual({ servers: [] });
  });

  it('http transport（streamable-http）も保存できる', async () => {
    const saved = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'remote', transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } } } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().server.transport).toEqual({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
  });

  it('args / env / headers を省略すると既定値（空）になる', async () => {
    const saved = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'minimal', transport: { kind: 'stdio', command: 'node' } } } });
    expect(saved.json().server.transport).toEqual({ kind: 'stdio', command: 'node', args: [], env: {} });
  });

  it.each([
    ['名前が不正', { scope, server: { ...stdioServer, name: 'bad name' } }],
    ['transport.kind が不正', { scope, server: { name: 'x', transport: { kind: 'sse', url: 'https://e.com' } } }],
    ['http url が http(s) でない', { scope, server: { name: 'x', transport: { kind: 'http', url: 'ftp://example.com' } } }],
    ['command が空', { scope, server: { name: 'x', transport: { kind: 'stdio', command: '' } } }],
    ['scope 欠落', { server: stdioServer }],
  ])('不正なbody（%s）は400', async (_label, payload) => {
    const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload });
    expect(response.statusCode).toBe(400);
  });

  it('未登録サーバーの削除は404', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/mcp-servers/missing', query: scope });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'MCP_NOT_FOUND' });
  });

  describe('PUT /mcp-servers（標準mcpServersドキュメントの一括適用）', () => {
    it('スコープ内の設定を丸ごと置き換える', async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'stale', transport: { kind: 'stdio', command: 'node' } } } });

      const applied = await server.inject({
        method: 'PUT', url: '/mcp-servers',
        payload: { scope, mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server'] }, remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }, paused: { command: 'node', disabled: true } } },
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json().servers.map((item: { name: string }) => item.name)).toEqual(['filesystem', 'paused', 'remote']);

      const listed = await server.inject({ method: 'GET', url: '/mcp-servers', query: scope });
      expect(listed.json().servers.map((item: { name: string }) => item.name)).toEqual(['filesystem', 'paused', 'remote']);
      expect(listed.json().servers.find((item: { name: string }) => item.name === 'paused').disabled).toBe(true);
    });

    it('空のドキュメントで全削除できる', async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: stdioServer } });
      const applied = await server.inject({ method: 'PUT', url: '/mcp-servers', payload: { scope, mcpServers: {} } });
      expect(applied.statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json()).toEqual({ servers: [] });
    });

    it.each([
      ['command と url の両方', { both: { command: 'node', url: 'https://e.com' } }],
      ['command も url も無い', { neither: { args: ['x'] } }],
      ['名前が識別子として不正', { 'bad name': { command: 'node' } }],
      ['env の値が文字列でない', { a: { command: 'node', env: { K: 1 } } }],
    ])('不正なドキュメント（%s）は400で、既存設定を壊さない', async (_label, mcpServers) => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: stdioServer } });
      const response = await server.inject({ method: 'PUT', url: '/mcp-servers', payload: { scope, mcpServers } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('MCP_VALIDATION');
      expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json().servers).toHaveLength(1);
    });
  });

  describe('POST /mcp-servers/:name/test', () => {
    beforeEach(async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: stdioServer } });
    });

    it('接続できたらツール一覧を200で返す', async () => {
      client.result = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }, { name: 'write_file', inputSchema: { type: 'object' } }];
      const response = await server.inject({ method: 'POST', url: '/mcp-servers/filesystem/test', payload: { scope } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, tools: [{ name: 'read_file', description: 'Read a file' }, { name: 'write_file' }] });
    });

    it('接続失敗も200で ok:false として返す（HTTPエラーにしない）', async () => {
      client.result = new McpClientError('MCP server "filesystem" connect failed: spawn ENOENT');
      const response = await server.inject({ method: 'POST', url: '/mcp-servers/filesystem/test', payload: { scope } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: false, error: 'MCP server "filesystem" connect failed: spawn ENOENT' });
    });

    it('未登録サーバーのテストは404', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers/missing/test', payload: { scope } });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatchObject({ code: 'MCP_NOT_FOUND' });
    });
  });

  it('テナント分離: 別ワークスペースの設定は見えない', async () => {
    await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: stdioServer } });
    const other = { tenantId: 'tenant', workspaceId: 'other' };
    // 境界を決めるのはPrincipalなので、別ワークスペースのPrincipalでサーバーを立てて確認する。
    const otherServer = buildServer(app, { authentication: new SingleUserAuthentication(other) });
    expect((await otherServer.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json()).toEqual({ servers: [] });
    expect((await otherServer.inject({ method: 'DELETE', url: '/mcp-servers/filesystem', query: scope })).statusCode).toBe(404);
    // 逆に、所有者側が別ワークスペースを名乗っても自分のデータしか見えない（申告は無視される）。
    expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: other })).json().servers).toHaveLength(1);
    await otherServer.close();
  });
});
