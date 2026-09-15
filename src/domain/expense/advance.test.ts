import { describe, expect, it } from 'vitest';
import { createExpenseAdvance, isAdvanceOverdue, type CreateExpenseAdvanceProps, type ExpenseAdvance } from './advance';

const AT = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const approval = { by: 'boss', at: AT, proxy: false };
const payment = { paidOn: '2026-09-01', method: 'transfer' as const, by: 'keiri', at: AT };

function advance(overrides: Partial<CreateExpenseAdvanceProps> = {}): ExpenseAdvance {
  return createExpenseAdvance({ tenant, id: 'adv-1', employeeId: 'emp-1', employeeSnapshot: { name: 'テスト太郎' }, purpose: ' 大阪出張 ', amount: 50000, neededOn: '2026-09-01', plannedSettleBy: '2026-09-30', submittedBy: 'keiri', createdAt: AT, updatedAt: AT, ...overrides });
}

describe('createExpenseAdvance', () => {
  it('正常: 既定は requested。makeId で id を作る', () => {
    const { id: _id, ...props } = { tenant, id: 'x', employeeId: 'emp-1', employeeSnapshot: { name: 'テスト太郎', departmentId: 'sales' }, purpose: '出張', amount: 1, neededOn: '2026-09-01', plannedSettleBy: '2026-09-01', submittedBy: 'k', createdAt: AT, updatedAt: AT };
    const value = createExpenseAdvance(props, () => 'generated');
    expect(value).toMatchObject({ id: 'generated', status: 'requested', purpose: '出張', history: [], employeeSnapshot: { departmentId: 'sales' } });
    expect(advance().purpose).toBe('大阪出張');
  });

  it('正常: 差額が正なら追加支給、負なら返金を持てる（差額は申請合計 − 仮払額）', () => {
    const additional = advance({ status: 'settling', approval, payment, settlement: { computedAt: AT, claimIds: ['c1'], claimsTotal: 60000, difference: 10000, additionalPayment: { amount: 10000, status: 'pending' } } });
    expect(additional.settlement?.additionalPayment).toEqual({ amount: 10000, status: 'pending' });
    const refund = advance({ status: 'settled', approval, payment, settlement: { computedAt: AT, claimIds: [], claimsTotal: 0, difference: -50000, refund: { amount: 50000, receivedOn: '2026-09-20', by: 'keiri' }, settledOn: '2026-09-20' }, journalLink: { paymentEntryId: 'je-1', warnings: [] }, history: [{ type: 'settled', at: AT, proxy: false }] });
    expect(refund).toMatchObject({ status: 'settled', settlement: { refund: { amount: 50000 } }, journalLink: { paymentEntryId: 'je-1' } });
    expect(advance({ status: 'cancelled', cancel: { by: 'keiri', at: AT, note: '中止' } }).cancel?.note).toBe('中止');
  });

  it('異常: 状態ごとに要る記録（承認・支払・精算・精算日・取消）', () => {
    expect(() => advance({ status: 'approved' })).toThrow(/must have an approval/u);
    expect(() => advance({ status: 'paid', approval })).toThrow(/must have a payment/u);
    expect(() => advance({ status: 'settling', approval, payment })).toThrow(/must have a settlement/u);
    expect(() => advance({ status: 'settled', approval, payment, settlement: { computedAt: AT, claimIds: [], claimsTotal: 50000, difference: 0 } })).toThrow(/settledOn/u);
    expect(() => advance({ status: 'cancelled' })).toThrow(/cancel note/u);
    expect(() => advance({ status: 'lost' as never })).toThrow(/status must be one of/u);
  });

  it('異常: 差額の整合・追加支給と返金の向き・金額と日付', () => {
    const settle = (settlement: Record<string, unknown>) => advance({ status: 'settling', approval, payment, settlement: { computedAt: AT, claimIds: [], ...settlement } as never });
    expect(() => settle({ claimsTotal: 60000, difference: 1 })).toThrow(/difference must equal/u);
    expect(() => settle({ claimsTotal: 40000, difference: -10000, additionalPayment: { amount: 10000, status: 'pending' } })).toThrow(/positive difference only/u);
    expect(() => settle({ claimsTotal: 60000, difference: 10000, refund: { amount: 10000 } })).toThrow(/negative difference only/u);
    expect(() => settle({ claimsTotal: 60000, difference: 10000, additionalPayment: { amount: 10000, status: 'sent' } })).toThrow(/status must be one of/u);
    expect(() => settle({ claimIds: Array.from({ length: 21 }, (_, index) => `c${index}`), claimsTotal: 50000, difference: 0 })).toThrow(/at most 20/u);
    expect(() => advance({ amount: 0 })).toThrow(/amount/u);
    expect(() => advance({ amount: 10_000_001 })).toThrow(/amount/u);
    expect(() => advance({ plannedSettleBy: '2026-08-31' })).toThrow(/must not be before neededOn/u);
    expect(() => advance({ neededOn: '2026/09/01' })).toThrow(/YYYY-MM-DD/u);
    expect(() => advance({ purpose: '' })).toThrow(/purpose/u);
    expect(() => advance({ status: 'paid', approval, payment: { ...payment, method: 'check' as never } })).toThrow(/payment.method/u);
    expect(() => advance({ approval: { by: 'boss', at: AT } as never })).toThrow(/approval.proxy/u);
    expect(() => advance({ journalLink: { warnings: [1] } as never })).toThrow(/journalLink.warnings/u);
    expect(() => advance({ history: [{ type: 'moved', at: AT }] as never })).toThrow(/history\[0\].type/u);
    expect(() => advance({ employeeSnapshot: null as never })).toThrow(/employeeSnapshot must be an object/u);
    expect(() => createExpenseAdvance(null as never)).toThrow(/props are required/u);
  });

  it('境界: 期限切れは支払済み・精算中で精算予定日を過ぎたときだけ（当日は切れていない）', () => {
    expect(isAdvanceOverdue({ status: 'paid', plannedSettleBy: '2026-09-30' }, '2026-09-30')).toBe(false);
    expect(isAdvanceOverdue({ status: 'paid', plannedSettleBy: '2026-09-30' }, '2026-10-01')).toBe(true);
    expect(isAdvanceOverdue({ status: 'settling', plannedSettleBy: '2026-09-30' }, '2026-10-01')).toBe(true);
    expect(isAdvanceOverdue({ status: 'settled', plannedSettleBy: '2026-09-30' }, '2026-10-01')).toBe(false);
  });
});
