/**
 * 規程の実用化の節（docs/21 §20.2.2）: 承認経路・交通費・カード・仮払・部門の補助軸・費目の区間。
 * MVP の規程のテストは `policy.test.ts`（期待値を変えない）。
 */
import { describe, expect, it } from 'vitest';
import { defaultExpensePolicy } from './default-policy';
import { ExpenseDomainError } from './errors';
import {
  createExpensePolicy, DEFAULT_ADVANCE_POLICY_SETTINGS, DEFAULT_CARD_POLICY_SETTINGS, DEFAULT_TRANSPORT_SETTINGS, findCategory,
  validateAdvancePolicySettings, validateCardPolicySettings, validateTransportSettings,
} from './policy';

const base = defaultExpensePolicy('2026-09-14T00:00:00.000Z');

describe('初期テンプレートと既定値', () => {
  it('正常: 電車・バスだけ区間の検査が有効で、新しい節は既定値', () => {
    expect(findCategory(base, 'transport.public')?.route).toEqual({ required: true, commuterPass: true, fareTable: true });
    expect(base.categories.filter((category) => category.route !== undefined).map((category) => category.id)).toEqual(['transport.public']);
    expect(base.transport).toEqual(DEFAULT_TRANSPORT_SETTINGS);
    expect(base.card).toEqual(DEFAULT_CARD_POLICY_SETTINGS);
    expect(base.card.acceptCorporatePaymentItems).toBe(false);
    expect(base.advance).toEqual(DEFAULT_ADVANCE_POLICY_SETTINGS);
    expect(base.approval.routes).toEqual([]);
    expect(base.journal).not.toHaveProperty('departmentDimensionId');
  });
});

describe('節の検証', () => {
  it('正常: 部分的な節は既定値で補い、部門の補助軸は前後空白を除いて持つ（空文字は持たない）', () => {
    const policy = createExpensePolicy({ ...base, transport: { fareToleranceYen: 50 }, card: { dateToleranceDays: 0 }, advance: { settleWithinDays: 30, paymentAccountId: 'asset.cash' }, journal: { ...base.journal, departmentDimensionId: ' department ' } });
    expect(policy.transport).toEqual({ ...DEFAULT_TRANSPORT_SETTINGS, fareToleranceYen: 50 });
    expect(policy.card.dateToleranceDays).toBe(0);
    expect(policy.advance).toEqual({ ...DEFAULT_ADVANCE_POLICY_SETTINGS, paymentAccountId: 'asset.cash', settleWithinDays: 30 });
    expect(policy.journal.departmentDimensionId).toBe('department');
    expect(createExpensePolicy({ ...base, journal: { ...base.journal, departmentDimensionId: '' } }).journal).not.toHaveProperty('departmentDimensionId');
  });

  it('境界: 許容差・日数・金額の範囲', () => {
    expect(validateTransportSettings({ fareToleranceYen: 10_000, defaultFareType: 'ticket' })).toMatchObject({ fareToleranceYen: 10_000, defaultFareType: 'ticket' });
    expect(() => validateTransportSettings({ fareToleranceYen: 10_001 })).toThrow(/fareToleranceYen/u);
    expect(() => validateTransportSettings({ defaultFareType: 'bus' })).toThrow(/defaultFareType/u);
    expect(() => validateTransportSettings({ commuterPassDeduction: 'yes' })).toThrow(/must be a boolean/u);
    expect(validateCardPolicySettings({ dateToleranceDays: 10, amountToleranceYen: 1000, weakMatchMinAmount: 1 })).toMatchObject({ dateToleranceDays: 10, amountToleranceYen: 1000, weakMatchMinAmount: 1 });
    expect(() => validateCardPolicySettings({ dateToleranceDays: 11 })).toThrow(/dateToleranceDays/u);
    expect(() => validateCardPolicySettings({ weakMatchMinAmount: 0 })).toThrow(/weakMatchMinAmount/u);
    expect(() => validateCardPolicySettings({ creditAccountId: ' ' })).toThrow(/creditAccountId/u);
    expect(() => validateAdvancePolicySettings({ settleWithinDays: 366 })).toThrow(/settleWithinDays/u);
    expect(() => validateAdvancePolicySettings([])).toThrow(/must be an object/u);
  });

  it('異常: 費目の区間の形・承認経路の不正・部門の補助軸の型は規程全体を断る', () => {
    const categories = base.categories.map((category) => (category.id === 'books' ? { ...category, route: { required: true } } : category));
    expect(() => createExpensePolicy({ ...base, categories: categories as never })).toThrow(/route.commuterPass/u);
    expect(() => createExpensePolicy({ ...base, categories: base.categories.map((category) => ({ ...category, route: 'yes' })) as never })).toThrow(/route must be/u);
    expect(() => createExpensePolicy({ ...base, approval: { routes: [{ id: 'r', name: 'r', enabled: true, when: { categoryIds: ['unknown'] }, steps: [{ id: 's', name: 's', approver: { kind: 'any-approver' } }] }] } })).toThrow(/not in the policy/u);
    expect(() => createExpensePolicy({ ...base, journal: { ...base.journal, departmentDimensionId: 1 as never } })).toThrow(ExpenseDomainError);
  });
});
