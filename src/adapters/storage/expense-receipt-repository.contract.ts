import { expect } from 'vitest';
import type { ExpenseReceiptRepository } from '../../domain/expense/repositories';
import { otherWorkspace, receiptFixture, SAMPLE_DATA_URL, scope, SHA_A, SHA_B } from './expense-repository.fixtures';

/** ExpenseReceiptRepository 実装が満たすべき共有契約。 */
export async function expenseReceiptRepositoryContract(repo: ExpenseReceiptRepository): Promise<void> {
  // 正常: 画像本体が欠けずに往復する。
  const first = receiptFixture('r1');
  await repo.save(first);
  expect(await repo.findById(scope, 'r1')).toEqual(first);
  expect((await repo.findById(scope, 'r1'))?.source.dataUrl).toBe(SAMPLE_DATA_URL);

  // 正常: 明細から引ける。同じ明細に 2 件あれば新しい方。
  await repo.save(receiptFixture('r2', { itemId: 'item-1', sha256: SHA_B, createdAt: '2026-09-15T00:00:00.000Z' }));
  await repo.save(receiptFixture('r3', { itemId: 'item-2', createdAt: '2026-09-14T01:00:00.000Z' }));
  expect((await repo.findByItem(scope, 'claim-1', 'item-1'))?.id).toBe('r2');
  expect(await repo.findByItem(scope, 'claim-1', 'missing')).toBeNull();

  // 正常: ハッシュの一覧は明細 id → SHA-256（新しい方が勝つ）。
  expect(Object.fromEntries(await repo.hashesByClaim(scope, 'claim-1'))).toEqual({ 'item-1': SHA_B, 'item-2': SHA_A });
  expect((await repo.hashesByClaim(scope, 'other-claim')).size).toBe(0);

  // 境界: スコープ分離。
  await repo.save(receiptFixture('r1', { tenant: otherWorkspace }));
  expect((await repo.hashesByClaim(otherWorkspace, 'claim-1')).size).toBe(1);

  // 正常 / 異常: 1 件削除と申請ごとの削除（件数を返す）。他スコープには触れない。
  expect(await repo.delete(scope, 'r3')).toBe(true);
  expect(await repo.delete(scope, 'r3')).toBe(false);
  expect(await repo.deleteByClaim(scope, 'claim-1')).toBe(2);
  expect(await repo.deleteByClaim(scope, 'claim-1')).toBe(0);
  expect(await repo.findById(scope, 'r1')).toBeNull();
  expect(await repo.findById(otherWorkspace, 'r1')).not.toBeNull();
}
