import { describe, expect, it } from 'vitest';
import { createExpenseAdvance, type CreateExpenseAdvanceProps, type ExpenseAdvance } from '../advance';
import { ExpenseDomainError, ExpenseTransitionError } from '../errors';
import { previewAdvanceSettlement } from './advance-settlement';
import {
  advanceStatusLabel, approveAdvance, cancelAdvance, editAdvance, markAdvancePaid, payAdvanceAdditional, receiveAdvanceRefund, requestAdvance, settleAdvance,
  unpayAdvance, withAdvanceJournalEntry,
} from './advance-transitions';

const tenant = { tenantId: 't', workspaceId: 'w' };
const AT = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-02T00:00:00.000Z';

function requested(overrides: Partial<CreateExpenseAdvanceProps> = {}): ExpenseAdvance {
  return requestAdvance({
    tenant, id: 'adv-1', employee: { id: 'emp-taro', name: 'テスト太郎', departmentId: 'dept-sales', enabled: true },
    purpose: '大阪出張', amount: 30000, neededOn: '2026-09-05', plannedSettleBy: '2026-09-30', by: 'taro', at: AT, ...overrides,
  });
}

function paid(): ExpenseAdvance {
  return markAdvancePaid(approveAdvance(requested(), { subject: 'shonin', employeeId: 'emp-jiro' }, AT), { paidOn: '2026-09-03', method: 'cash' }, 'keiri', AT);
}

function transitionError(work: () => unknown): ExpenseTransitionError {
  try {
    work();
  } catch (error) {
    if (error instanceof ExpenseTransitionError) return error;
    throw error;
  }
  throw new Error('expected ExpenseTransitionError');
}

const claimRef = (id: string, amount: number) => ({ id, status: 'approved', reimbursableAmount: amount, employeeId: 'emp-taro' });

describe('requestAdvance / editAdvance', () => {
  it('正常: 申請すると requested で、従業員の写しと履歴を持つ', () => {
    const advance = requested();
    expect(advance).toMatchObject({ status: 'requested', employeeSnapshot: { name: 'テスト太郎', departmentId: 'dept-sales' }, submittedBy: 'taro' });
    expect(advance.history).toEqual([{ type: 'requested', by: 'taro', at: AT }]);
  });

  it('異常: 無効な従業員には出せない。精算予定日が必要日より前も断る', () => {
    expect(() => requestAdvance({ tenant, id: 'a', employee: { id: 'emp-shiro', name: '四郎', enabled: false }, purpose: 'x', amount: 1, neededOn: '2026-09-05', plannedSettleBy: '2026-09-30', by: 'u', at: AT })).toThrow(ExpenseDomainError);
    expect(() => requestAdvance({ tenant, id: 'a', employee: { id: 'e', name: 'n', enabled: true }, purpose: 'x', amount: 1, neededOn: '2026-09-05', plannedSettleBy: '2026-09-04', by: 'u', at: AT })).toThrow(ExpenseDomainError);
  });

  it('正常: 申請中は編集でき、承認後は編集できない（次の一手を返す）', () => {
    const edited = editAdvance(requested(), { purpose: '名古屋出張', amount: 20000, neededOn: '2026-09-06', plannedSettleBy: '2026-09-20' }, 'taro', LATER);
    expect(edited).toMatchObject({ purpose: '名古屋出張', amount: 20000, updatedAt: LATER });
    expect(edited.history.at(-1)?.type).toBe('edited');
    const error = transitionError(() => editAdvance(approveAdvance(requested(), { subject: 's' }, AT), { purpose: 'x', amount: 1, neededOn: '2026-09-06', plannedSettleBy: '2026-09-20' }, 'taro', LATER));
    expect(error.nextStep).toContain('承認済み');
    expect(error.blockingReasons).toEqual([{ code: 'advance-status', params: { advanceId: 'adv-1', advanceStatus: 'approved' } }]);
  });
});

describe('approveAdvance / cancelAdvance', () => {
  it('正常: 承認はコメントと承認者の従業員を記録し、代理の印は false', () => {
    const approved = approveAdvance(requested(), { subject: 'shonin', employeeId: 'emp-jiro' }, LATER, ' 了解 ');
    expect(approved.approval).toEqual({ by: 'shonin', employeeId: 'emp-jiro', at: LATER, comment: '了解', proxy: false });
    expect(approveAdvance(requested(), { subject: 'shonin' }, LATER, '  ').approval?.comment).toBeUndefined();
  });

  it('異常: 仮払を受け取る本人は承認できない（approval-claimant-self）', () => {
    const error = transitionError(() => approveAdvance(requested(), { subject: 'taro', employeeId: 'emp-taro' }, LATER));
    expect(error.blockingReasons[0]?.code).toBe('approval-claimant-self');
  });

  it('正常: 申請中・承認済みは取消でき、理由が要る。支払済みは取消できない', () => {
    expect(cancelAdvance(requested(), '出張中止', 'taro', LATER)).toMatchObject({ status: 'cancelled', cancel: { note: '出張中止' } });
    expect(cancelAdvance(approveAdvance(requested(), { subject: 's' }, AT), '中止', 'taro', LATER).status).toBe('cancelled');
    expect(transitionError(() => cancelAdvance(requested(), '  ', 'taro', LATER)).nextStep).toContain('理由');
    expect(transitionError(() => cancelAdvance(paid(), '中止', 'taro', LATER)).nextStep).toContain('支払取消');
  });
});

describe('markAdvancePaid / unpayAdvance', () => {
  it('正常: 承認済みを支払済みにし、支払日・方法を記録する。未承認は断り、日付の形が違えば入力エラー', () => {
    expect(paid()).toMatchObject({ status: 'paid', payment: { paidOn: '2026-09-03', method: 'cash', by: 'keiri' } });
    expect(() => markAdvancePaid(requested(), { paidOn: '2026-09-03', method: 'cash' }, 'k', LATER)).toThrow(ExpenseTransitionError);
    expect(() => markAdvancePaid(approveAdvance(requested(), { subject: 's' }, AT), { paidOn: '9/3', method: 'cash' }, 'k', LATER)).toThrow(ExpenseDomainError);
  });

  it('正常: 支払取消で承認済みへ戻り、支払の記録を消す', () => {
    const unpaid = unpayAdvance(paid(), '二重に記録した', 'keiri', LATER, []);
    expect(unpaid.status).toBe('approved');
    expect(unpaid.payment).toBeUndefined();
    expect(unpaid.history.at(-1)).toMatchObject({ type: 'unpaid', note: '二重に記録した' });
  });

  it('異常: 紐付く申請・支払の仕訳下書き・振込バッチがあれば、すべての理由を並べて断る', () => {
    const drafted = withAdvanceJournalEntry(markAdvancePaid(approveAdvance(requested(), { subject: 's' }, AT), { paidOn: '2026-09-03', method: 'transfer', payoutBatchId: 'batch-1' }, 'k', AT), 'payment', 'je-1', [], 'k', AT);
    const error = transitionError(() => unpayAdvance(drafted, '取消', 'keiri', LATER, ['c1', 'c2']));
    expect(error.blockingReasons.map((reason) => reason.code)).toEqual(['advance-has-claims', 'advance-journal-drafted', 'advance-in-payout']);
    expect(error.blockingReasons[0]?.params).toMatchObject({ count: 2, claimIds: 'c1、c2' });
    expect(() => unpayAdvance(paid(), '', 'keiri', LATER, [])).toThrow(ExpenseTransitionError);
    expect(() => unpayAdvance(requested(), '取消', 'keiri', LATER, [])).toThrow(ExpenseTransitionError);
  });
});

describe('settleAdvance → 返金 / 追加支給', () => {
  it('正常: 差額 0 はそのまま精算済み（精算日 = 今日）', () => {
    const settled = settleAdvance(paid(), previewAdvanceSettlement(paid(), [claimRef('c1', 30000)]), '2026-09-20', 'keiri', LATER);
    expect(settled).toMatchObject({ status: 'settled', settlement: { claimIds: ['c1'], claimsTotal: 30000, difference: 0, settledOn: '2026-09-20' } });
  });

  it('正常: 差額が正なら精算中 + 追加支給の待ち → 追加支給を支払うと精算済み', () => {
    const settling = settleAdvance(paid(), previewAdvanceSettlement(paid(), [claimRef('c1', 32000)]), '2026-09-20', 'keiri', LATER);
    expect(settling).toMatchObject({ status: 'settling', settlement: { difference: 2000, additionalPayment: { amount: 2000, status: 'pending' } } });
    const done = payAdvanceAdditional(settling, { paidOn: '2026-09-25', method: 'transfer' }, 'keiri', LATER);
    expect(done).toMatchObject({ status: 'settled', settlement: { additionalPayment: { status: 'paid', paidOn: '2026-09-25' }, settledOn: '2026-09-25' } });
    expect(transitionError(() => receiveAdvanceRefund(settling, '2026-09-25', 'keiri', LATER)).nextStep).toContain('追加支給');
  });

  it('正常: 差額が負なら精算中 + 返金の待ち → 返金を受け取ると精算済み', () => {
    const settling = settleAdvance(paid(), previewAdvanceSettlement(paid(), [claimRef('c1', 25000)]), '2026-09-20', 'keiri', LATER);
    expect(settling).toMatchObject({ status: 'settling', settlement: { difference: -5000, refund: { amount: 5000 } } });
    const done = receiveAdvanceRefund(settling, '2026-09-22', 'keiri', LATER);
    expect(done).toMatchObject({ status: 'settled', settlement: { refund: { amount: 5000, receivedOn: '2026-09-22', by: 'keiri' }, settledOn: '2026-09-22' } });
    expect(transitionError(() => payAdvanceAdditional(settling, { paidOn: '2026-09-25', method: 'cash' }, 'keiri', LATER)).nextStep).toContain('返金');
    expect(() => receiveAdvanceRefund(settling, '22日', 'keiri', LATER)).toThrow(ExpenseDomainError);
  });

  it('異常: 精算できない理由があれば blockingReasons 付きで断り、精算中でない仮払の返金・追加支給も断る', () => {
    const error = transitionError(() => settleAdvance(paid(), previewAdvanceSettlement(paid(), [{ ...claimRef('c1', 1), status: 'checked' }]), '2026-09-20', 'k', LATER));
    expect(error.blockingReasons.map((reason) => reason.code)).toEqual(['advance-claim-not-approved']);
    expect(() => settleAdvance(requested(), previewAdvanceSettlement(requested(), []), '2026-09-20', 'k', LATER)).toThrow(ExpenseTransitionError);
    expect(() => receiveAdvanceRefund(paid(), '2026-09-22', 'k', LATER)).toThrow(ExpenseTransitionError);
    expect(() => payAdvanceAdditional(paid(), { paidOn: '2026-09-22', method: 'cash' }, 'k', LATER)).toThrow(ExpenseTransitionError);
  });
});

describe('withAdvanceJournalEntry / advanceStatusLabel', () => {
  it('正常: 支払と精算の仕訳 id を別々に記録し、警告を足していく', () => {
    const base = createExpenseAdvance({ ...paid(), history: paid().history });
    const first = withAdvanceJournalEntry(base, 'payment', 'je-1', ['w1'], 'k', LATER);
    const second = withAdvanceJournalEntry(first, 'settlement', 'je-2', ['w2'], 'k', LATER);
    expect(second.journalLink).toEqual({ paymentEntryId: 'je-1', settlementEntryId: 'je-2', warnings: ['w1', 'w2'] });
    expect(second.history.at(-1)).toMatchObject({ type: 'journal-drafted', note: 'settlement: je-2' });
    expect(advanceStatusLabel('settling')).toBe('精算中');
  });
});
