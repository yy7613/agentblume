import { expect } from 'vitest';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { createToolCheckCase, type CreateToolCheckCaseProps, type ToolCheckCase } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckCaseRepository } from '../../domain/tool-check/tool-check-case-repository';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const otherTenant: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

function item(id: string, overrides: Partial<CreateToolCheckCaseProps> = {}): ToolCheckCase {
  const at = overrides.updatedAt ?? '2026-09-12T00:00:00.000Z';
  return createToolCheckCase({
    scope, id, toolId: 'sales', name: `case ${id}`,
    arguments: { region: 'Tokyo', minimum: 10, flag: true, empty: null },
    expectations: { rowCount: { op: 'gte', value: 1 }, columns: ['region'], cells: [{ column: 'region', op: 'eq', value: 'Tokyo', mode: 'all' }], maxDurationMs: 1000 },
    createdAt: at, updatedAt: at,
    ...overrides,
  });
}

/** ToolCheckCaseRepository 実装が満たすべき共有契約。 */
export async function toolCheckCaseRepositoryContract(repo: ToolCheckCaseRepository): Promise<void> {
  // 正常: save → find で引数・期待・版固定・lastResult が欠けずに往復する。
  const pinned = item('pinned', { toolVersion: '1.2.0', lastResult: { status: 'passed', checkedAt: '2026-09-12T00:00:00.000Z', toolVersion: '1.2.0', summary: 'passed 4/4' } });
  await repo.save(pinned);
  expect(await repo.find(scope, 'pinned')).toEqual(pinned);

  // 正常: 版固定・lastResult 無しの最小ケースも往復する（省略キーは undefined のまま）。
  const latest = item('latest', { arguments: {}, expectations: {}, updatedAt: '2026-09-12T01:00:00.000Z', createdAt: '2026-09-12T01:00:00.000Z' });
  await repo.save(latest);
  const loadedLatest = await repo.find(scope, 'latest');
  expect(loadedLatest).toEqual(latest);
  expect(loadedLatest?.toolVersion).toBeUndefined();
  expect(loadedLatest?.lastResult).toBeUndefined();

  // 正常: 同 id の保存は上書き（版を持たない）。toolId の変更も反映される。
  const revised = item('pinned', { toolId: 'inventory', name: 'renamed', updatedAt: '2026-09-12T02:00:00.000Z' });
  await repo.save(revised);
  expect(await repo.find(scope, 'pinned')).toEqual(revised);
  expect((await repo.list(scope, { toolId: 'sales' })).map((entry) => entry.id)).toEqual(['latest']);

  // 正常: list は updatedAt 降順（新しい定義が先）、同時刻は id 昇順で安定。
  await repo.save(item('b-same', { updatedAt: '2026-09-12T01:00:00.000Z', createdAt: '2026-09-12T01:00:00.000Z' }));
  await repo.save(item('a-same', { updatedAt: '2026-09-12T01:00:00.000Z', createdAt: '2026-09-12T01:00:00.000Z' }));
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['pinned', 'a-same', 'b-same', 'latest']);

  // 正常: toolId で絞り込める。無い toolId は空。
  expect((await repo.list(scope, { toolId: 'inventory' })).map((entry) => entry.id)).toEqual(['pinned']);
  expect((await repo.list(scope, { toolId: 'sales' })).map((entry) => entry.id)).toEqual(['a-same', 'b-same', 'latest']);
  expect(await repo.list(scope, { toolId: 'none' })).toEqual([]);

  // 境界: テナント / ワークスペース分離。別スコープからは見えず、同 id が共存できる。
  expect(await repo.find(otherTenant, 'pinned')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);
  const foreign = createToolCheckCase({ ...item('pinned'), scope: otherWorkspace });
  await repo.save(foreign);
  expect(await repo.find(otherWorkspace, 'pinned')).toEqual(foreign);
  expect(await repo.find(scope, 'pinned')).toEqual(revised);
  expect((await repo.list(otherWorkspace)).map((entry) => entry.id)).toEqual(['pinned']);
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['pinned', 'a-same', 'b-same', 'latest']);

  // 正常 / 異常: delete は削除前に存在したかを返し、他スコープの同 id には触れない。
  expect(await repo.delete(scope, 'pinned')).toBe(true);
  expect(await repo.delete(scope, 'pinned')).toBe(false);
  expect(await repo.delete(scope, 'missing')).toBe(false);
  expect(await repo.find(scope, 'pinned')).toBeNull();
  expect(await repo.find(otherWorkspace, 'pinned')).toEqual(foreign);
  expect((await repo.list(scope)).map((entry) => entry.id)).toEqual(['a-same', 'b-same', 'latest']);

  // 境界: 未知の id は null。空スコープの一覧は空配列。
  expect(await repo.find(scope, 'missing')).toBeNull();
  expect(await repo.list({ tenantId: 'empty', workspaceId: 'empty' })).toEqual([]);

  // 境界: 保存した値は複製され、呼び出し側の参照経由でリポジトリ内部が壊れない。
  const mutable = item('mutable');
  await repo.save(mutable);
  const loaded = await repo.find(scope, 'mutable');
  expect(loaded).toEqual(mutable);
  expect(loaded).not.toBe(mutable);
  expect(loaded?.arguments).not.toBe(mutable.arguments);
}
