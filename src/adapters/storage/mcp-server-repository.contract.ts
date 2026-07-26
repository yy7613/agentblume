import { expect } from 'vitest';
import { createMcpServerConfig, type McpTransportConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import type { TenantScope } from '../../domain/tool/ids';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const otherTenant: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

function config(name: string, transport: McpTransportConfig, options: { scope?: TenantScope; disabled?: boolean; updatedAt?: string } = {}) {
  return createMcpServerConfig({
    scope: options.scope ?? scope, name, transport,
    disabled: options.disabled ?? false, updatedAt: options.updatedAt ?? '2026-07-26T00:00:00.000Z',
  });
}

const stdio: McpTransportConfig = { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret' }, cwd: '/work' };
const http: McpTransportConfig = { kind: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } };

/** McpServerRepository 実装が満たすべき共有契約。 */
export async function mcpServerRepositoryContract(repo: McpServerRepository): Promise<void> {
  // save は upsert。transport の中身（args/env/cwd/headers）が欠けずに往復する。
  const filesystem = config('filesystem', stdio);
  await repo.save(filesystem);
  expect(await repo.find(scope, 'filesystem')).toEqual(filesystem);

  const remote = config('remote', http, { disabled: true });
  await repo.save(remote);
  expect(await repo.find(scope, 'remote')).toEqual(remote);

  // 同名保存は上書き（版を持たない）。
  const revised = config('filesystem', { kind: 'stdio', command: 'node', args: [], env: {} }, { updatedAt: '2026-07-26T01:00:00.000Z' });
  await repo.save(revised);
  expect(await repo.find(scope, 'filesystem')).toEqual(revised);

  // list は name 昇順。
  expect((await repo.list(scope)).map((item) => item.name)).toEqual(['filesystem', 'remote']);

  // テナント分離: 別テナント・別ワークスペースからは見えない。
  expect(await repo.find(otherTenant, 'filesystem')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  await repo.save(config('filesystem', stdio, { scope: otherWorkspace }));
  expect((await repo.list(otherWorkspace)).map((item) => item.name)).toEqual(['filesystem']);
  expect((await repo.list(scope)).map((item) => item.name)).toEqual(['filesystem', 'remote']);

  // delete は削除前に存在したかを返す。
  expect(await repo.delete(scope, 'remote')).toBe(true);
  expect(await repo.delete(scope, 'remote')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect((await repo.list(scope)).map((item) => item.name)).toEqual(['filesystem']);

  // replaceAll はスコープ内を丸ごと置き換え、他スコープには触れない。
  await repo.replaceAll(scope, [config('alpha', stdio), config('beta', http)]);
  expect((await repo.list(scope)).map((item) => item.name)).toEqual(['alpha', 'beta']);
  expect(await repo.find(scope, 'filesystem')).toBeNull();
  expect((await repo.list(otherWorkspace)).map((item) => item.name)).toEqual(['filesystem']);

  // 空配列での replaceAll はスコープ内を空にする。
  await repo.replaceAll(scope, []);
  expect(await repo.list(scope)).toEqual([]);
  expect((await repo.list(otherWorkspace)).map((item) => item.name)).toEqual(['filesystem']);

  // 保存した値は複製され、リポジトリ内部の状態が呼び出し側の参照経由で壊れない。
  const mutable = config('mutable', stdio);
  await repo.save(mutable);
  const loaded = await repo.find(scope, 'mutable');
  expect(loaded).toEqual(mutable);
  expect(loaded).not.toBe(mutable);
}
