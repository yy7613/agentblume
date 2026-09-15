/**
 * application層: 申請の要約を「Agent が読む表」へ畳む（docs/21 §13.2）。
 *
 * リポジトリの要約（`list`）から作り、明細・証憑本体は読まない。`stale` は規程の版との比較まで含める
 * （古い判定のまま承認させないよう、ツールの説明で「stale なら再チェック」と伝えるため）。
 */
import type { Row } from '../../domain/data/types';
import { EXPENSE_CLAIMS_SCHEMA } from '../../domain/etl/nodes/expense-claims-source';
import { withPolicyStaleness, type ClaimStatus, type ExpenseClaimSummary } from '../../domain/expense/claim';
import type { ExpensePolicy } from '../../domain/expense/policy';
import type { ExpenseClaimRepository, ExpensePolicyRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { loadExpensePolicy } from './manage-policy';

export const EXPENSE_CLAIM_ROWS_DEFAULT_LIMIT = 500;

export function expenseClaimRow(summary: ExpenseClaimSummary, policy?: Pick<ExpensePolicy, 'card'>): Row {
  // 会社払いを除くのは規程のフラグが on のときだけ（off なら MVP どおり合計がそのまま支払額）。
  const reimbursable = policy?.card.acceptCorporatePaymentItems === true ? summary.totalAmount - summary.corporatePaymentAmount : summary.totalAmount;
  const row: Record<string, unknown> = {
    claim_id: summary.id,
    claimant: summary.claimant.name,
    employee_code: summary.claimant.employeeCode ?? null,
    department: summary.claimant.department ?? null,
    period_from: summary.period.from,
    period_to: summary.period.to,
    title: summary.title ?? null,
    status: summary.status,
    verdict: summary.verdict ?? null,
    stale: summary.stale,
    item_count: summary.itemCount,
    total_amount: summary.totalAmount,
    return_count: summary.reasonCounts.return,
    review_count: summary.reasonCounts.review,
    acknowledged_count: summary.reasonCounts.acknowledged,
    approved_by: summary.approvedBy ?? null,
    approved_at: summary.approvedAt ?? null,
    settled_at: summary.settledAt ?? null,
    journal_linked: summary.journalLinked,
    top_reasons: summary.topReasons.join(' / '),
    updated_at: summary.updatedAt,
    employee_id: summary.claimant.employeeId ?? null,
    department_id: summary.claimant.departmentId ?? null,
    advance_id: summary.advanceId ?? null,
    reimbursable_amount: reimbursable,
    current_step: summary.currentStep?.name ?? null,
    current_approvers: summary.currentStep === undefined || summary.currentStep.approvers.length === 0 ? null : summary.currentStep.approvers.map((approver) => approver.name).join('、'),
  };
  return Object.fromEntries(EXPENSE_CLAIMS_SCHEMA.columns.map((column) => [column.name, row[column.name] ?? null])) as Row;
}

export class ExpenseClaimRowsProvider {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly policies: ExpensePolicyRepository,
  ) {}

  async rows(scope: TenantScope, options?: { readonly status?: ClaimStatus; readonly limit?: number }): Promise<readonly Row[]> {
    const { policy } = await loadExpensePolicy(this.policies, scope);
    const summaries = await this.claims.list(scope, {
      ...(options?.status === undefined ? {} : { status: options.status }),
      limit: options?.limit ?? EXPENSE_CLAIM_ROWS_DEFAULT_LIMIT,
    });
    return summaries.map((summary) => expenseClaimRow(withPolicyStaleness(summary, policy), policy));
  }
}
