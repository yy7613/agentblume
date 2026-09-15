import { describe, expect, it } from 'vitest';
import { policyFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpensePolicyRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { EXPENSE_POLICY_COLUMNS } from '../../domain/etl/nodes/expense-policy-source';
import { createExpensePolicy } from '../../domain/expense/policy';
import { describePreApprovalRule, ExpensePolicyRowsProvider, expensePolicyRows } from './policy-rows';

describe('describePreApprovalRule', () => {
  it('正常: 金額条件を「かつ」でつなぎ、円を 3 桁区切りにする', () => {
    expect(describePreApprovalRule({ id: 'r', name: '接待', enabled: true, categoryIds: [], minAmount: 50_000, minPerPerson: 10_000 })).toBe('接待: 1 件 50,000 円以上 かつ 1 人あたり 10,000 円以上');
    expect(describePreApprovalRule({ id: 'r', name: '人数', enabled: true, categoryIds: ['a'], minPerPerson: 5000 })).toBe('人数: 1 人あたり 5,000 円以上');
  });

  it('境界: 金額条件が無ければ対象の費目のすべて', () => {
    expect(describePreApprovalRule({ id: 'r', name: '出張', enabled: true, categoryIds: ['a'] })).toBe('出張: 対象の費目のすべて');
  });
});

describe('expensePolicyRows', () => {
  const policy = policyFixture();

  it('正常: 1 行 = 1 費目、列の並びは EXPENSE_POLICY_SCHEMA と同じ', () => {
    const rows = expensePolicyRows(policy, false);
    expect(rows).toHaveLength(policy.categories.length);
    for (const row of rows) expect(Object.keys(row)).toEqual([...EXPENSE_POLICY_COLUMNS]);
  });

  it('正常: 費目の値・該当する事前承認条件・申請ルールを写し、未保存は policy_saved false', () => {
    const rows = expensePolicyRows(policy, false);
    const entertainment = rows.find((row) => row['category_id'] === 'meal.entertainment');
    expect(entertainment).toMatchObject({
      name: '交際費（接待の飲食）', enabled: true, account_id: 'expense.entertainment', default_tax_rate: 10, receipt_required: true, receipt_exempt_below: null,
      requires_attendees: true, requires_attendee_details: true, per_item_limit: null, per_person_limit: 10_000, per_person_basis: 'tax-included', per_unit_label: null,
      pre_approval: '交際費で 1 件 50,000 円以上: 1 件 50,000 円以上 / 1 件 100,000 円以上: 1 件 100,000 円以上',
      aliases: '交際費 / 接待 / 接待交際費', policy_saved: false, submission_deadline_days: 90, attendees_include_claimant: true,
      non_reimbursable_payment_methods: '', severity_overrides_json: '{}', updated_at: policy.updatedAt,
    });
    expect(rows.find((row) => row['category_id'] === 'travel.lodging')).toMatchObject({ per_unit_label: '泊', per_unit_limit: 12_000, note: null });
    expect(rows.find((row) => row['category_id'] === 'transport.public')).toMatchObject({ invoice_exempt_below: 30_000 });
  });

  it('境界: 科目・提出期限が無ければ null、上書きと支払方法を文字列にする', () => {
    const custom = createExpensePolicy({
      ...policy,
      categories: policy.categories.map((category) => (category.id === 'misc' ? { ...category, accountId: undefined } : category)) as never,
      claimRules: { ...policy.claimRules, submissionDeadlineDays: undefined as never, nonReimbursablePaymentMethods: ['cash', 'direct_debit'] },
      severityOverrides: { 'purpose-missing': 'off' },
    });
    const misc = expensePolicyRows(custom, true).find((row) => row['category_id'] === 'misc');
    expect(misc).toMatchObject({ account_id: null, submission_deadline_days: null, non_reimbursable_payment_methods: 'cash, direct_debit', severity_overrides_json: '{"purpose-missing":"off"}', policy_saved: true });
  });
});

describe('ExpensePolicyRowsProvider', () => {
  it('正常: 未保存は初期テンプレートで policy_saved false、保存後は true', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const provider = new ExpensePolicyRowsProvider(policies);
    expect((await provider.rows(scope))[0]!['policy_saved']).toBe(false);
    // 参照は書き込みを起こさない
    expect(await policies.get(scope)).toBeNull();
    await policies.save(scope, policyFixture('2026-09-20T00:00:00.000Z'));
    const rows = await provider.rows(scope);
    expect(rows[0]).toMatchObject({ policy_saved: true, updated_at: '2026-09-20T00:00:00.000Z' });
  });
});
