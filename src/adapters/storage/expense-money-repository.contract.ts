import { expect } from 'vitest';
import type { ExpenseAdvance } from '../../domain/expense/advance';
import type { CardMatch, ExpenseCardTransaction } from '../../domain/expense/card';
import { ExpenseCardDuplicateImportError, ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpensePayoutBatch } from '../../domain/expense/payout';
import type { ExpenseAdvanceRepository, ExpenseCardRepository, ExpensePayoutBatchRepository } from '../../domain/expense/repositories';
import {
  advanceFixture, bankAccountFixture, cardImportFixture, cardTransactionFixture, FIXTURE_CARD_IDS, FIXTURE_EMPLOYEE_IDS, fixtureAdvances,
  otherTenant, otherWorkspace, payoutBatchFixture, scope, V9_AT,
} from './expense-v9.fixtures';

const ids = (records: readonly { readonly id: string }[]): string[] => records.map((record) => record.id);

/** ExpenseAdvanceRepository 実装が満たすべき共有契約。 */
export async function expenseAdvanceRepositoryContract(repo: ExpenseAdvanceRepository): Promise<void> {
  const [requested, paid, settled] = fixtureAdvances() as [ExpenseAdvance, ExpenseAdvance, ExpenseAdvance];

  // 境界: 空のリポジトリ。
  expect(await repo.findById(scope, requested.id)).toBeNull();
  expect(await repo.list(scope)).toEqual([]);

  // 正常: 承認・支払・精算の記録を含めて欠けずに往復する。
  for (const advance of [requested, paid, settled]) await repo.save(advance);
  expect(await repo.findById(scope, settled.id)).toEqual(settled);
  expect(ids(await repo.findByIds(scope, ['adv-settled', 'missing', 'adv-requested']))).toEqual(['adv-settled', 'adv-requested']);
  expect(await repo.findByIds(scope, [])).toEqual([]);

  // 正常: 一覧は createdAt 降順 → id 昇順。状態・従業員で絞れる。limit は並べ替えの後。
  await repo.save(advanceFixture('adv-new', 'requested', { createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' }));
  expect(ids(await repo.list(scope))).toEqual(['adv-new', 'adv-paid', 'adv-requested', 'adv-settled']);
  expect(ids(await repo.list(scope, { status: 'paid' }))).toEqual(['adv-paid']);
  expect(ids(await repo.list(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.taro }))).toEqual(['adv-new', 'adv-requested']);
  expect(ids(await repo.list(scope, { status: 'requested', employeeId: FIXTURE_EMPLOYEE_IDS.hanako }))).toEqual([]);
  expect(ids(await repo.list(scope, { limit: 1 }))).toEqual(['adv-new']);

  // 正常: 同じ id の保存は上書きで、状態・従業員の列も入れ直される。
  await repo.save(advanceFixture('adv-requested', 'paid'));
  expect(ids(await repo.list(scope, { status: 'requested' }))).toEqual(['adv-new']);
  expect(ids(await repo.list(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.hanako }))).toEqual(['adv-paid', 'adv-requested']);

  // 境界: テナント / ワークスペース分離と複製。
  await repo.save(advanceFixture('adv-new', 'requested', { tenant: otherWorkspace, amount: 1 }));
  expect((await repo.findById(otherWorkspace, 'adv-new'))?.amount).toBe(1);
  expect((await repo.findById(scope, 'adv-new'))?.amount).toBe(30000);
  expect(await repo.list(otherTenant)).toEqual([]);
  const fetched = await repo.findById(scope, 'adv-settled');
  (fetched as unknown as { history: unknown[] }).history.length = 0;
  expect((await repo.findById(scope, 'adv-settled'))?.history).toHaveLength(1);
}

function matchFixture(itemId: string): CardMatch {
  return { claimId: 'claim-a', itemId, kind: 'corporate-item', strength: 'strong', dateDiffDays: 0, amountDiff: 0, manual: false, at: V9_AT };
}

/** ExpenseCardRepository 実装が満たすべき共有契約。 */
export async function expenseCardRepositoryContract(repo: ExpenseCardRepository): Promise<void> {
  const septemberImport = cardImportFixture('import-1');
  const lunch = cardTransactionFixture('tx-1');
  const cafe = cardTransactionFixture('tx-2', { usedOn: '2026-09-12', amount: 1980, merchantRaw: 'サンプル喫茶' });
  const sameRowAgain = cardTransactionFixture('tx-3');
  const refund = cardTransactionFixture('tx-4', { usedOn: '2026-09-15', amount: -500, merchantRaw: 'サンプルマート 霞が関店' });

  // 境界: 空のリポジトリ。
  expect(await repo.findImport(scope, 'import-1')).toBeNull();
  expect(await repo.listImports(scope)).toEqual([]);
  expect(await repo.coverage(scope)).toEqual([]);

  // 正常: 取込と利用行を保存し、同じファイルの中の同じ行（dedupe_key 一致）は数えて入れない。
  expect(await repo.saveImport(septemberImport, [lunch, cafe, sameRowAgain, refund])).toEqual({ inserted: 3, duplicates: 1 });
  expect(await repo.findImport(scope, 'import-1')).toEqual(septemberImport);
  expect(await repo.findTransaction(scope, 'tx-1')).toEqual(lunch);
  expect(await repo.findTransaction(scope, 'tx-3')).toBeNull();

  // 異常: 同じファイル（SHA-256 一致）は既存の取込の id と日時を付けて拒否し、何も保存しない。
  const again = cardImportFixture('import-2', { createdAt: '2026-10-01T00:00:00.000Z' });
  const duplicateError = await repo.saveImport(again, [cardTransactionFixture('tx-5', { importId: 'import-2', usedOn: '2026-09-20' })]).then(() => undefined, (caught: unknown) => caught);
  expect(duplicateError).toBeInstanceOf(ExpenseCardDuplicateImportError);
  expect(duplicateError).toMatchObject({ importId: 'import-1', importedAt: V9_AT });
  expect(await repo.findImport(scope, 'import-2')).toBeNull();
  expect(await repo.findTransaction(scope, 'tx-5')).toBeNull();

  // 正常: 期間の重なる別のファイルは、前のファイルと同じ行だけを重複に数える。
  const overlapping = cardImportFixture('import-2', { fileSha256: 'e'.repeat(64), periodFrom: '2026-09-15', periodTo: '2026-10-15', createdAt: '2026-10-16T00:00:00.000Z' });
  expect(await repo.saveImport(overlapping, [
    cardTransactionFixture('tx-5', { importId: 'import-2' }),
    cardTransactionFixture('tx-6', { importId: 'import-2', usedOn: '2026-10-01', amount: 800, merchantRaw: 'サンプル書店' }),
  ])).toEqual({ inserted: 1, duplicates: 1 });
  // 正常: カードを指定しない取込（1 ファイルに複数カード）。
  await repo.saveImport(cardImportFixture('import-3', { fileSha256: 'f'.repeat(64), cardId: undefined, periodFrom: '2026-11-01', periodTo: '2026-11-30', createdAt: '2026-12-01T00:00:00.000Z' }), [
    cardTransactionFixture('tx-7', { importId: 'import-3', cardId: FIXTURE_CARD_IDS.shared, usedOn: '2026-11-05', amount: 1200 }),
    cardTransactionFixture('tx-8', { importId: 'import-3', cardId: FIXTURE_CARD_IDS.shared, usedOn: '2026-11-06', amount: 1300 }),
  ]);
  expect(ids(await repo.listImports(scope))).toEqual(['import-3', 'import-2', 'import-1']);
  expect(ids(await repo.listImports(scope, { limit: 1 }))).toEqual(['import-3']);

  // 正常 / 境界: 取込範囲はカードごとの和集合。重なり・内包・翌日からの続きはつなげ、空いた月は分ける。
  expect(await repo.coverage(scope)).toEqual([
    { cardId: FIXTURE_CARD_IDS.sales, from: '2026-09-01', to: '2026-10-15' },
    { cardId: FIXTURE_CARD_IDS.shared, from: '2026-11-01', to: '2026-11-30' },
  ]);
  await repo.saveImport(cardImportFixture('import-4', { fileSha256: '1'.repeat(64), periodFrom: '2026-10-16', periodTo: '2026-10-31', createdAt: '2026-11-01T00:00:00.000Z' }), []);
  await repo.saveImport(cardImportFixture('import-5', { fileSha256: '2'.repeat(64), periodFrom: '2026-09-05', periodTo: '2026-09-06', createdAt: '2026-11-02T00:00:00.000Z' }), []);
  await repo.saveImport(cardImportFixture('import-6', { fileSha256: '3'.repeat(64), periodFrom: '2026-12-02', periodTo: '2026-12-31', createdAt: '2027-01-01T00:00:00.000Z' }), []);
  expect(await repo.coverage(scope, [FIXTURE_CARD_IDS.sales])).toEqual([
    { cardId: FIXTURE_CARD_IDS.sales, from: '2026-09-01', to: '2026-10-31' },
    { cardId: FIXTURE_CARD_IDS.sales, from: '2026-12-02', to: '2026-12-31' },
  ]);
  expect(await repo.coverage(scope, [FIXTURE_CARD_IDS.shared, 'card-missing'])).toEqual([{ cardId: FIXTURE_CARD_IDS.shared, from: '2026-11-01', to: '2026-11-30' }]);
  expect(await repo.coverage(scope, [])).toEqual([]);

  // 正常: 利用行の一覧は利用日の降順 → id 昇順。状態・カード・期間（両端を含む）で絞れる。
  expect(ids(await repo.listTransactions(scope))).toEqual(['tx-8', 'tx-7', 'tx-6', 'tx-4', 'tx-2', 'tx-1']);
  expect(ids(await repo.listTransactions(scope, { cardId: FIXTURE_CARD_IDS.shared }))).toEqual(['tx-8', 'tx-7']);
  expect(ids(await repo.listTransactions(scope, { from: '2026-09-12', to: '2026-10-01' }))).toEqual(['tx-6', 'tx-4', 'tx-2']);
  expect(ids(await repo.listTransactions(scope, { status: 'unmatched', limit: 2 }))).toEqual(['tx-8', 'tx-7']);

  // 正常 / 境界: 照合の候補は利用日の昇順 → id 昇順。金額の範囲は両端を含むどれか（返金の負も範囲で拾える）。
  expect(ids(await repo.findTransactionsForMatching(scope, { from: '2026-09-01', to: '2026-09-30', amounts: [] }))).toEqual(['tx-1', 'tx-2', 'tx-4']);
  expect(ids(await repo.findTransactionsForMatching(scope, { from: '2026-09-01', to: '2026-12-31', amounts: [{ min: 1980, max: 1980 }, { min: -500, max: -400 }] }))).toEqual(['tx-2', 'tx-4']);
  expect(await repo.findTransactionsForMatching(scope, { from: '2026-09-11', to: '2026-09-11', amounts: [] })).toEqual([]);

  // 正常: 状態・照合の更新（upsert）。申請で絞れる。
  const matchedLunch = cardTransactionFixture('tx-1', { status: 'matched', match: matchFixture('item-1'), updatedAt: '2026-09-16T00:00:00.000Z' });
  const matchedCafe = cardTransactionFixture('tx-2', { usedOn: '2026-09-12', amount: 1980, merchantRaw: 'サンプル喫茶', status: 'matched', match: matchFixture('item-2') });
  const excludedRefund: ExpenseCardTransaction = { ...refund, status: 'excluded', exclusion: { reason: '個人利用の返金', by: 'keiri@example.com', at: V9_AT } };
  await repo.saveTransactions([matchedLunch, matchedCafe, excludedRefund]);
  expect(await repo.findTransaction(scope, 'tx-1')).toEqual(matchedLunch);
  expect(ids(await repo.listTransactions(scope, { claimId: 'claim-a' }))).toEqual(['tx-2', 'tx-1']);
  expect(ids(await repo.listTransactions(scope, { status: 'excluded' }))).toEqual(['tx-4']);
  await repo.saveTransactions([]);

  // 異常: 別の行と同じ dedupe_key は保存せず、同じ呼び出しの他の行も入らない。
  await expect(repo.saveTransactions([cardTransactionFixture('tx-9', { usedOn: '2026-09-30', amount: 1 }), cardTransactionFixture('tx-10')])).rejects.toThrow(ExpenseDomainError);
  expect(await repo.findTransaction(scope, 'tx-9')).toBeNull();
  expect(await repo.findTransaction(scope, 'tx-10')).toBeNull();

  // 正常: 申請の削除で照合を外す（matched → unmatched。対象外の行は触らない）。2 回目は 0 件。
  expect(await repo.unlinkClaim(scope, 'claim-a')).toBe(2);
  const unlinked = await repo.findTransaction(scope, 'tx-1');
  expect(unlinked?.status).toBe('unmatched');
  expect(unlinked).not.toHaveProperty('match');
  expect(await repo.listTransactions(scope, { claimId: 'claim-a' })).toEqual([]);
  expect((await repo.findTransaction(scope, 'tx-4'))?.status).toBe('excluded');
  expect(await repo.unlinkClaim(scope, 'claim-a')).toBe(0);

  // 正常 / 異常: 取込の削除はその取込の利用行も消し、消した行数を返す。無ければ -1。
  expect(await repo.deleteImport(scope, 'import-1')).toBe(3);
  expect(await repo.findImport(scope, 'import-1')).toBeNull();
  expect(await repo.findTransaction(scope, 'tx-1')).toBeNull();
  expect((await repo.findTransaction(scope, 'tx-6'))?.importId).toBe('import-2');
  expect(await repo.deleteImport(scope, 'import-1')).toBe(-1);
  expect(await repo.deleteImport(scope, 'import-4')).toBe(0);
  // 正常: 消した取込の SHA-256 と行はもう一度取り込める。同じ id の取込の保存し直しは二重取込ではない。
  expect(await repo.saveImport(septemberImport, [lunch])).toEqual({ inserted: 1, duplicates: 0 });
  expect(await repo.saveImport(septemberImport, [lunch])).toEqual({ inserted: 0, duplicates: 1 });

  // 境界: テナント / ワークスペース分離（同じファイル・同じ行を別スコープで取り込める）。
  expect(await repo.saveImport(cardImportFixture('import-1', { tenant: otherWorkspace }), [cardTransactionFixture('tx-1', { tenant: otherWorkspace, status: 'matched', match: matchFixture('item-1') })])).toEqual({ inserted: 1, duplicates: 0 });
  expect(await repo.listImports(otherTenant)).toEqual([]);
  expect(await repo.coverage(otherTenant)).toEqual([]);
  expect(await repo.listTransactions(otherTenant)).toEqual([]);
  expect(await repo.findTransactionsForMatching(otherTenant, { from: '2026-01-01', to: '2026-12-31', amounts: [] })).toEqual([]);
  expect(await repo.unlinkClaim(otherTenant, 'claim-a')).toBe(0);
  expect(await repo.deleteImport(otherTenant, 'import-1')).toBe(-1);
  expect((await repo.findTransaction(otherWorkspace, 'tx-1'))?.status).toBe('matched');
  expect((await repo.findTransaction(scope, 'tx-1'))?.status).toBe('unmatched');

  // 境界: 読み出した値を書き換えても保管庫の中身は変わらない。
  const fetched = await repo.findTransaction(scope, 'tx-6');
  (fetched as unknown as { row: Record<string, string> }).row['利用金額'] = '0';
  expect((await repo.findTransaction(scope, 'tx-6'))?.row['利用金額']).toBe('800');
}

/** ExpensePayoutBatchRepository 実装が満たすべき共有契約。 */
export async function expensePayoutBatchRepositoryContract(repo: ExpensePayoutBatchRepository): Promise<void> {
  const exported = payoutBatchFixture('batch-1');
  const sameTime = payoutBatchFixture('batch-0');
  const confirmed = payoutBatchFixture('batch-2', {
    status: 'confirmed', confirmedAt: '2026-09-26T00:00:00.000Z', confirmedBy: 'keiri@example.com', createdAt: '2026-09-16T00:00:00.000Z', totalAmount: 8000,
    lines: [{
      employeeId: FIXTURE_EMPLOYEE_IDS.hanako, name: 'テスト花子', holderKanaConverted: 'ﾃｽﾄ ﾊﾅｺ', bank: bankAccountFixture('0000002', 'テスト ハナコ'), amount: 8000,
      // 仮払の支払の出所は申請ではないので、同じ id でも申請の検索に当たらない。
      sources: [{ kind: 'claim', id: 'claim-b', amount: 5000 }, { kind: 'advance-payment', id: 'claim-x', amount: 3000 }],
    }],
  });
  const cancelled = payoutBatchFixture('batch-3', { status: 'cancelled', cancel: { by: 'keiri@example.com', at: '2026-09-18T00:00:00.000Z', note: '口座の誤り' }, createdAt: '2026-09-17T00:00:00.000Z' });

  // 境界: 空のリポジトリ。
  expect(await repo.findById(scope, 'batch-1')).toBeNull();
  expect(await repo.findActiveByClaimIds(scope, ['claim-a'])).toEqual([]);

  // 正常: 口座の写し（封緘値のまま）と設定の写しを含めて欠けずに往復する。
  for (const batch of [exported, sameTime, confirmed, cancelled]) await repo.save(batch);
  expect(await repo.findById(scope, 'batch-2')).toEqual(confirmed);
  expect((await repo.findById(scope, 'batch-1'))?.lines[0]?.bank.accountNumber.hint).toBe('0001');

  // 正常: 一覧は createdAt 降順 → id 昇順。状態で絞れる。limit は並べ替えの後。
  expect(ids(await repo.list(scope))).toEqual(['batch-3', 'batch-2', 'batch-0', 'batch-1']);
  expect(ids(await repo.list(scope, { status: 'exported' }))).toEqual(['batch-0', 'batch-1']);
  expect(ids(await repo.list(scope, { limit: 1 }))).toEqual(['batch-3']);

  // 正常 / 境界: 取消されていないバッチのうち申請を含むもの（出所が申請のものだけ）。
  expect(ids(await repo.findActiveByClaimIds(scope, ['claim-a']))).toEqual(['batch-0', 'batch-1']);
  expect(ids(await repo.findActiveByClaimIds(scope, ['claim-b', 'missing']))).toEqual(['batch-2']);
  expect(await repo.findActiveByClaimIds(scope, ['claim-x'])).toEqual([]);
  expect(await repo.findActiveByClaimIds(scope, [])).toEqual([]);

  // 正常: 取り消したバッチ（上書き保存）は検索から外れる。
  await repo.save({ ...exported, status: 'cancelled', cancel: { by: 'keiri@example.com', at: '2026-09-19T00:00:00.000Z', note: '作り直し' } } as ExpensePayoutBatch);
  expect(ids(await repo.findActiveByClaimIds(scope, ['claim-a']))).toEqual(['batch-0']);
  expect(ids(await repo.list(scope, { status: 'cancelled' }))).toEqual(['batch-3', 'batch-1']);

  // 境界: テナント / ワークスペース分離と複製。
  await repo.save(payoutBatchFixture('batch-1', { tenant: otherWorkspace }));
  expect(ids(await repo.findActiveByClaimIds(otherWorkspace, ['claim-a']))).toEqual(['batch-1']);
  expect(await repo.list(otherTenant)).toEqual([]);
  expect(await repo.findById(otherTenant, 'batch-1')).toBeNull();
  const fetched = await repo.findById(scope, 'batch-0');
  (fetched as unknown as { lines: unknown[] }).lines.length = 0;
  expect((await repo.findById(scope, 'batch-0'))?.lines).toHaveLength(1);
}
