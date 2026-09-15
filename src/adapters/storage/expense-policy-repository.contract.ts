import { expect } from 'vitest';
import type { ExpensePolicyRepository } from '../../domain/expense/repositories';
import { otherTenant, otherWorkspace, policyFixture, scope } from './expense-repository.fixtures';

/** ExpensePolicyRepository 実装が満たすべき共有契約。 */
export async function expensePolicyRepositoryContract(repo: ExpensePolicyRepository): Promise<void> {
  // 境界: 保存したことが無ければ null（application が初期テンプレートを返す。ここで勝手に作らない）。
  expect(await repo.get(scope)).toBeNull();

  // 正常: 規程全体が欠けずに往復する。
  const first = policyFixture('2026-09-14T01:00:00.000Z');
  await repo.save(scope, first);
  expect(await repo.get(scope)).toEqual(first);

  // 正常: 同じスコープへの保存は上書き（版を持たない）。
  const second = { ...policyFixture('2026-09-15T00:00:00.000Z'), severityOverrides: { 'payee-missing': 'return' as const } };
  await repo.save(scope, second);
  expect(await repo.get(scope)).toEqual(second);

  // 境界: テナント / ワークスペース分離。
  expect(await repo.get(otherTenant)).toBeNull();
  await repo.save(otherWorkspace, first);
  expect((await repo.get(otherWorkspace))?.updatedAt).toBe(first.updatedAt);
  expect((await repo.get(scope))?.updatedAt).toBe(second.updatedAt);

  // 境界: 読み出した値を書き換えても保管庫の中身は変わらない。
  const fetched = await repo.get(scope);
  (fetched as unknown as { categories: unknown[] }).categories.length = 0;
  expect((await repo.get(scope))?.categories.length).toBeGreaterThan(0);
}
