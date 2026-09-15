/**
 * application層: `expense_advances` の行の供給（docs/21 §20.11.2）。口座番号は出さない。
 *
 * 紐付く申請の件数と合計は申請の索引から引く（台帳と同じ `ManageExpenseAdvancesUseCase.list`）。
 * difference / additional_payment / refund は精算するまで null。
 */
import type { Row } from '../../../domain/data/types';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseAdvanceView, ManageExpenseAdvancesUseCase } from './manage-advances';

export function advanceRow(advance: ExpenseAdvanceView): Row {
  return {
    advance_id: advance.id,
    employee_id: advance.employeeId,
    employee: advance.employeeSnapshot.name,
    department: advance.department ?? null,
    purpose: advance.purpose,
    amount: advance.amount,
    status: advance.status,
    needed_on: advance.neededOn,
    planned_settle_by: advance.plannedSettleBy,
    overdue: advance.overdue,
    approved_at: advance.approval?.at ?? null,
    paid_on: advance.payment?.paidOn ?? null,
    linked_claim_count: advance.linkedClaimCount,
    linked_claim_total: advance.linkedClaimTotal,
    difference: advance.settlement?.difference ?? null,
    additional_payment: advance.settlement?.additionalPayment?.amount ?? null,
    refund: advance.settlement?.refund?.amount ?? null,
    settled_on: advance.settlement?.settledOn ?? null,
    updated_at: advance.updatedAt,
  };
}

export class ExpenseAdvanceRowsProvider {
  constructor(private readonly advances: ManageExpenseAdvancesUseCase) {}

  async rows(scope: TenantScope, limit?: number): Promise<readonly Row[]> {
    return (await this.advances.list(scope, { ...(limit === undefined ? {} : { limit }) })).map(advanceRow);
  }
}
