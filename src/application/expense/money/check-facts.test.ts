import { describe, expect, it } from 'vitest';
import { moneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, itemFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { advanceFixture, cardImportFixture, cardTransactionFixture, fixtureCardSettings, V9_AT } from '../../../adapters/storage/expense-v9.fixtures';
import { createExpenseAdvance } from '../../../domain/expense/advance';
import { defaultExpensePolicy } from '../../../domain/expense/default-policy';
import { createExpensePolicy } from '../../../domain/expense/policy';
import { addDays, MoneyCheckFactsProvider } from './check-facts';

const policy = defaultExpensePolicy();
const acceptPolicy = createExpensePolicy({ ...policy, card: { ...policy.card, acceptCorporatePaymentItems: true } });
const match = (claimId: string, itemId: string, manual: boolean) => ({ claimId, itemId, kind: 'reimbursement-item' as const, strength: 'strong' as const, dateDiffDays: 0, amountDiff: 0, manual, at: V9_AT });

describe('MoneyCheckFactsProvider', () => {
  it('正常: 仮払の紐付けもカードの登録も無ければ事実を集めない（MVP と同じ判定）', async () => {
    const ctx = moneyTestContext();
    const provider = new MoneyCheckFactsProvider(ctx.deps);
    expect(await provider.gather(scope, claimFixture('c1'), policy, '2026-09-20')).toEqual({});
    // 明細はあってもカードが 1 枚も無ければ照合しない。
    await ctx.cards.saveImport(cardImportFixture('import-1'), [cardTransactionFixture('tx-1')]);
    expect(await provider.gather(scope, claimFixture('c1'), policy, '2026-09-20')).toEqual({});
  });

  it('正常: 紐付けた仮払の要約（従業員・状態・精算日・精算に含めた申請）を集め、見つからなければ集めない', async () => {
    const ctx = moneyTestContext();
    const provider = new MoneyCheckFactsProvider(ctx.deps);
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await ctx.advances.save(advanceFixture('adv-settled', 'settled'));
    const paid = advanceFixture('adv-x', 'paid');
    await ctx.advances.save(createExpenseAdvance({ ...paid, id: 'adv-settling', status: 'settling', settlement: { computedAt: '2026-09-21T00:00:00.000Z', claimIds: ['c0'], claimsTotal: 20000, difference: -10000, refund: { amount: 10000 } } }));

    expect(await provider.gather(scope, claimFixture('c1', { advanceId: 'adv-paid' }), policy, '2026-09-20')).toEqual({ money: { advance: { id: 'adv-paid', employeeId: 'emp-hanako', employeeName: 'テスト花子', status: 'paid', settledClaimIds: [] } } });
    expect((await provider.gather(scope, claimFixture('c1', { advanceId: 'adv-settled' }), policy, '2026-09-20')).money?.advance).toMatchObject({ status: 'settled', settledOn: '2026-09-20', settledClaimIds: ['claim-advance-1'] });
    expect((await provider.gather(scope, claimFixture('c1', { advanceId: 'adv-settling' }), policy, '2026-09-20')).money?.advance).toMatchObject({ status: 'settling', settledOn: '2026-09-21' });
    expect(await provider.gather(scope, claimFixture('c1', { advanceId: 'adv-missing', items: [] }), policy, '2026-09-20')).toEqual({});
  });

  it('正常: カード利用は「未照合・この申請に照合済み」だけを渡し、他の申請に照合済み・対象外・範囲外は渡さない。手動の紐付けは明細 id を添える', async () => {
    const ctx = moneyTestContext();
    await ctx.settings.save(scope, 'cards', fixtureCardSettings());
    await ctx.cards.saveImport(cardImportFixture('import-1'), [
      cardTransactionFixture('tx-open'),
      cardTransactionFixture('tx-edge', { usedOn: '2026-09-13', amount: 3200 }),
      cardTransactionFixture('tx-far', { usedOn: '2026-09-14', amount: 3200 }),
      cardTransactionFixture('tx-amount', { amount: 3201 }),
      cardTransactionFixture('tx-excluded', { amount: 3200, usedOn: '2026-09-11', status: 'excluded', exclusion: { reason: '私用', by: 'k', at: V9_AT } }),
      cardTransactionFixture('tx-other', { usedOn: '2026-09-09', status: 'matched', match: match('c-other', 'item-1', false) }),
      cardTransactionFixture('tx-auto', { usedOn: '2026-09-08', status: 'matched', match: match('c1', 'item-1', false) }),
      cardTransactionFixture('tx-manual', { usedOn: '2026-09-07', status: 'matched', match: match('c1', 'item-1', true) }),
    ]);
    const facts = await new MoneyCheckFactsProvider(ctx.deps).gather(scope, claimFixture('c1', { items: [itemFixture('item-1'), itemFixture('item-2', { amount: undefined })] }), policy, '2026-09-20');
    expect(facts.money?.card?.transactions.map((transaction) => [transaction.id, transaction.manualItemId])).toEqual([
      ['tx-manual', 'item-1'], ['tx-auto', undefined], ['tx-open', undefined], ['tx-edge', undefined],
    ]);
    expect(facts.money?.card?.cards.map((card) => [card.id, card.holderEmployeeId])).toEqual([['card-sales', 'emp-taro'], ['card-shared', undefined]]);
    // 会社払いを受け入れない運用では取込範囲を読まない。
    expect(facts.money?.card?.coverage).toEqual([]);
    expect(facts.money?.advance).toBeUndefined();
  });

  it('正常: 会社払いの明細を受け入れる運用で会社払いの明細があれば、取込範囲も渡す', async () => {
    const ctx = moneyTestContext();
    await ctx.settings.save(scope, 'cards', fixtureCardSettings());
    await ctx.cards.saveImport(cardImportFixture('import-1'), []);
    const facts = await new MoneyCheckFactsProvider(ctx.deps).gather(scope, claimFixture('c1', { items: [itemFixture('item-1', { corporatePayment: true })] }), acceptPolicy, '2026-09-20');
    expect(facts.money?.card?.coverage).toEqual([{ cardId: 'card-sales', from: '2026-09-01', to: '2026-09-30' }]);
    expect(facts.money?.card?.transactions).toEqual([]);
  });

  it('境界: addDays は月・年をまたぐ', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});
