import { describe, expect, it } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, itemFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { advanceFixture, FIXTURE_EMPLOYEE_IDS, fixtureEmployees, fixtureOrganization } from '../../../adapters/storage/expense-v9.fixtures';
import type { ExpenseClaim } from '../../../domain/expense/claim';
import { defaultExpensePolicy } from '../../../domain/expense/default-policy';
import { ExpenseAdvanceNotFoundError, ExpenseClaimNotFoundError, ExpenseDomainError, ExpenseEmployeeNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { createExpensePolicy } from '../../../domain/expense/policy';
import { LinkClaimAdvanceUseCase, ManageExpenseAdvancesUseCase, summaryReimbursableAmount } from './manage-advances';

const HANAKO = { name: 'テスト花子', employeeId: FIXTURE_EMPLOYEE_IDS.hanako };
const approval = { by: 'shonin', at: '2026-09-15T00:00:00.000Z' };

async function setup(now?: string): Promise<{ ctx: MoneyTestContext; advances: ManageExpenseAdvancesUseCase }> {
  const ctx = moneyTestContext(now === undefined ? {} : { now });
  for (const employee of fixtureEmployees()) await ctx.employees.save(employee);
  await ctx.settings.save(scope, 'organization', fixtureOrganization());
  let sequence = 0;
  return { ctx, advances: new ManageExpenseAdvancesUseCase(ctx.deps, () => { sequence += 1; return `adv-${sequence}`; }) };
}

async function saveClaim(ctx: MoneyTestContext, claim: ExpenseClaim): Promise<void> {
  await ctx.claims.save(claim, new Map());
}

describe('ManageExpenseAdvancesUseCase', () => {
  it('正常: 従業員マスタの有効な従業員に仮払を申請でき、写しと部門名を持つ', async () => {
    const { ctx, advances } = await setup();
    const created = await advances.create(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.taro, purpose: '大阪出張', amount: 30000, neededOn: '2026-09-25', plannedSettleBy: '2026-10-10' }, 'taro@example.com');
    expect(created).toMatchObject({ id: 'adv-1', status: 'requested', employeeSnapshot: { name: 'テスト太郎', departmentId: 'dept-sales' }, createdAt: '2026-09-20T03:00:00.000Z' });
    expect(await ctx.advances.findById(scope, 'adv-1')).toEqual(created);
    expect(await advances.view(scope, created)).toMatchObject({ department: '営業部', linkedClaimCount: 0, linkedClaimTotal: 0, overdue: false });
  });

  it('異常: 従業員がいなければ 404、無効な従業員なら入力エラー', async () => {
    const { advances } = await setup();
    const input = { purpose: 'x', amount: 1, neededOn: '2026-09-25', plannedSettleBy: '2026-10-10' };
    await expect(advances.create(scope, { ...input, employeeId: 'emp-nobody' }, 'u')).rejects.toThrow(ExpenseEmployeeNotFoundError);
    await expect(advances.create(scope, { ...input, employeeId: FIXTURE_EMPLOYEE_IDS.shiro }, 'u')).rejects.toThrow(ExpenseDomainError);
  });

  it('正常: 一覧は紐付く申請の件数と支払う額の合計・期限切れを足し、状態と従業員で絞れる', async () => {
    const { ctx, advances } = await setup('2026-10-01T03:00:00.000Z');
    await ctx.advances.save(advanceFixture('adv-requested', 'requested'));
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await saveClaim(ctx, claimFixture('c1', { advanceId: 'adv-paid', claimant: HANAKO }));
    await saveClaim(ctx, claimFixture('c2', { advanceId: 'adv-paid', claimant: HANAKO, items: [itemFixture('item-1', { amount: 1000 }), itemFixture('item-2', { amount: 500, corporatePayment: true })] }));
    const all = await advances.list(scope);
    const paid = all.find((advance) => advance.id === 'adv-paid');
    expect(paid).toMatchObject({ linkedClaimCount: 2, linkedClaimTotal: 4700, overdue: true, department: '営業部' });
    expect((paid as unknown as Record<string, unknown>)['tenant']).toBeUndefined();
    expect(all.find((advance) => advance.id === 'adv-requested')?.overdue).toBe(false);
    expect((await advances.list(scope, { status: 'paid' })).map((advance) => advance.id)).toEqual(['adv-paid']);
    expect((await advances.list(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.taro })).map((advance) => advance.id)).toEqual(['adv-requested']);
    // 会社払いの明細を受け入れる運用なら会社払いを除く。
    const base = defaultExpensePolicy();
    await ctx.policies.save(scope, createExpensePolicy({ ...base, card: { ...base.card, acceptCorporatePaymentItems: true } }));
    expect((await advances.list(scope, { status: 'paid' }))[0]?.linkedClaimTotal).toBe(4200);
    expect(summaryReimbursableAmount({ totalAmount: 10, corporatePaymentAmount: 3 }, base)).toBe(10);
  });

  it('正常: 詳細は仮払と紐付く申請の要約。無ければ 404', async () => {
    const { ctx, advances } = await setup();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await saveClaim(ctx, claimFixture('c1', { advanceId: 'adv-paid', claimant: HANAKO }));
    const detail = await advances.get(scope, 'adv-paid');
    expect(detail.advance.id).toBe('adv-paid');
    expect(detail.claims.map((claim) => claim.id)).toEqual(['c1']);
    await expect(advances.get(scope, 'adv-missing')).rejects.toThrow(ExpenseAdvanceNotFoundError);
  });

  it('正常: 申請 → 編集 → 承認 → 支払済み → 支払取消 → 支払済み の遷移を保存する', async () => {
    const { ctx, advances } = await setup();
    const created = await advances.create(scope, { employeeId: FIXTURE_EMPLOYEE_IDS.taro, purpose: '大阪出張', amount: 30000, neededOn: '2026-09-25', plannedSettleBy: '2026-10-10' }, 'taro');
    await advances.edit(scope, created.id, { purpose: '大阪出張（2 泊）', amount: 40000, neededOn: '2026-09-25', plannedSettleBy: '2026-10-10' }, 'taro');
    await expect(advances.approve(scope, created.id, { subject: 'taro@example.com', employeeId: FIXTURE_EMPLOYEE_IDS.taro })).rejects.toThrow(ExpenseTransitionError);
    const approved = await advances.approve(scope, created.id, { subject: 'jiro@example.com', employeeId: FIXTURE_EMPLOYEE_IDS.jiro }, '承認します');
    expect(approved.approval).toMatchObject({ by: 'jiro@example.com', employeeId: FIXTURE_EMPLOYEE_IDS.jiro, comment: '承認します' });
    const paid = await advances.markPaid(scope, created.id, { paidOn: '2026-09-24', method: 'cash' }, 'keiri');
    expect(paid).toMatchObject({ status: 'paid', amount: 40000, payment: { paidOn: '2026-09-24', method: 'cash' } });
    const unpaid = await advances.unpay(scope, created.id, '日付を誤った', 'keiri');
    expect(unpaid.status).toBe('approved');
    expect((await ctx.advances.findById(scope, created.id))?.status).toBe('approved');
    expect((await advances.markPaid(scope, created.id, { paidOn: '2026-09-25', method: 'transfer' }, 'keiri')).status).toBe('paid');
  });

  it('異常: 紐付く申請がある仮払は支払取消できない。取消は支払前だけ', async () => {
    const { ctx, advances } = await setup();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await saveClaim(ctx, claimFixture('c1', { advanceId: 'adv-paid', claimant: HANAKO }));
    await expect(advances.unpay(scope, 'adv-paid', '取消', 'keiri')).rejects.toMatchObject({ blockingReasons: [expect.objectContaining({ code: 'advance-has-claims' })] });
    await expect(advances.cancel(scope, 'adv-paid', '中止', 'keiri')).rejects.toThrow(ExpenseTransitionError);
    await ctx.advances.save(advanceFixture('adv-requested', 'requested'));
    expect((await advances.cancel(scope, 'adv-requested', '出張中止', 'taro')).status).toBe('cancelled');
  });

  it('正常: 精算中の仮払で返金の受領・追加支給の支払を記録すると精算済みになる', async () => {
    const { ctx, advances } = await setup();
    const paid = advanceFixture('adv-refund', 'paid');
    const { createExpenseAdvance } = await import('../../../domain/expense/advance');
    await ctx.advances.save(createExpenseAdvance({ ...paid, status: 'settling', settlement: { computedAt: '2026-09-20T00:00:00.000Z', claimIds: [], claimsTotal: 20000, difference: -10000, refund: { amount: 10000 } } }));
    await ctx.advances.save(createExpenseAdvance({ ...paid, id: 'adv-extra', status: 'settling', settlement: { computedAt: '2026-09-20T00:00:00.000Z', claimIds: [], claimsTotal: 32000, difference: 2000, additionalPayment: { amount: 2000, status: 'pending' } } }));
    expect((await advances.refundReceived(scope, 'adv-refund', '2026-09-22', 'keiri')).status).toBe('settled');
    expect((await advances.additionalPaid(scope, 'adv-extra', { paidOn: '2026-09-23', method: 'transfer' }, 'keiri')).settlement?.additionalPayment?.status).toBe('paid');
  });
});

describe('LinkClaimAdvanceUseCase', () => {
  it('正常: 申請者本人の支払済みの仮払を紐付けると申請は draft へ戻り、外すと紐付けが消える', async () => {
    const { ctx } = await setup();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await saveClaim(ctx, claimFixture('c1', { claimant: HANAKO }));
    const link = new LinkClaimAdvanceUseCase(ctx.deps);
    const linked = await link.execute({ scope, claimId: 'c1', advanceId: 'adv-paid', by: 'keiri' });
    expect(linked).toMatchObject({ advanceId: 'adv-paid', status: 'draft' });
    expect((await ctx.claims.findById(scope, 'c1'))?.advanceId).toBe('adv-paid');
    // 同じ仮払をもう一度選んでも変えない（保存もしない）。
    expect(await link.execute({ scope, claimId: 'c1', advanceId: 'adv-paid', by: 'keiri' })).toEqual(linked);
    const unlinked = await link.execute({ scope, claimId: 'c1', advanceId: null, by: 'keiri' });
    expect(unlinked.advanceId).toBeUndefined();
    expect(unlinked.history.at(-1)?.type).toBe('advance-unlinked');
  });

  it('異常: 申請者が違う・未紐付け・支払前の仮払は、理由と次の一手を付けて断る', async () => {
    const { ctx } = await setup();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await ctx.advances.save(advanceFixture('adv-requested', 'requested'));
    await saveClaim(ctx, claimFixture('c-taro', { claimant: { name: 'テスト太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro } }));
    await saveClaim(ctx, claimFixture('c-unlinked'));
    const link = new LinkClaimAdvanceUseCase(ctx.deps);
    await expect(link.execute({ scope, claimId: 'c-taro', advanceId: 'adv-paid', by: 'k' })).rejects.toMatchObject({ blockingReasons: [expect.objectContaining({ code: 'advance-employee-mismatch' })], nextStep: expect.stringContaining('支払済みの仮払') });
    await expect(link.execute({ scope, claimId: 'c-unlinked', advanceId: 'adv-paid', by: 'k' })).rejects.toMatchObject({ nextStep: expect.stringContaining('申請者を従業員マスタから選んで') });
    await expect(link.execute({ scope, claimId: 'c-taro', advanceId: 'adv-requested', by: 'k' })).rejects.toMatchObject({ blockingReasons: [expect.objectContaining({ code: 'advance-not-paid' })] });
  });

  it('異常: 承認済みの申請は紐付けを変えられない。申請・仮払が無ければ 404', async () => {
    const { ctx } = await setup();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await saveClaim(ctx, claimFixture('c-approved', { claimant: HANAKO, status: 'approved', approval }));
    const link = new LinkClaimAdvanceUseCase(ctx.deps);
    await expect(link.execute({ scope, claimId: 'c-approved', advanceId: 'adv-paid', by: 'k' })).rejects.toThrow(ExpenseTransitionError);
    await expect(link.execute({ scope, claimId: 'c-missing', advanceId: null, by: 'k' })).rejects.toThrow(ExpenseClaimNotFoundError);
    await expect(link.execute({ scope, claimId: 'c-approved', advanceId: 'adv-missing', by: 'k' })).rejects.toThrow(ExpenseAdvanceNotFoundError);
  });
});
