import { expect } from 'vitest';
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpenseSettingsRepository } from '../../domain/expense/repositories';
import { EXPENSE_SETTINGS_KINDS } from '../../domain/expense/settings';
import { fixtureCardSettings, fixtureFareTable, fixtureOrganization, fixturePayoutSettings, otherTenant, otherWorkspace, scope } from './expense-v9.fixtures';

/** ExpenseSettingsRepository 実装が満たすべき共有契約（kind ごとに 1 行）。 */
export async function expenseSettingsRepositoryContract(repo: ExpenseSettingsRepository): Promise<void> {
  // 境界: 保存したことが無ければ null（既定値を返すのは application。ここで勝手に作らない）。
  for (const kind of EXPENSE_SETTINGS_KINDS) expect(await repo.get(scope, kind)).toBeNull();

  // 正常: kind ごとに欠けずに往復し、他の kind には影響しない。
  const organization = fixtureOrganization();
  await repo.save(scope, 'organization', organization);
  expect(await repo.get(scope, 'organization')).toEqual(organization);
  expect(await repo.get(scope, 'payout')).toBeNull();
  const payout = fixturePayoutSettings();
  const cards = fixtureCardSettings();
  const fares = fixtureFareTable();
  await repo.save(scope, 'payout', payout);
  await repo.save(scope, 'cards', cards);
  await repo.save(scope, 'fares', fares);
  expect(await repo.get(scope, 'payout')).toEqual(payout);
  expect((await repo.get(scope, 'payout'))?.source?.accountNumber.hint).toBe('0009');
  expect(await repo.get(scope, 'cards')).toEqual(cards);
  expect(await repo.get(scope, 'fares')).toEqual(fares);

  // 正常: 同じ kind への保存は上書き（版を持たない）。
  const narrowed = { ...fixtureOrganization('2026-09-16T00:00:00.000Z'), approverGroups: [] };
  await repo.save(scope, 'organization', narrowed);
  expect(await repo.get(scope, 'organization')).toEqual(narrowed);

  // 境界: テナント / ワークスペース分離。
  expect(await repo.get(otherTenant, 'organization')).toBeNull();
  await repo.save(otherWorkspace, 'fares', { ...fares, routes: [], updatedAt: '2026-09-17T00:00:00.000Z' });
  expect((await repo.get(otherWorkspace, 'fares'))?.routes).toEqual([]);
  expect((await repo.get(scope, 'fares'))?.routes).toHaveLength(4);

  // 異常: 型の外から来た未知の kind は読みも書きもしない。
  await expect(repo.get(scope, 'unknown' as never)).rejects.toThrow(ExpenseDomainError);
  await expect(repo.save(scope, 'unknown' as never, narrowed as never)).rejects.toThrow('unknown kind');

  // 境界: 保存した値・読み出した値を書き換えても保管庫の中身は変わらない。
  const mutable = fixtureCardSettings('2026-09-18T00:00:00.000Z');
  await repo.save(scope, 'cards', mutable);
  (mutable as unknown as { cards: unknown[] }).cards.length = 0;
  const fetched = await repo.get(scope, 'cards');
  expect(fetched?.cards).toHaveLength(2);
  (fetched as unknown as { cards: unknown[] }).cards.length = 0;
  expect((await repo.get(scope, 'cards'))?.cards).toHaveLength(2);
}
