import { describe, expect, it, vi } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, itemFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { cardImportFixture, cardTransactionFixture, FIXTURE_CARD_IDS, FIXTURE_EMPLOYEE_IDS, fixtureCardSettings, V9_AT } from '../../../adapters/storage/expense-v9.fixtures';
import { MatchCardTransactionsUseCase } from './match-card-transactions';

const TARO = { name: 'テスト太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro };
const approval = { by: 'shonin', at: '2026-09-15T00:00:00.000Z' };
const manual = (claimId: string, itemId: string) => ({ claimId, itemId, kind: 'reimbursement-item' as const, strength: 'strong' as const, dateDiffDays: 0, amountDiff: 0, manual: true, at: V9_AT });

async function setup(): Promise<MoneyTestContext> {
  const ctx = moneyTestContext();
  await ctx.settings.save(scope, 'cards', fixtureCardSettings());
  await ctx.claims.save(claimFixture('c-reimburse', {
    claimant: TARO, status: 'approved', approval,
    items: [itemFixture('item-1', { payeeName: 'サンプルマート 霞が関店', amount: 3200 }), itemFixture('item-2', { payeeName: 'サンプル書店', amount: 800, transactionDate: '2026-09-18' })],
  }), new Map());
  await ctx.claims.save(claimFixture('c-corporate', { claimant: TARO, items: [itemFixture('item-1', { payeeName: 'サンプルホテル', amount: 12000, transactionDate: '2026-09-12', corporatePayment: true })] }), new Map());
  await ctx.cards.saveImport(cardImportFixture('import-1'), [
    cardTransactionFixture('tx-double', { usedOn: '2026-09-11' }),
    cardTransactionFixture('tx-hotel', { cardId: FIXTURE_CARD_IDS.shared, usedOn: '2026-09-12', amount: 12000, merchantRaw: 'サンプルホテル' }),
    cardTransactionFixture('tx-unclaimed', { usedOn: '2026-09-20', amount: 999, merchantRaw: 'サンプル珈琲' }),
    cardTransactionFixture('tx-excluded', { usedOn: '2026-09-21', amount: 5000, merchantRaw: '年会費', status: 'excluded', exclusion: { reason: '年会費', by: 'k', at: V9_AT } }),
    cardTransactionFixture('tx-manual', { usedOn: '2026-09-17', amount: 800, merchantRaw: '書店（手入力）', status: 'matched', match: manual('c-reimburse', 'item-2') }),
  ]);
  return ctx;
}

describe('MatchCardTransactionsUseCase', () => {
  it('正常: 立替と一致（二重計上の疑い）・会社払いと一致・未照合を保存し、対象外と手動の紐付けは保つ', async () => {
    const ctx = await setup();
    const result = await new MatchCardTransactionsUseCase(ctx.deps).execute(scope, {}, 'keiri');
    expect(result).toEqual({ matched: 2, reimbursementMatches: 1, unmatched: 1, kept: 2 });
    const byId = new Map((await ctx.cards.listTransactions(scope)).map((transaction) => [transaction.id, transaction]));
    expect(byId.get('tx-double')).toMatchObject({ status: 'matched', match: { claimId: 'c-reimburse', itemId: 'item-1', kind: 'reimbursement-item', strength: 'strong', dateDiffDays: 1, manual: false, by: 'keiri' } });
    expect(byId.get('tx-hotel')?.match).toMatchObject({ claimId: 'c-corporate', kind: 'corporate-item' });
    expect(byId.get('tx-unclaimed')?.status).toBe('unmatched');
    expect(byId.get('tx-excluded')?.status).toBe('excluded');
    expect(byId.get('tx-manual')?.match).toMatchObject({ itemId: 'item-2', manual: true });
  });

  it('正常: やり直しで結果が同じなら保存しない。申請の明細が消えた照合は未照合に戻す', async () => {
    const ctx = await setup();
    const usecase = new MatchCardTransactionsUseCase(ctx.deps);
    await usecase.execute(scope, {}, 'keiri');
    const save = vi.spyOn(ctx.cards, 'saveTransactions');
    await usecase.execute(scope, {}, 'keiri');
    expect(save).not.toHaveBeenCalled();
    await ctx.claims.delete(scope, 'c-corporate');
    expect(await usecase.execute(scope, {}, 'keiri')).toMatchObject({ matched: 1, unmatched: 2 });
    expect((await ctx.cards.findTransaction(scope, 'tx-hotel'))?.status).toBe('unmatched');
  });

  it('境界: 期間を指定すると期間のカード利用だけを照合し、期間の外の照合が持つ明細は取り直さない', async () => {
    const ctx = await setup();
    await ctx.cards.saveImport(cardImportFixture('import-0', { fileSha256: 'e'.repeat(64), periodFrom: '2026-09-01', periodTo: '2026-09-09' }), [
      cardTransactionFixture('tx-earlier', { importId: 'import-0', usedOn: '2026-09-09', merchantRaw: 'サンプルマート霞が関', status: 'matched', match: { ...manual('c-reimburse', 'item-1'), manual: false, kind: 'reimbursement-item' } }),
    ]);
    const result = await new MatchCardTransactionsUseCase(ctx.deps).execute(scope, { from: '2026-09-10', to: '2026-09-15' }, 'keiri');
    expect(result).toEqual({ matched: 1, reimbursementMatches: 0, unmatched: 1, kept: 0 });
    expect((await ctx.cards.findTransaction(scope, 'tx-double'))?.status).toBe('unmatched');
    expect((await ctx.cards.findTransaction(scope, 'tx-earlier'))?.match?.itemId).toBe('item-1');
  });

  it('境界: 対象のカード利用が無ければ何もしない', async () => {
    const ctx = moneyTestContext();
    expect(await new MatchCardTransactionsUseCase(ctx.deps).execute(scope, { from: '2026-01-01', to: '2026-01-31' }, 'k')).toEqual({ matched: 0, reimbursementMatches: 0, unmatched: 0, kept: 0 });
  });
});
