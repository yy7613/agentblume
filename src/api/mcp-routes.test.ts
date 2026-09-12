import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpClientError, type McpClientPort, type McpToolDescriptor } from '../application/mcp/mcp-client';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createMcpServerConfig, type McpServerConfig } from '../domain/mcp/mcp-server';
import type { AuthorizationRole } from '../domain/security/authorization';
import { SdkMcpClient } from '../adapters/mcp/sdk-mcp-client';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

/**
 * 実接続しないテスト用クライアント。listTools の応答を差し替えて接続テストの分岐を検証する。
 * `received` には**接続に使われる設定**（＝平文の資格情報を含む）が入るので、
 * マスク往復で実値が復元されているかの確認に使う。
 */
class FakeMcpClient implements McpClientPort {
  result: readonly McpToolDescriptor[] | Error = [];
  received: McpServerConfig | undefined;
  async listTools(config: McpServerConfig): Promise<readonly McpToolDescriptor[]> {
    this.received = config;
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
      // env の値は伏せて返る（キーは残す）。
      transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'], env: { LOG: '***' } },
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
    expect(saved.json().server.transport).toEqual({ kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: '***' } });
  });

  it('args / env / headers を省略すると既定値（空）になる', async () => {
    const saved = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'minimal', transport: { kind: 'stdio', command: 'npx' } } } });
    expect(saved.json().server.transport).toEqual({ kind: 'stdio', command: 'npx', args: [], env: {} });
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
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'stale', transport: { kind: 'stdio', command: 'npx' } } } });

      const applied = await server.inject({
        method: 'PUT', url: '/mcp-servers',
        payload: { scope, mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server'] }, remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }, paused: { command: 'uvx', disabled: true } } },
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
      ['command と url の両方', { both: { command: 'npx', url: 'https://e.com' } }],
      ['command も url も無い', { neither: { args: ['x'] } }],
      ['名前が識別子として不正', { 'bad name': { command: 'npx' } }],
      ['env の値が文字列でない', { a: { command: 'npx', env: { K: 1 } } }],
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

  describe('資格情報の秘匿（env / headers）', () => {
    it('応答のどこにも env / headers の平文が現れない', async () => {
      const token = 'ghp_supersecretvalue';
      const bearer = 'Bearer verysecretheadervalue';
      const created = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: token } } } } });
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'remote', transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: bearer } } } } });

      const listed = await server.inject({ method: 'GET', url: '/mcp-servers', query: scope });
      for (const body of [created.body, listed.body]) {
        expect(body).not.toContain(token);
        expect(body).not.toContain('verysecretheadervalue');
      }
      // キー名は残る（どの変数を設定したかは秘密ではなく、UIとJSONタブに必要）。
      expect(listed.body).toContain('GITHUB_TOKEN');
      expect(listed.json().servers.find((item: { name: string }) => item.name === 'github').transport.env).toEqual({ GITHUB_TOKEN: '***' });
    });

    it('マスクのまま保存し直すと保存済みの値が維持される（フォームタブの再保存）', async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: 'real-token' } } } } });
      // 一覧で見えるのはマスク。それをそのまま送り返す（disabled だけ変える）。
      const resaved = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: '***' } }, disabled: true } } });
      expect(resaved.statusCode).toBe(201);
      expect(resaved.json().server.disabled).toBe(true);

      // 実際に接続へ渡される設定には平文が戻っている。
      client.result = [];
      await server.inject({ method: 'POST', url: '/mcp-servers/github/test', payload: { scope } });
      expect(client.received?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'real-token' } });
    });

    it('実値を送れば差し替わる', async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: 'old' } } } } });
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: 'new' } } } } });
      client.result = [];
      await server.inject({ method: 'POST', url: '/mcp-servers/github/test', payload: { scope } });
      expect(client.received?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'new' } });
    });

    it('引き継ぎ元の無いマスク値は400（リテラル *** を保存しない）', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'fresh', transport: { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: '***' } } } } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('MCP_VALIDATION');
    });

    it('JSONタブ: 表示された文書を無編集で適用しても設定は変わらない', async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { GITHUB_TOKEN: 'real-token' } } } } });
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'remote', transport: { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer real' } } } } });

      // UIがJSONタブに出す文書はマスク済み一覧から作られる。それをそのまま適用する。
      const listed = (await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json().servers as readonly { name: string; transport: Record<string, unknown>; disabled: boolean }[];
      const mcpServers = Object.fromEntries(listed.map((item) => {
        const { kind: _kind, ...rest } = item.transport;
        return [item.name, rest] as const;
      }));
      const applied = await server.inject({ method: 'PUT', url: '/mcp-servers', payload: { scope, mcpServers } });
      expect(applied.statusCode).toBe(200);
      expect(applied.body).not.toContain('real-token');

      // 保存済みの平文はそのまま残っている（往復で秘密が失われない）。
      client.result = [];
      await server.inject({ method: 'POST', url: '/mcp-servers/github/test', payload: { scope } });
      expect(client.received?.transport).toMatchObject({ env: { GITHUB_TOKEN: 'real-token' } });
      await server.inject({ method: 'POST', url: '/mcp-servers/remote/test', payload: { scope } });
      expect(client.received?.transport).toMatchObject({ headers: { Authorization: 'Bearer real' } });
    });

    it('JSONタブ: 名前を変えるとマスクは引き継げず400（沈黙のデータ破壊を防ぐ）', async () => {
      await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'github', transport: { kind: 'stdio', command: 'npx', args: [], env: { GITHUB_TOKEN: 'real' } } } } });
      const response = await server.inject({ method: 'PUT', url: '/mcp-servers', payload: { scope, mcpServers: { renamed: { command: 'npx', env: { GITHUB_TOKEN: '***' } } } } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('MCP_VALIDATION');
      // 何も置き換えられていない。
      expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json().servers.map((item: { name: string }) => item.name)).toEqual(['github']);
    });
  });

  describe('コマンド許可リスト', () => {
    it('許可外のコマンドは400', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'evil', transport: { kind: 'stdio', command: 'whoami' } } } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('MCP_VALIDATION');
      expect(response.json().error.message).toContain('AGENTCONTEXT_MCP_ALLOWED_COMMANDS');
    });

    it('cmd /c npx ... は通り、cmd /c 任意コマンド は400', async () => {
      const ok = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'winnpx', transport: { kind: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'srv'] } } } });
      expect(ok.statusCode).toBe(201);
      const bad = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'winbad', transport: { kind: 'stdio', command: 'cmd', args: ['/c', 'calc.exe'] } } } });
      expect(bad.statusCode).toBe(400);
    });

    it('相対パスの cwd は400', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'rel', transport: { kind: 'stdio', command: 'npx', cwd: '../..' } } } });
      expect(response.statusCode).toBe(400);
    });

    it('JSONタブ経由でも許可リストは効く', async () => {
      const response = await server.inject({ method: 'PUT', url: '/mcp-servers', payload: { scope, mcpServers: { evil: { command: 'bash', args: ['-c', 'id'] } } } });
      expect(response.statusCode).toBe(400);
    });

    /**
     * 既定の許可リストは MCP のランチャー（npx / uvx / bunx / cmd）だけ。`node` / `python` は
     * `-e` / `-c` で任意コードを走らせるので既定から外した。拒否文は直し方まで書く。
     */
    it('node は既定では400で、拒否文がコマンド名と環境変数の設定値を案内する', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'local', transport: { kind: 'stdio', command: 'node', args: ['server.js'] } } } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({
        code: 'MCP_VALIDATION',
        message: 'transport.command is not allowed: node. Allowed commands: npx, uvx, bunx, cmd. To allow it, set AGENTCONTEXT_MCP_ALLOWED_COMMANDS=npx,uvx,bunx,cmd,node on the server and restart',
      });
      expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json()).toEqual({ servers: [] });
    });

    it('cmd /c node ... も既定では400（ラッパー越しでも同じ許可リスト）', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'winnode', transport: { kind: 'stdio', command: 'cmd', args: ['/c', 'node', 'server.js'] } } } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain('not allowed: node');
    });

    it('PATH / NODE_OPTIONS / LD_PRELOAD を上書きする env は400（値は応答に載せない）', async () => {
      const cases: readonly (readonly [string, string])[] = [['PATH', '/tmp/evil-bin'], ['node_options', '--require /tmp/evil.js'], ['LD_PRELOAD', '/tmp/evil.so']];
      for (const [name, value] of cases) {
        const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'fs', transport: { kind: 'stdio', command: 'npx', env: { [name]: value } } } } });
        expect(response.statusCode, name).toBe(400);
        expect(response.json().error).toEqual({ code: 'MCP_VALIDATION', message: `transport.env must not override ${name} (it changes how the child process executes)` });
        expect(response.body).not.toContain('evil');
      }
      expect((await server.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json()).toEqual({ servers: [] });
    });
  });

  /**
   * 既定の許可リストから `node` を外したので、更新前に保存された `node …` の行は接続時に止まる。
   * 接続テストは HTTP エラーではなく `ok:false` で返す約束なので、そこに直し方が載っていること。
   */
  describe('以前の既定で保存された node の行（移行）', () => {
    it('接続テストは ok:false で、コマンド名と環境変数の設定値を返す（プロセスは起こさない）', async () => {
      let transportCreated = 0;
      const sdk = new SdkMcpClient({ createTransport: () => { transportCreated += 1; throw new Error('must not be reached'); } });
      const legacyApp = createApp({ profile: 'test', mcpClient: sdk });
      const legacyServer = buildServer(legacyApp, { authentication: new SingleUserAuthentication(scope) });
      try {
        // use case（保存時の検査）を通さずリポジトリへ直接入れる ＝ ポリシー導入前・旧既定で保存された行。
        await legacyApp.mcpServerRepo.save(createMcpServerConfig({ scope, name: 'legacy', transport: { kind: 'stdio', command: 'node', args: ['server.js'], env: {} }, updatedAt: '2026-07-26T00:00:00.000Z' }));
        const response = await legacyServer.inject({ method: 'POST', url: '/mcp-servers/legacy/test', payload: { scope } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ok: false,
          error: 'MCP server "legacy" is not allowed to start: transport.command is not allowed: node. Allowed commands: npx, uvx, bunx, cmd. To allow it, set AGENTCONTEXT_MCP_ALLOWED_COMMANDS=npx,uvx,bunx,cmd,node on the server and restart',
        });
        expect(transportCreated).toBe(0);
        // 設定そのものは消えない（一覧には残り、環境変数を直せばそのまま動く）。
        expect((await legacyServer.inject({ method: 'GET', url: '/mcp-servers', query: scope })).json().servers.map((item: { name: string }) => item.name)).toEqual(['legacy']);
      } finally {
        await legacyServer.close();
        legacyApp.close();
        await sdk.close();
      }
    });
  });

  /**
   * MCP サーバー設定は**サーバーホスト上でのコード実行権限**に等しい（stdio は子プロセスの起動）。
   * 変更系と接続テストは `mcp-server:operate`（Operator / Workspace Admin）だけが通る。
   * 認可表（`authorization.ts`）が HTTP の結果として現れることを、このルート群の fixture で確かめる。
   */
  describe('ロールごとの認可（変更系と接続テストは operate）', () => {
    const TOKEN = 'r'.repeat(40);
    const auth = { authorization: `Bearer ${TOKEN}` };
    function rolesAuth(roles: readonly AuthorizationRole[]): AuthenticationPort {
      return {
        mode: 'token',
        required: true,
        authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
          ? authenticated({ subject: 'rita', ...scope, roles })
          : rejected('missing-credentials'),
      };
    }
    function serverFor(roles: readonly AuthorizationRole[]): FastifyInstance {
      return buildServer(app, { authentication: rolesAuth(roles), authorization: new RoleMatrixAuthorization() });
    }
    const DENIED = { code: 'FORBIDDEN', message: "this operation requires the 'mcp-server:operate' permission" };

    it.each(['viewer', 'editor', 'publisher'] as const)('%s: 一覧は読めるが、保存・置換・削除・接続テストは403', async (role) => {
      const roleServer = serverFor([role]);
      try {
        expect((await roleServer.inject({ method: 'GET', url: '/mcp-servers', headers: auth, query: scope })).statusCode).toBe(200);
        const responses = await Promise.all([
          roleServer.inject({ method: 'POST', url: '/mcp-servers', headers: auth, payload: { scope, server: stdioServer } }),
          roleServer.inject({ method: 'PUT', url: '/mcp-servers', headers: auth, payload: { scope, mcpServers: { filesystem: { command: 'npx' } } } }),
          roleServer.inject({ method: 'DELETE', url: '/mcp-servers/filesystem', headers: auth, query: scope }),
          roleServer.inject({ method: 'POST', url: '/mcp-servers/filesystem/test', headers: auth, payload: { scope } }),
        ]);
        for (const response of responses) {
          expect(response.statusCode).toBe(403);
          expect(response.json().error).toEqual(DENIED);
        }
        // 何も保存されず、接続もされていない。
        expect((await roleServer.inject({ method: 'GET', url: '/mcp-servers', headers: auth, query: scope })).json()).toEqual({ servers: [] });
        expect(client.received).toBeUndefined();
      } finally { await roleServer.close(); }
    });

    it.each(['operator', 'workspace-admin'] as const)('%s: 保存・接続テスト・置換・削除がすべて通る', async (role) => {
      const roleServer = serverFor([role]);
      try {
        expect((await roleServer.inject({ method: 'POST', url: '/mcp-servers', headers: auth, payload: { scope, server: stdioServer } })).statusCode).toBe(201);
        const tested = await roleServer.inject({ method: 'POST', url: '/mcp-servers/filesystem/test', headers: auth, payload: { scope } });
        expect(tested.statusCode).toBe(200);
        expect(tested.json()).toEqual({ ok: true, tools: [] });
        expect((await roleServer.inject({ method: 'PUT', url: '/mcp-servers', headers: auth, payload: { scope, mcpServers: { filesystem: { command: 'npx' } } } })).statusCode).toBe(200);
        expect((await roleServer.inject({ method: 'DELETE', url: '/mcp-servers/filesystem', headers: auth, query: scope })).statusCode).toBe(204);
      } finally { await roleServer.close(); }
    });

    /**
     * 単一ユーザーモード（トークン未設定・ループバック限定）の Principal は全ロールを持つので、
     * operate を要求するようになっても**ローカルの利用者は従来どおり MCP を設定できる**。
     * このファイルの既定 fixture がそれで、ここでは前提（ロール）まで明示して固定する。
     */
    it('単一ユーザーモード: ローカル利用者は operator / workspace-admin を含む全ロールを持ち、保存・接続テスト・削除ができる', async () => {
      const session = await server.inject({ method: 'GET', url: '/auth/session' });
      expect(session.json().session).toMatchObject({ mode: 'single-user', authenticationRequired: false });
      expect(session.json().session.principal.roles).toEqual(expect.arrayContaining(['operator', 'workspace-admin']));
      expect((await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: stdioServer } })).statusCode).toBe(201);
      expect((await server.inject({ method: 'POST', url: '/mcp-servers/filesystem/test', payload: { scope } })).json()).toEqual({ ok: true, tools: [] });
      expect((await server.inject({ method: 'DELETE', url: '/mcp-servers/filesystem', query: scope })).statusCode).toBe(204);
    });
  });

  describe('SSRF（宛先の制限）', () => {
    it('ループバックは許可される（ローカルMCPサーバー）', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'local', transport: { kind: 'http', url: 'http://127.0.0.1:3000/mcp' } } } });
      expect(response.statusCode).toBe(201);
    });

    it.each([
      ['クラウドメタデータ', 'http://169.254.169.254/latest/meta-data/'],
      ['RFC1918', 'http://10.0.0.5:8080/mcp'],
      ['LAN', 'http://192.168.1.20/mcp'],
      ['資格情報埋め込み', 'https://user:pass@example.com/mcp'],
    ])('%s 宛は400', async (_label, url) => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'probe', transport: { kind: 'http', url } } } });
      expect(response.statusCode).toBe(400);
    });

    it('拒否メッセージは内部の構造（到達可否・解決結果）を漏らさない', async () => {
      const response = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'probe', transport: { kind: 'http', url: 'http://10.0.0.5:22/mcp' } } } });
      const message = String(response.json().error.message);
      expect(message).not.toMatch(/refused|timeout|ECONN|open|closed/i);
      expect(message).toContain('private network');
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
