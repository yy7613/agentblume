import { expect } from 'vitest';
import type { TenantScope } from '../../domain/tool/ids';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { createWikiPage, reviseWikiPage, type WikiPage } from '../../domain/memory/wiki-page';
import { createWikiSpace } from '../../domain/memory/wiki-space';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const other: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

function page(id: string, title: string, tags: readonly string[], body: string, updatedAt: string): WikiPage {
  return createWikiPage({ id, tenant: scope, title, tags, body, sourceRuns: ['run-0'], updatedAt });
}

export async function wikiRepositoryContract(repo: WikiRepository): Promise<void> {
  await repo.save(page('cohort', 'Cohort SQL', ['sql', 'analytics'], 'Filter adults by age>=18.', '2026-07-01T00:00:00.000Z'));
  await repo.save(page('etl', 'ETL joins', ['etl'], 'Join orders with users.', '2026-07-02T00:00:00.000Z'));

  // find は本文・sourceRuns まで復元する。
  const found = await repo.find(scope, 'cohort');
  expect(found?.title).toBe('Cohort SQL');
  expect(found?.body).toContain('age>=18');
  expect(found?.sourceRuns).toEqual(['run-0']);
  expect(await repo.find(scope, 'missing')).toBeNull();
  expect(await repo.find(other, 'cohort')).toBeNull();

  // list は要約を返す（本文なし）。
  const summaries = await repo.list(scope);
  expect(summaries.map((s) => s.id).sort()).toEqual(['cohort', 'etl']);
  expect(await repo.list(other)).toEqual([]);

  // upsert: 改訂で version が上がり本文が置換される（重複行にならない）。
  const revised = reviseWikiPage(found as WikiPage, { body: 'Filter adults by age>=21.', addSourceRun: 'run-1', updatedAt: '2026-07-03T00:00:00.000Z' });
  await repo.save(revised);
  expect((await repo.list(scope)).length).toBe(2);
  const after = await repo.find(scope, 'cohort');
  expect(after?.version).toBe(2);
  expect(after?.body).toContain('age>=21');
  expect(after?.sourceRuns).toEqual(['run-0', 'run-1']);

  // search: タイトル一致・本文一致・タグ一致・多語 AND・非一致。
  expect((await repo.search(scope, 'cohort', 10)).map((s) => s.id)).toEqual(['cohort']);
  expect((await repo.search(scope, 'orders', 10)).map((s) => s.id)).toEqual(['etl']);
  expect((await repo.search(scope, 'analytics', 10)).map((s) => s.id)).toEqual(['cohort']);
  expect((await repo.search(scope, 'join USERS', 10)).map((s) => s.id)).toEqual(['etl']);
  expect(await repo.search(scope, 'nonexistent', 10)).toEqual([]);
  expect(await repo.search(other, 'cohort', 10)).toEqual([]);

  // 複数一致は updatedAt DESC・limit 準拠（cohort=07-03 > etl=07-02）。
  const both = await repo.search(scope, 'sql etl analytics orders', 10);
  // 空 query は全件（updatedAt DESC）。
  const all = await repo.search(scope, '   ', 10);
  expect(all.map((s) => s.id)).toEqual(['cohort', 'etl']);
  expect(both).toEqual([]);
  expect((await repo.search(scope, '', 1)).length).toBe(1);

  const customerA = createWikiSpace({ id: 'customer-a', tenant: scope, name: 'Customer A', createdAt: '2026-07-04T00:00:00.000Z' });
  const customerB = createWikiSpace({ id: 'customer-b', tenant: scope, name: 'Customer B', createdAt: '2026-07-04T00:00:00.000Z' });
  await repo.saveSpace(customerA); await repo.saveSpace(customerB);
  await repo.save(createWikiPage({ id: 'policy-a', wikiId: 'customer-a', tenant: scope, title: 'Policy', body: 'refund policy alpha', updatedAt: '2026-07-04T00:00:00.000Z' }));
  await repo.save(createWikiPage({ id: 'policy-b', wikiId: 'customer-b', tenant: scope, title: 'Policy', body: 'refund policy beta', updatedAt: '2026-07-04T00:00:00.000Z' }));
  expect((await repo.listSpaces(scope)).map((space) => space.id)).toEqual(expect.arrayContaining(['default', 'customer-a', 'customer-b']));
  expect((await repo.list(scope, 'customer-a')).map((item) => item.id)).toEqual(['policy-a']);
  expect((await repo.search(scope, 'refund policy', 10, ['customer-b'])).map((item) => item.id)).toEqual(['policy-b']);
  expect(await repo.findSpace(other, 'customer-a')).toBeNull();

  // delete: ページ/空間ともに削除後は find/findSpace が null になり、list/listSpaces からも除外される。
  await expect(repo.delete(scope, 'policy-a')).resolves.toBe(true);
  expect(await repo.find(scope, 'policy-a')).toBeNull();
  expect((await repo.list(scope, 'customer-a'))).toEqual([]);
  await expect(repo.delete(scope, 'policy-a')).resolves.toBe(false);
  await expect(repo.delete(scope, 'missing-page')).resolves.toBe(false);

  await expect(repo.deleteSpace(scope, 'customer-a')).resolves.toBe(true);
  expect(await repo.findSpace(scope, 'customer-a')).toBeNull();
  expect((await repo.listSpaces(scope)).map((space) => space.id)).not.toContain('customer-a');
  await expect(repo.deleteSpace(scope, 'customer-a')).resolves.toBe(false);
  await expect(repo.deleteSpace(scope, 'missing-space')).resolves.toBe(false);
}
