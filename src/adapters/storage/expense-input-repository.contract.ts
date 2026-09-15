import { expect } from 'vitest';
import type { ExpensePolicyHearing } from '../../domain/expense/policy-hearing';
import type { ExpensePolicyHearingRepository } from '../../domain/expense/repositories';
import { fixtureHearings, hearingFixture, otherTenant, otherWorkspace, scope } from './expense-v9.fixtures';

const ids = (hearings: readonly ExpensePolicyHearing[]): string[] => hearings.map((hearing) => hearing.id);

/** ExpensePolicyHearingRepository 実装が満たすべき共有契約（docs/21 §20.8.3）。 */
export async function expensePolicyHearingRepositoryContract(repo: ExpensePolicyHearingRepository): Promise<void> {
  const [open, proposed] = fixtureHearings() as [ExpensePolicyHearing, ExpensePolicyHearing];

  // 境界: 空のリポジトリ。
  expect(await repo.findById(scope, open.id)).toBeNull();
  expect(await repo.list(scope)).toEqual([]);

  // 正常: 質問と回答・文書の原文・案と根拠が欠けずに往復する。
  await repo.save(open);
  await repo.save(proposed);
  expect(await repo.findById(scope, open.id)).toEqual(open);
  expect(await repo.findById(scope, proposed.id)).toEqual(proposed);
  expect((await repo.findById(scope, proposed.id))?.source.documentText).toContain('旅費・経費規程');

  // 正常: 一覧は updatedAt 降順 → id 昇順。状態で絞れる。limit は並べ替えの後。
  await repo.save(hearingFixture('hearing-a'));
  expect(ids(await repo.list(scope))).toEqual(['hearing-proposed', 'hearing-a', 'hearing-open']);
  expect(ids(await repo.list(scope, { status: 'open' }))).toEqual(['hearing-a', 'hearing-open']);
  expect(ids(await repo.list(scope, { status: 'accepted' }))).toEqual([]);
  expect(ids(await repo.list(scope, { limit: 1 }))).toEqual(['hearing-proposed']);

  // 正常: 同じ id の保存は上書きで、状態と並びの列も入れ直される。
  await repo.save(hearingFixture('hearing-open', { status: 'cancelled', updatedAt: '2026-09-16T00:00:00.000Z' }));
  expect(ids(await repo.list(scope))).toEqual(['hearing-open', 'hearing-proposed', 'hearing-a']);
  expect(ids(await repo.list(scope, { status: 'open' }))).toEqual(['hearing-a']);

  // 境界: テナント / ワークスペース分離。
  await repo.save(hearingFixture('hearing-a', { tenant: otherWorkspace, status: 'cancelled' }));
  expect((await repo.findById(otherWorkspace, 'hearing-a'))?.status).toBe('cancelled');
  expect((await repo.findById(scope, 'hearing-a'))?.status).toBe('open');
  expect(await repo.findById(otherTenant, 'hearing-open')).toBeNull();
  expect(await repo.list(otherTenant)).toEqual([]);

  // 境界: 読み出した値を書き換えても保管庫の中身は変わらない。
  const fetched = await repo.findById(scope, 'hearing-proposed');
  (fetched as unknown as { turns: unknown[] }).turns.push({});
  expect((await repo.findById(scope, 'hearing-proposed'))?.turns).toEqual([]);
}
