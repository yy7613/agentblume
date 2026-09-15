import { describe, expect, it } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, itemFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { cardImportFixture, cardTransactionFixture, FIXTURE_CARD_IDS, fixtureCardSettings, fixtureEmployees, V9_AT } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseCardTransactionNotFoundError, ExpenseClaimNotFoundError, ExpenseItemNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { CardTransactionsUseCase } from './card-transactions';

const auto = (claimId: string, itemId: string) => ({ claimId, itemId, kind: 'reimbursement-item' as const, strength: 'strong' as const, dateDiffDays: 0, amountDiff: 0, manual: false, at: V9_AT });

async function setup(): Promise<{ ctx: MoneyTestContext; usecase: CardTransactionsUseCase }> {
  const ctx = moneyTestContext();
  for (const employee of fixtureEmployees()) await ctx.employees.save(employee);
  await ctx.settings.save(scope, 'cards', fixtureCardSettings());
  await ctx.claims.save(claimFixture('c1', { items: [itemFixture('item-1'), itemFixture('item-2', { transactionDate: undefined, amount: undefined, payeeName: undefined }), itemFixture('item-3', { corporatePayment: true, amount: 3000 })] }), new Map());
  await ctx.cards.saveImport(cardImportFixture('import-1'), [
    cardTransactionFixture('tx-open', { usedOn: '2026-09-12' }),
    cardTransactionFixture('tx-matched', { status: 'matched', match: auto('c1', 'item-1') }),
    cardTransactionFixture('tx-shared', { cardId: FIXTURE_CARD_IDS.shared, usedOn: '2026-09-05', amount: 700, importId: 'import-missing' }),
  ]);
  return { ctx, usecase: new CardTransactionsUseCase(ctx.deps) };
}

describe('CardTransactionsUseCase.list', () => {
  it('正常: カードのラベル・下 4 桁・保有者名・申請者・申請の状態・取込ファイル名を足す（取込が無ければ取込 id）', async () => {
    const { usecase } = await setup();
    const views = await usecase.list(scope);
    expect(views.map((view) => view.id)).toEqual(['tx-open', 'tx-matched', 'tx-shared']);
    expect(views[1]).toMatchObject({ cardLabel: '営業用カード', cardLast4: '1111', holder: 'テスト太郎', claimant: 'テスト太郎', claimStatus: 'draft', importFile: 'card-statement-generic.csv' });
    expect(views[2]).toMatchObject({ cardLabel: '共用カード', importFile: 'import-missing' });
    expect(views[2]?.holder).toBeUndefined();
    expect((views[0] as unknown as Record<string, unknown>)['tenant']).toBeUndefined();
    expect((await usecase.list(scope, { status: 'matched' })).map((view) => view.id)).toEqual(['tx-matched']);
    expect(await usecase.list(scope, { from: '2027-01-01' })).toEqual([]);
  });

  it('正常: 設定に無いカードの利用は id をラベルにする', async () => {
    const { ctx, usecase } = await setup();
    await ctx.settings.save(scope, 'cards', { cards: [], profiles: [], updatedAt: V9_AT });
    expect((await usecase.list(scope, { cardId: FIXTURE_CARD_IDS.sales }))[0]).toMatchObject({ cardLabel: 'card-sales', cardLast4: '' });
  });
});

describe('CardTransactionsUseCase: 対象外・紐付け', () => {
  it('正常: 未照合を対象外にし（理由・誰が・いつ）、取り消すと未照合に戻る', async () => {
    const { ctx, usecase } = await setup();
    const excluded = await usecase.exclude(scope, 'tx-open', '私用分を立替済み', 'keiri');
    expect(excluded).toMatchObject({ status: 'excluded', exclusion: { reason: '私用分を立替済み', by: 'keiri', at: '2026-09-20T03:00:00.000Z' } });
    await expect(usecase.exclude(scope, 'tx-open', '再度', 'keiri')).rejects.toThrow(ExpenseTransitionError);
    const included = await usecase.include(scope, 'tx-open');
    expect(included.status).toBe('unmatched');
    expect(included.exclusion).toBeUndefined();
    expect((await ctx.cards.findTransaction(scope, 'tx-open'))?.status).toBe('unmatched');
    await expect(usecase.include(scope, 'tx-open')).rejects.toThrow(ExpenseTransitionError);
  });

  it('異常: 照合済みは対象外にできず（先に解除）、無い利用は 404', async () => {
    const { usecase } = await setup();
    await expect(usecase.exclude(scope, 'tx-matched', '私用', 'k')).rejects.toMatchObject({ blockingReasons: [{ code: 'card-transaction-matched', params: { cardTransactionId: 'tx-matched', claimId: 'c1' } }] });
    await expect(usecase.exclude(scope, 'tx-missing', '私用', 'k')).rejects.toThrow(ExpenseCardTransactionNotFoundError);
  });

  it('正常: 手動で紐付けると照合済み（manual）になり、種類・強さ・日付差・金額差を計算する。解除で未照合に戻る', async () => {
    const { usecase } = await setup();
    const linked = await usecase.link(scope, 'tx-open', { claimId: 'c1', itemId: 'item-3' }, 'keiri');
    expect(linked.match).toMatchObject({ claimId: 'c1', itemId: 'item-3', kind: 'corporate-item', strength: 'weak', dateDiffDays: 2, amountDiff: 200, manual: true, by: 'keiri' });
    const noFacts = await usecase.link(scope, 'tx-shared', { claimId: 'c1', itemId: 'item-2' }, 'keiri');
    expect(noFacts.match).toMatchObject({ kind: 'reimbursement-item', strength: 'weak', dateDiffDays: 0, amountDiff: 0 });
    const unlinked = await usecase.unlink(scope, 'tx-open');
    expect(unlinked.status).toBe('unmatched');
    await expect(usecase.unlink(scope, 'tx-open')).rejects.toThrow(ExpenseTransitionError);
  });

  it('異常: 他のカード利用に照合済みの明細・対象外の利用・無い申請や明細には紐付けない', async () => {
    const { usecase } = await setup();
    await expect(usecase.link(scope, 'tx-open', { claimId: 'c1', itemId: 'item-1' }, 'k')).rejects.toMatchObject({ blockingReasons: [{ code: 'card-item-matched', params: expect.objectContaining({ cardTransactionId: 'tx-matched' }) }] });
    await usecase.exclude(scope, 'tx-shared', '年会費', 'k');
    await expect(usecase.link(scope, 'tx-shared', { claimId: 'c1', itemId: 'item-3' }, 'k')).rejects.toThrow(ExpenseTransitionError);
    await expect(usecase.link(scope, 'tx-open', { claimId: 'c-missing', itemId: 'item-1' }, 'k')).rejects.toThrow(ExpenseClaimNotFoundError);
    await expect(usecase.link(scope, 'tx-open', { claimId: 'c1', itemId: 'item-9' }, 'k')).rejects.toThrow(ExpenseItemNotFoundError);
    // 照合済みの利用を同じ明細へ付け直すのは許す。
    expect((await usecase.link(scope, 'tx-matched', { claimId: 'c1', itemId: 'item-1' }, 'k')).match?.manual).toBe(true);
  });
});
