import { describe, expect, it } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, itemFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { advanceFixture, FIXTURE_EMPLOYEE_IDS } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseAdvanceNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { SettleExpenseAdvanceUseCase } from './settle-advance';

const HANAKO = { name: 'テスト花子', employeeId: FIXTURE_EMPLOYEE_IDS.hanako };
const approval = { by: 'shonin', at: '2026-09-15T00:00:00.000Z' };

async function setup(claimAmounts: readonly number[], extra: { readonly checked?: boolean; readonly settled?: boolean } = {}): Promise<MoneyTestContext> {
  const ctx = moneyTestContext();
  await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
  for (const [index, amount] of claimAmounts.entries()) {
    await ctx.claims.save(claimFixture(`c${index + 1}`, { advanceId: 'adv-paid', claimant: HANAKO, status: 'approved', approval, items: [itemFixture('item-1', { amount })] }), new Map());
  }
  if (extra.checked === true) await ctx.claims.save(claimFixture('c-checked', { advanceId: 'adv-paid', claimant: HANAKO, status: 'checked' }), new Map());
  if (extra.settled === true) {
    await ctx.claims.save(claimFixture('c-settled', { advanceId: 'adv-paid', claimant: HANAKO, status: 'settled', approval, settlement: { settledAt: approval.at, by: 'k' }, items: [itemFixture('item-1', { amount: 1000 })] }), new Map());
  }
  return ctx;
}

describe('SettleExpenseAdvanceUseCase', () => {
  it('正常: 事前計算は状態を変えずに差額と向き・申請の要約を返す', async () => {
    const ctx = await setup([3200, 6800]);
    const preview = await new SettleExpenseAdvanceUseCase(ctx.deps).preview(scope, 'adv-paid');
    expect(preview).toMatchObject({ claimsTotal: 10000, difference: -20000, direction: 'refund', blockers: [] });
    expect(preview.claims.map((claim) => [claim.id, claim.reimbursableAmount, claim.employeeId, claim.claimantName, claim.journalLinked])).toEqual([
      ['c1', 3200, FIXTURE_EMPLOYEE_IDS.hanako, 'テスト花子', 'none'], ['c2', 6800, FIXTURE_EMPLOYEE_IDS.hanako, 'テスト花子', 'none'],
    ].sort((left, right) => String(right[0]).localeCompare(String(left[0]))).reverse());
    expect((await ctx.advances.findById(scope, 'adv-paid'))?.status).toBe('paid');
  });

  it('正常: 差額 0 は精算済み（精算日 = 業務日付）で、紐付く申請を advance:<id> で精算済みにする（同じトランザクション）', async () => {
    const ctx = await setup([10000, 20000]);
    const result = await new SettleExpenseAdvanceUseCase(ctx.deps).settle(scope, 'adv-paid', 'keiri');
    expect(result.advance).toMatchObject({ status: 'settled', settlement: { claimsTotal: 30000, difference: 0, settledOn: '2026-09-20' } });
    expect(result.claims.map((claim) => [claim.id, claim.status, claim.settlement?.exportFileName])).toEqual(expect.arrayContaining([['c1', 'settled', 'advance:adv-paid'], ['c2', 'settled', 'advance:adv-paid']]));
    expect((await ctx.claims.findById(scope, 'c1'))?.status).toBe('settled');
    expect((await ctx.advances.findById(scope, 'adv-paid'))?.status).toBe('settled');
    expect(ctx.unitOfWork.transactions).toBe(1);
  });

  it('正常: 差額が正なら追加支給待ち、負なら返金待ち（精算中）。精算済みの申請はそのまま含める', async () => {
    const extra = await setup([32000]);
    expect((await new SettleExpenseAdvanceUseCase(extra.deps).settle(scope, 'adv-paid', 'k')).advance).toMatchObject({ status: 'settling', settlement: { additionalPayment: { amount: 2000, status: 'pending' } } });
    const refund = await setup([5000], { settled: true });
    const result = await new SettleExpenseAdvanceUseCase(refund.deps).settle(scope, 'adv-paid', 'k');
    expect(result.advance).toMatchObject({ status: 'settling', settlement: { claimsTotal: 6000, refund: { amount: 24000 } } });
    expect(result.claims.find((claim) => claim.id === 'c-settled')?.settlement?.exportFileName).toBeUndefined();
  });

  it('異常: 未承認の申請が残っていれば精算できず、仮払も申請も変えない。仮払が無ければ 404', async () => {
    const ctx = await setup([1000], { checked: true });
    const settle = new SettleExpenseAdvanceUseCase(ctx.deps);
    expect((await settle.preview(scope, 'adv-paid')).blockers.map((blocker) => blocker.code)).toEqual(['advance-claim-not-approved']);
    await expect(settle.settle(scope, 'adv-paid', 'k')).rejects.toThrow(ExpenseTransitionError);
    expect((await ctx.advances.findById(scope, 'adv-paid'))?.status).toBe('paid');
    expect((await ctx.claims.findById(scope, 'c1'))?.status).toBe('approved');
    await expect(settle.preview(scope, 'adv-missing')).rejects.toThrow(ExpenseAdvanceNotFoundError);
  });
});
