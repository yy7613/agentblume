import { expect } from 'vitest';
import { createChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import type { ChartOfAccountsRepository } from '../../domain/journal/repositories';
import { AT, chartFixture, otherTenant, otherWorkspace, scope } from './journal-repository.fixtures';

/** ChartOfAccountsRepository 実装が満たすべき共有契約（科目マスタはワークスペースに1つ）。 */
export async function chartOfAccountsRepositoryContract(repo: ChartOfAccountsRepository): Promise<void> {
  // 境界: 保存したことが無いワークスペースは null（application が標準セットを返す）。
  expect(await repo.get(scope)).toBeNull();

  // 正常: 科目・補助軸・税区分・updatedAt が欠けずに往復する。
  const chart = chartFixture();
  await repo.save(scope, chart);
  const loaded = await repo.get(scope);
  expect(loaded).toEqual(chart);
  expect(loaded?.accounts.length).toBe(chart.accounts.length);
  expect(loaded?.taxCategories.length).toBe(chart.taxCategories.length);

  // 正常: 同じスコープへの保存は上書き（版を持たない）。
  const revised = createChartOfAccounts({
    accounts: [{ id: 'expense.misc', name: '雑費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: ['その他'], enabled: true, sortOrder: 10 }],
    dimensions: [{ id: 'department', name: '部門', values: [{ id: 'sales', name: '営業部', enabled: true }] }],
    taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
    updatedAt: '2026-09-14T00:00:00.000Z',
  });
  await repo.save(scope, revised);
  expect(await repo.get(scope)).toEqual(revised);
  expect((await repo.get(scope))?.accounts).toHaveLength(1);

  // 境界: テナント / ワークスペース分離。別スコープからは見えず、それぞれ別のマスタを持てる。
  expect(await repo.get(otherTenant)).toBeNull();
  const foreign = chartFixture({ updatedAt: '2026-09-15T00:00:00.000Z' });
  await repo.save(otherWorkspace, foreign);
  expect(await repo.get(otherWorkspace)).toEqual(foreign);
  expect(await repo.get(scope)).toEqual(revised);

  // 境界: 保存した値は複製される（呼び出し側の参照経由で内部が壊れない）。
  const mutable = chartFixture({ updatedAt: AT });
  await repo.save(scope, mutable);
  const first = await repo.get(scope);
  expect(first).not.toBe(mutable);
  expect(first?.accounts).not.toBe(mutable.accounts);
  (first?.accounts as unknown as { name: string }[])[0]!.name = '書き換え';
  expect((await repo.get(scope))?.accounts[0]?.name).toBe(mutable.accounts[0]?.name);
}