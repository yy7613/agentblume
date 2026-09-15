/**
 * application層: 規程を「Agent が読む表」へ畳む（docs/21 §13.3）。1 行 = 1 費目。
 *
 * 未保存なら初期テンプレートを返し `policy_saved = false`（保存はしない）。エージェントが初期値を
 * 会社の規程として説明しないよう、ツールの説明でこの列の読み方を伝える。
 */
import type { Row } from '../../domain/data/types';
import { EXPENSE_POLICY_SCHEMA } from '../../domain/etl/nodes/expense-policy-source';
import { preApprovalRulesFor, type ExpensePolicy, type PreApprovalRule } from '../../domain/expense/policy';
import type { ExpensePolicyRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { loadExpensePolicy } from './manage-policy';

function yen(value: number): string {
  return value.toLocaleString('ja-JP');
}

/** 事前承認条件を「名前: 条件」の 1 文にする。 */
export function describePreApprovalRule(rule: PreApprovalRule): string {
  const conditions = [
    ...(rule.minAmount === undefined ? [] : [`1 件 ${yen(rule.minAmount)} 円以上`]),
    ...(rule.minPerPerson === undefined ? [] : [`1 人あたり ${yen(rule.minPerPerson)} 円以上`]),
  ];
  return `${rule.name}: ${conditions.length === 0 ? '対象の費目のすべて' : conditions.join(' かつ ')}`;
}

export function expensePolicyRows(policy: ExpensePolicy, saved: boolean): readonly Row[] {
  return policy.categories.map((category) => {
    const row: Record<string, unknown> = {
      category_id: category.id,
      name: category.name,
      enabled: category.enabled,
      account_id: category.accountId ?? null,
      default_tax_rate: category.defaultTaxRate,
      receipt_required: category.receipt.required,
      receipt_exempt_below: category.receipt.exemptBelow ?? null,
      invoice_required: category.invoice.required,
      invoice_exempt_below: category.invoice.exemptBelow ?? null,
      requires_purpose: category.requires.purpose,
      requires_attendees: category.requires.attendees,
      requires_attendee_details: category.requires.attendeeDetails,
      per_item_limit: category.limits.perItem ?? null,
      per_claim_limit: category.limits.perClaim ?? null,
      per_person_limit: category.limits.perPerson ?? null,
      per_person_basis: category.limits.perPersonBasis,
      per_unit_label: category.limits.perUnit?.label ?? null,
      per_unit_limit: category.limits.perUnit?.amount ?? null,
      pre_approval: preApprovalRulesFor(policy, category.id).map(describePreApprovalRule).join(' / '),
      aliases: category.aliases.join(' / '),
      note: category.note ?? null,
      policy_saved: saved,
      submission_deadline_days: policy.claimRules.submissionDeadlineDays ?? null,
      attendees_include_claimant: policy.claimRules.attendeesIncludeClaimant,
      non_reimbursable_payment_methods: policy.claimRules.nonReimbursablePaymentMethods.join(', '),
      severity_overrides_json: JSON.stringify(policy.severityOverrides),
      updated_at: policy.updatedAt,
    };
    return Object.fromEntries(EXPENSE_POLICY_SCHEMA.columns.map((column) => [column.name, row[column.name] ?? null])) as Row;
  });
}

export class ExpensePolicyRowsProvider {
  constructor(private readonly policies: ExpensePolicyRepository) {}

  async rows(scope: TenantScope): Promise<readonly Row[]> {
    const { policy, saved } = await loadExpensePolicy(this.policies, scope);
    return expensePolicyRows(policy, saved);
  }
}
