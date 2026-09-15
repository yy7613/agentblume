import { describe, expect, it } from 'vitest';
import { claimFingerprint, createExpenseClaim, type CreateExpenseClaimProps, type ExpenseClaim, type ExpenseItem } from './claim';
import { defaultExpensePolicy } from './default-policy';
import { ExpenseDomainError } from './errors';
import { createExpenseReceipt, type ExpenseReceipt } from './receipt';
import type { ReceiptFacts } from './receipt-facts';
import {
  deserializeExpenseClaim, deserializeExpensePolicy, deserializeExpenseReceipt, serializeExpenseClaim, serializeExpensePolicy, serializeExpenseReceipt,
} from './serialization';

// domain のテストは adapters のフィクスチャを使えない（依存ルール domain-no-adapters）ので、ここで組み立てる
const AT = '2026-09-14T00:00:00.000Z';
const T1 = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 'tenant', workspaceId: 'workspace' };
const policyFixture = () => defaultExpensePolicy(AT);
function itemFixture(id: string, facts: Partial<ReceiptFacts> = {}, overrides: Partial<ExpenseItem> = {}): ExpenseItem {
  return {
    id,
    categoryId: 'transport.taxi',
    facts: { transactionDate: '2026-09-10', payeeName: 'サンプル交通', amount: 3200, ...facts },
    source: { type: 'manual' },
    extraction: { method: 'manual', warnings: [] },
    addedOn: '2026-09-14',
    ...overrides,
  };
}
function claimFixture(id: string, overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  return createExpenseClaim({
    tenant, id, claimant: { name: 'テスト太郎', employeeCode: 'E001' }, period: { from: '2026-09-01', to: '2026-09-30' },
    items: [itemFixture('item-1')], history: [{ type: 'created', by: 'tester', at: AT }], submittedBy: 'tester', createdAt: AT, updatedAt: AT,
    ...overrides,
  });
}
function receiptFixture(id: string, overrides: Partial<ExpenseReceipt> = {}): ExpenseReceipt {
  return createExpenseReceipt({
    tenant, id, claimId: 'claim-1', itemId: 'item-1', source: { type: 'image', fileName: 'receipt.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
    sha256: 'a'.repeat(64), createdAt: AT, ...overrides,
  });
}

/** JSON 化して戻す（永続化アダプタは record_json に 1 列で保存する）。 */
const viaJson = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe('規程の直列化', () => {
  it('正常: 初期テンプレート（事前承認条件・上書きあり）が往復で一致する', () => {
    const policy = policyFixture();
    const withOverrides = { ...policy, severityOverrides: { 'purpose-missing': 'off' as const }, claimRules: { ...policy.claimRules, nonReimbursablePaymentMethods: ['direct_debit' as const] } };
    const restored = deserializeExpensePolicy(viaJson(serializeExpensePolicy(deserializeExpensePolicy(withOverrides))));
    expect(restored).toEqual(withOverrides);
  });

  it('正常: serialize は複製を返す（元の値を共有しない）', () => {
    const policy = policyFixture();
    const serialized = serializeExpensePolicy(policy);
    expect(serialized).toEqual(policy);
    expect(serialized.categories).not.toBe(policy.categories);
  });

  it('異常: 形の壊れた record は ExpenseDomainError（どの項目か分かる）', () => {
    expect(() => deserializeExpensePolicy({})).toThrow(ExpenseDomainError);
    expect(() => deserializeExpensePolicy({ ...policyFixture(), categories: 'x' })).toThrow(/deserializeExpensePolicy: invalid record: categories/u);
    expect(() => deserializeExpensePolicy(null)).toThrow(/\(root\)/u);
  });

  it('異常: 形は通っても不変条件に反する record は ExpenseDomainError', () => {
    const policy = policyFixture();
    expect(() => deserializeExpensePolicy({ ...policy, categories: [...policy.categories, policy.categories[0]] })).toThrow(/duplicate category id/u);
  });
});

describe('申請の直列化', () => {
  it('正常: 判定・承認・精算・仕訳連携・確認済みを持つ申請が往復で一致する', () => {
    const base = claimFixture('c1', { items: [itemFixture('item-1', { totalsByRate: [{ rate: 10, taxableAmount: 3200, amountIncludesTax: true }], attendees: { count: 2 } }, { receiptId: 'r1', source: { type: 'csv-row', row: { 金額: '3200' } } })] });
    const claim = claimFixture('c1', {
      items: base.items,
      status: 'settled',
      title: '9 月',
      judgment: {
        verdict: 'needs-review', items: [{ itemId: 'item-1', verdict: 'needs-review', reasons: [{ code: 'purpose-missing', severity: 'review', itemId: 'item-1', params: { n: 1 } }] }],
        claimReasons: [], totals: { amount: 3200, byCategory: [{ categoryId: 'transport.taxi', amount: 3200 }] }, searchKeysComplete: true,
        policyUpdatedAt: AT, itemsFingerprint: claimFingerprint(base), checkedAt: T1,
      },
      acknowledgements: [{ itemId: 'item-1', code: 'purpose-missing', note: '確認', by: 'boss', at: T1 }],
      approval: { by: 'boss', displayName: '上司', at: T1, comment: 'OK' },
      settlement: { settledAt: T1, by: 'acct', exportFileName: 'a.csv' },
      journalLink: { entries: [{ itemId: 'item-1', entryId: 'e1' }], complete: true, draftedAt: T1, by: 'acct', warnings: [] },
    });
    expect(deserializeExpenseClaim(viaJson(serializeExpenseClaim(claim)))).toEqual(claim);
  });

  it('正常: 未知のキーは落とす', () => {
    const claim = claimFixture('c1');
    expect(deserializeExpenseClaim({ ...viaJson(claim) as object, unknown: 1 })).toEqual(claim);
  });

  it('異常: 形の壊れた record は ExpenseDomainError', () => {
    expect(() => deserializeExpenseClaim({ ...viaJson(claimFixture('c1')) as object, items: [{ id: 'x' }] })).toThrow(/deserializeExpenseClaim: invalid record/u);
    expect(() => deserializeExpenseClaim('x')).toThrow(ExpenseDomainError);
  });

  it('異常: 形は通っても遷移の整合に反する record（承認なしの approved）は ExpenseDomainError', () => {
    expect(() => deserializeExpenseClaim({ ...viaJson(claimFixture('c1')) as object, status: 'approved' })).toThrow(/must have an approval/u);
  });
});

describe('証憑の直列化', () => {
  it('正常: 往復で一致する', () => {
    const receipt = receiptFixture('r1', { source: { type: 'pdf', dataUrl: 'data:image/png;base64,AAAA', text: '本文' } });
    expect(deserializeExpenseReceipt(viaJson(serializeExpenseReceipt(receipt)))).toEqual(receipt);
  });

  it('異常: 壊れた record は ExpenseDomainError', () => {
    expect(() => deserializeExpenseReceipt({ id: 'r1' })).toThrow(/deserializeExpenseReceipt: invalid record/u);
    expect(() => deserializeExpenseReceipt({ ...viaJson(receiptFixture('r1')) as object, sha256: 'xyz' })).toThrow(ExpenseDomainError);
  });
});
