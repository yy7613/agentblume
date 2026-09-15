import { describe, expect, it } from 'vitest';
import { createExpenseAdvance, type CreateExpenseAdvanceProps, type ExpenseAdvance } from '../advance';
import { advanceLinkBlockers, directionOf, previewAdvanceSettlement, type AdvanceClaimRef } from './advance-settlement';

const AT = '2026-09-01T00:00:00.000Z';
const approval = { by: 'shonin', at: AT, proxy: false };
const payment = { paidOn: '2026-09-03', method: 'transfer' as const, by: 'keiri', at: AT };

function advance(overrides: Partial<CreateExpenseAdvanceProps> = {}): ExpenseAdvance {
  return createExpenseAdvance({
    tenant: { tenantId: 't', workspaceId: 'w' }, id: 'adv-1', employeeId: 'emp-taro', employeeSnapshot: { name: 'テスト太郎' },
    purpose: '大阪出張', amount: 30000, neededOn: '2026-09-05', plannedSettleBy: '2026-09-30', status: 'paid', approval, payment,
    submittedBy: 'taro', createdAt: AT, updatedAt: AT, ...overrides,
  });
}

const claim = (id: string, reimbursableAmount: number, overrides: Partial<AdvanceClaimRef> = {}): AdvanceClaimRef => ({ id, status: 'approved', reimbursableAmount, employeeId: 'emp-taro', ...overrides });

describe('previewAdvanceSettlement', () => {
  it('正常: 差額 = 申請の合計 − 仮払額。0 は even、正は additional、負は refund', () => {
    expect(previewAdvanceSettlement(advance(), [claim('c1', 10000), claim('c2', 20000)])).toMatchObject({ claimsTotal: 30000, difference: 0, direction: 'even', blockers: [] });
    expect(previewAdvanceSettlement(advance(), [claim('c1', 32000)])).toMatchObject({ difference: 2000, direction: 'additional' });
    expect(previewAdvanceSettlement(advance(), [claim('c1', 25000, { status: 'settled' })])).toMatchObject({ difference: -5000, direction: 'refund', blockers: [] });
  });

  it('境界: 紐付く申請が 0 件なら全額返金になる', () => {
    expect(previewAdvanceSettlement(advance(), [])).toMatchObject({ claimsTotal: 0, difference: -30000, direction: 'refund', blockers: [] });
  });

  it('異常: 支払済みでない・未承認の申請・申請者が違う・21 件以上は、すべて理由として集める', () => {
    const requested = advance({ status: 'requested', approval: undefined, payment: undefined });
    const claims = [claim('c1', 100, { status: 'checked' }), claim('c2', 100, { employeeId: 'emp-hanako' }), ...Array.from({ length: 19 }, (_, index) => claim(`x${index}`, 1))];
    const codes = previewAdvanceSettlement(requested, claims).blockers.map((blocker) => blocker.code);
    expect(codes).toEqual(['advance-not-paid', 'advance-too-many-claims', 'advance-claim-not-approved', 'advance-employee-mismatch']);
  });

  it('境界: 20 件ちょうどは上限の理由を出さない', () => {
    const claims = Array.from({ length: 20 }, (_, index) => claim(`c${index}`, 1));
    expect(previewAdvanceSettlement(advance(), claims).blockers).toEqual([]);
    expect(directionOf(1)).toBe('additional');
  });
});

describe('advanceLinkBlockers', () => {
  it('正常: 申請者と仮払の従業員が同じで支払済みなら紐付けられる', () => {
    expect(advanceLinkBlockers({ id: 'c1', employeeId: 'emp-taro' }, advance(), [])).toEqual([]);
  });

  it('異常: 申請者が違う（未紐付けを含む）なら advance-employee-mismatch（仮払の従業員名を添える）', () => {
    expect(advanceLinkBlockers({ id: 'c1', employeeId: 'emp-hanako' }, advance(), [])).toEqual([{ code: 'advance-employee-mismatch', params: { advanceId: 'adv-1', advanceEmployee: 'テスト太郎', employeeId: 'emp-taro' } }]);
    expect(advanceLinkBlockers({ id: 'c1' }, advance(), []).map((blocker) => blocker.code)).toEqual(['advance-employee-mismatch']);
  });

  it('異常: 支払前は advance-not-paid、精算中・精算済みは advance-already-settled（精算日が無ければ計算日）', () => {
    expect(advanceLinkBlockers({ id: 'c1', employeeId: 'emp-taro' }, advance({ status: 'approved', payment: undefined }), [])).toEqual([{ code: 'advance-not-paid', params: { advanceId: 'adv-1', advanceStatus: 'approved' } }]);
    const settling = advance({ status: 'settling', settlement: { computedAt: '2026-09-20T01:00:00.000Z', claimIds: ['c0'], claimsTotal: 20000, difference: -10000, refund: { amount: 10000 } } });
    expect(advanceLinkBlockers({ id: 'c1', employeeId: 'emp-taro' }, settling, [])[0]).toEqual({ code: 'advance-already-settled', params: { advanceId: 'adv-1', settledOn: '2026-09-20' } });
    const settled = advance({ status: 'settled', settlement: { computedAt: '2026-09-20T01:00:00.000Z', claimIds: [], claimsTotal: 30000, difference: 0, settledOn: '2026-09-21' } });
    expect(advanceLinkBlockers({ id: 'c1', employeeId: 'emp-taro' }, settled, [])[0]?.params?.['settledOn']).toBe('2026-09-21');
  });

  it('境界: 他の申請が 20 件紐付いていれば断り、自分自身は数えない', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `c${index}`);
    expect(advanceLinkBlockers({ id: 'new', employeeId: 'emp-taro' }, advance(), twenty).map((blocker) => blocker.code)).toEqual(['advance-too-many-claims']);
    expect(advanceLinkBlockers({ id: 'c0', employeeId: 'emp-taro' }, advance(), twenty)).toEqual([]);
  });
});
