import { describe, expect, it } from 'vitest';
import { McpNotFoundError, McpValidationError } from '../../domain/mcp/errors';
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { UNRESTRICTED_MCP_POLICY } from '../../domain/mcp/transport-policy';
import type { TenantScope } from '../../domain/tool/ids';
import { DeleteMcpServerUseCase, ListMcpServersUseCase, ReplaceMcpServersUseCase, SaveMcpServerUseCase } from './manage-mcp-servers';
import { McpClientError, type McpClientPort, type McpToolDescriptor } from './mcp-client';
import { TestMcpServerUseCase } from './test-mcp-server';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const now = () => new Date('2026-07-26T00:00:00.000Z');

/** Portだけを満たす最小のfake（adapters実装には依存しない）。 */
class FakeRepository implements McpServerRepository {
  readonly configs = new Map<string, McpServerConfig>();
  replaceAllCalls = 0;
  async save(config: McpServerConfig): Promise<void> { this.configs.set(config.name, config); }
  async find(_scope: TenantScope, name: string): Promise<McpServerConfig | null> { return this.configs.get(name) ?? null; }
  async list(): Promise<readonly McpServerConfig[]> { return [...this.configs.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  async delete(_scope: TenantScope, name: string): Promise<boolean> { return this.configs.delete(name); }
  async replaceAll(_scope: TenantScope, configs: readonly McpServerConfig[]): Promise<void> {
    this.replaceAllCalls += 1;
    this.configs.clear();
    for (const config of configs) this.configs.set(config.name, config);
  }
}

class FakeClient implements McpClientPort {
  constructor(private readonly result: readonly McpToolDescriptor[] | Error) {}
  received: McpServerConfig | undefined;
  async listTools(config: McpServerConfig): Promise<readonly McpToolDescriptor[]> {
    this.received = config;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async callTool(): Promise<never> { throw new Error('not used'); }
  async close(): Promise<void> {}
}

describe('SaveMcpServerUseCase', () => {
  it('設定を検証してupsertし、updatedAtを打刻する', async () => {
    const repo = new FakeRepository();
    const config = await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'fs', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: {} } } });
    expect(config).toMatchObject({ name: 'fs', disabled: false, updatedAt: '2026-07-26T00:00:00.000Z' });
    expect(repo.configs.get('fs')).toEqual(config);

    // 同名の再保存は上書き（版を持たない）。
    const updated = await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'fs', transport: { kind: 'http', url: 'https://e.com/mcp', headers: {} }, disabled: true } });
    expect(repo.configs.size).toBe(1);
    expect(updated.transport).toMatchObject({ kind: 'http' });
    expect(updated.disabled).toBe(true);
  });

  it('不正な設定は保存せずMcpValidationError', async () => {
    const repo = new FakeRepository();
    await expect(new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'bad name', transport: { kind: 'stdio', command: 'node', args: [], env: {} } } }))
      .rejects.toBeInstanceOf(McpValidationError);
    expect(repo.configs.size).toBe(0);
  });
});

describe('秘密値のマスクとポリシー', () => {
  it('戻り値は必ずマスク済み（use caseの外へ平文を出さない）', async () => {
    const repo = new FakeRepository();
    const view = await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'fs', transport: { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: 'plaintext-secret' } } } });
    expect(view.transport).toMatchObject({ env: { TOKEN: '***' } });
    expect(JSON.stringify(view)).not.toContain('plaintext-secret');
    // リポジトリ（＝接続に使う側）には平文が入っている。
    expect(repo.configs.get('fs')?.transport).toMatchObject({ env: { TOKEN: 'plaintext-secret' } });
  });

  it('一覧もマスク済み', async () => {
    const repo = new FakeRepository();
    await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'fs', transport: { kind: 'http', url: 'https://e.com/mcp', headers: { Authorization: 'Bearer plaintext-secret' } } } });
    expect(JSON.stringify(await new ListMcpServersUseCase(repo).execute(scope))).not.toContain('plaintext-secret');
  });

  it('マスクのまま保存すると保存済みの値を維持する', async () => {
    const repo = new FakeRepository();
    const save = new SaveMcpServerUseCase(repo, now);
    await save.execute({ scope, server: { name: 'fs', transport: { kind: 'stdio', command: 'npx', args: [], env: { TOKEN: 'real' } } } });
    await save.execute({ scope, server: { name: 'fs', transport: { kind: 'stdio', command: 'npx', args: ['-y'], env: { TOKEN: '***' } } } });
    expect(repo.configs.get('fs')?.transport).toMatchObject({ args: ['-y'], env: { TOKEN: 'real' } });
  });

  it('許可外コマンドは保存されない', async () => {
    const repo = new FakeRepository();
    await expect(new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'evil', transport: { kind: 'stdio', command: 'whoami', args: [], env: {} } } }))
      .rejects.toBeInstanceOf(McpValidationError);
    expect(repo.configs.size).toBe(0);
  });

  it('私設ネットワーク宛URLは保存されないが、ループバックは通る', async () => {
    const repo = new FakeRepository();
    const save = new SaveMcpServerUseCase(repo, now);
    await expect(save.execute({ scope, server: { name: 'probe', transport: { kind: 'http', url: 'http://10.0.0.5/mcp', headers: {} } } })).rejects.toBeInstanceOf(McpValidationError);
    await expect(save.execute({ scope, server: { name: 'local', transport: { kind: 'http', url: 'http://127.0.0.1:3000/mcp', headers: {} } } })).resolves.toBeDefined();
  });

  it('ReplaceMcpServers はポリシー違反があれば1件も置き換えない', async () => {
    const repo = new FakeRepository();
    await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'keep', transport: { kind: 'stdio', command: 'node', args: [], env: {} } } });
    await expect(new ReplaceMcpServersUseCase(repo, now).execute(scope, { mcpServers: { ok: { command: 'npx' }, bad: { command: 'whoami' } } }))
      .rejects.toBeInstanceOf(McpValidationError);
    expect(repo.replaceAllCalls).toBe(0);
    expect([...repo.configs.keys()]).toEqual(['keep']);
  });

  it('ポリシーを注入で緩められる', async () => {
    const repo = new FakeRepository();
    await expect(new SaveMcpServerUseCase(repo, now, UNRESTRICTED_MCP_POLICY).execute({ scope, server: { name: 'any', transport: { kind: 'stdio', command: 'whoami', args: [], env: {} } } }))
      .resolves.toBeDefined();
  });
});

describe('ListMcpServersUseCase / DeleteMcpServerUseCase', () => {
  it('一覧はname昇順、削除は未存在でMcpNotFoundError', async () => {
    const repo = new FakeRepository();
    const save = new SaveMcpServerUseCase(repo, now);
    for (const name of ['zeta', 'alpha']) await save.execute({ scope, server: { name, transport: { kind: 'stdio', command: 'node', args: [], env: {} } } });
    expect((await new ListMcpServersUseCase(repo).execute(scope)).map((config) => config.name)).toEqual(['alpha', 'zeta']);

    const remove = new DeleteMcpServerUseCase(repo);
    await expect(remove.execute(scope, 'alpha')).resolves.toBeUndefined();
    await expect(remove.execute(scope, 'alpha')).rejects.toBeInstanceOf(McpNotFoundError);
  });
});

describe('ReplaceMcpServersUseCase', () => {
  it('標準ドキュメントでスコープ内を丸ごと置き換える', async () => {
    const repo = new FakeRepository();
    await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'stale', transport: { kind: 'stdio', command: 'node', args: [], env: {} } } });
    const configs = await new ReplaceMcpServersUseCase(repo, now).execute(scope, { mcpServers: { fs: { command: 'npx', args: ['-y', 'x'] }, remote: { url: 'https://e.com/mcp' } } });
    expect(configs.map((config) => config.name)).toEqual(['fs', 'remote']);
    expect([...repo.configs.keys()]).toEqual(['fs', 'remote']);
  });

  it('検証に失敗したドキュメントは既存設定を壊さない（replaceAllを呼ばない）', async () => {
    const repo = new FakeRepository();
    await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'keep', transport: { kind: 'stdio', command: 'node', args: [], env: {} } } });
    await expect(new ReplaceMcpServersUseCase(repo, now).execute(scope, { mcpServers: { broken: { command: 'node', url: 'https://e.com' } } }))
      .rejects.toBeInstanceOf(McpValidationError);
    expect(repo.replaceAllCalls).toBe(0);
    expect([...repo.configs.keys()]).toEqual(['keep']);
  });
});

describe('TestMcpServerUseCase', () => {
  async function seed(repo: FakeRepository, disabled = false) {
    await new SaveMcpServerUseCase(repo, now).execute({ scope, server: { name: 'fs', transport: { kind: 'stdio', command: 'node', args: [], env: {} }, disabled } });
  }

  it('接続できたらツール一覧を返す', async () => {
    const repo = new FakeRepository(); await seed(repo);
    const client = new FakeClient([{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }, { name: 'write_file', inputSchema: { type: 'object' } }]);
    expect(await new TestMcpServerUseCase(repo, client).execute(scope, 'fs'))
      .toEqual({ ok: true, tools: [{ name: 'read_file', description: 'Read a file' }, { name: 'write_file' }] });
  });

  it('disabled なサーバーもテストできる（設定を直すために検証したいため）', async () => {
    const repo = new FakeRepository(); await seed(repo, true);
    const client = new FakeClient([{ name: 'ping', inputSchema: { type: 'object' } }]);
    const result = await new TestMcpServerUseCase(repo, client).execute(scope, 'fs');
    expect(result.ok).toBe(true);
    expect(client.received?.disabled).toBe(true);
  });

  it('接続失敗は例外にせず ok:false と error に正規化する', async () => {
    const repo = new FakeRepository(); await seed(repo);
    const client = new FakeClient(new McpClientError('MCP server "fs" connect failed: spawn ENOENT'));
    expect(await new TestMcpServerUseCase(repo, client).execute(scope, 'fs'))
      .toEqual({ ok: false, error: 'MCP server "fs" connect failed: spawn ENOENT' });
  });

  it('未保存のサーバー名は McpNotFoundError（404）', async () => {
    const repo = new FakeRepository();
    await expect(new TestMcpServerUseCase(repo, new FakeClient([])).execute(scope, 'missing')).rejects.toBeInstanceOf(McpNotFoundError);
  });
});
