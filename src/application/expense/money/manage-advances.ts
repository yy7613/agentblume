/**
 * application層: 仮払の台帳（申請・編集・承認・取消・支払済み・支払取消・返金の受領・追加支給）と、申請への紐付け（docs/21 §20.1.4 / §20.9.3。UC4）。
 *
 * 遷移の規則は domain の `advance-transitions.ts`、紐付けの整合は `advance-settlement.ts` の `advanceLinkBlockers`。
 * 紐付く申請の正本は申請の `advanceId`（仮払側に一覧を持たない）なので、件数と合計は申請の索引から引く。
 * 支払・精算・承認は画面から人が行う（ツールにしない）。精算は `settle-advance.ts`、仕訳下書きは `advance-journal-drafts.ts`。
 */
import { randomUUID } from 'node:crypto';
import { isAdvanceOverdue, type AdvancePaymentMethod, type AdvanceStatus, type ExpenseAdvance } from '../../../domain/expense/advance';
import { businessDateOf } from '../../../domain/expense/business-date';
import { linkAdvance, type ExpenseClaim, type ExpenseClaimSummary } from '../../../domain/expense/claim';
import { ExpenseAdvanceNotFoundError, ExpenseEmployeeNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { advanceLinkBlockers } from '../../../domain/expense/money/advance-settlement';
import {
  approveAdvance, cancelAdvance, editAdvance, markAdvancePaid, payAdvanceAdditional, receiveAdvanceRefund, requestAdvance, unpayAdvance, type AdvancePatch,
} from '../../../domain/expense/money/advance-transitions';
import { findDepartment } from '../../../domain/expense/organization';
import type { ExpensePolicy } from '../../../domain/expense/policy';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { requireClaim } from '../manage-claims';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';

/** 仮払の応答（scope 抜き + 紐付く申請の件数・合計・期限切れ・部門名）。 */
export type ExpenseAdvanceView = Omit<ExpenseAdvance, 'tenant'> & {
  readonly linkedClaimCount: number;
  readonly linkedClaimTotal: number;
  readonly overdue: boolean;
  readonly department?: string;
};

/** 申請の要約から従業員へ支払う額（会社払いの明細を申請に含める運用なら会社払いを除く）。 */
export function summaryReimbursableAmount(summary: Pick<ExpenseClaimSummary, 'totalAmount' | 'corporatePaymentAmount'>, policy: Pick<ExpensePolicy, 'card'>): number {
  return policy.card.acceptCorporatePaymentItems ? summary.totalAmount - summary.corporatePaymentAmount : summary.totalAmount;
}

/** 1 仮払に紐付く申請の要約（上限は 1 仮払 = 20 申請なので、それを超える分も数えられるよう余裕を持って引く）。 */
export async function linkedClaimSummaries(deps: Pick<ExpenseSystemDeps, 'repositories'>, scope: TenantScope, advanceId: string): Promise<readonly ExpenseClaimSummary[]> {
  return deps.repositories.claims.list(scope, { advanceId, limit: 100 });
}

export async function requireAdvance(deps: Pick<ExpenseSystemDeps, 'repositories'>, scope: TenantScope, id: string): Promise<ExpenseAdvance> {
  const advance = await deps.repositories.advances.findById(scope, id);
  if (advance === null) throw new ExpenseAdvanceNotFoundError(`expense advance not found: ${id}`);
  return advance;
}

export interface CreateAdvanceInput {
  readonly employeeId: string;
  readonly purpose: string;
  readonly amount: number;
  readonly neededOn: string;
  readonly plannedSettleBy: string;
}

export class ManageExpenseAdvancesUseCase {
  constructor(
    private readonly deps: ExpenseSystemDeps,
    private readonly makeId: () => string = () => `adv-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
  ) {}

  private at(): string { return this.deps.now().toISOString(); }
  private today(): string { return businessDateOf(this.deps.now(), this.deps.timeZone); }

  /** 応答の形にする（紐付く申請の件数と合計を足す）。 */
  async view(scope: TenantScope, advance: ExpenseAdvance, context?: { readonly policy: ExpensePolicy; readonly departments: ReadonlyMap<string, string> }): Promise<ExpenseAdvanceView> {
    const policy = context?.policy ?? (await loadExpensePolicy(this.deps.repositories.policies, scope)).policy;
    const departments = context?.departments ?? await this.departmentNames(scope);
    const claims = await linkedClaimSummaries(this.deps, scope, advance.id);
    const { tenant: _tenant, ...rest } = advance;
    const department = advance.employeeSnapshot.departmentId === undefined ? undefined : departments.get(advance.employeeSnapshot.departmentId);
    return {
      ...rest,
      linkedClaimCount: claims.length,
      linkedClaimTotal: claims.reduce((sum, claim) => sum + summaryReimbursableAmount(claim, policy), 0),
      overdue: isAdvanceOverdue(advance, this.today()),
      ...(department === undefined ? {} : { department }),
    };
  }

  private async departmentNames(scope: TenantScope): Promise<ReadonlyMap<string, string>> {
    const organization = await this.deps.organization.get(scope);
    return new Map(organization.departments.map((department) => [department.id, department.name]));
  }

  async list(scope: TenantScope, options: { readonly status?: AdvanceStatus; readonly employeeId?: string; readonly limit?: number } = {}): Promise<readonly ExpenseAdvanceView[]> {
    const [advances, { policy }, departments] = await Promise.all([
      this.deps.repositories.advances.list(scope, { limit: options.limit ?? 500, ...(options.status === undefined ? {} : { status: options.status }), ...(options.employeeId === undefined ? {} : { employeeId: options.employeeId }) }),
      loadExpensePolicy(this.deps.repositories.policies, scope),
      this.departmentNames(scope),
    ]);
    return Promise.all(advances.map((advance) => this.view(scope, advance, { policy, departments })));
  }

  async get(scope: TenantScope, id: string): Promise<{ readonly advance: ExpenseAdvanceView; readonly claims: readonly ExpenseClaimSummary[] }> {
    const advance = await requireAdvance(this.deps, scope, id);
    const [view, claims] = await Promise.all([this.view(scope, advance), linkedClaimSummaries(this.deps, scope, id)]);
    return { advance: view, claims };
  }

  async create(scope: TenantScope, input: CreateAdvanceInput, by: string): Promise<ExpenseAdvance> {
    const employee = await this.deps.employeeDirectory.findById(scope, input.employeeId);
    if (employee === null) throw new ExpenseEmployeeNotFoundError(`expense employee not found: ${input.employeeId}`);
    const advance = requestAdvance({
      tenant: scope, id: this.makeId(),
      employee: { id: employee.id, name: employee.name, enabled: employee.enabled, ...(employee.departmentId === undefined ? {} : { departmentId: employee.departmentId }) },
      purpose: input.purpose, amount: input.amount, neededOn: input.neededOn, plannedSettleBy: input.plannedSettleBy, by, at: this.at(),
    });
    await this.deps.repositories.advances.save(advance);
    return advance;
  }

  private async update(scope: TenantScope, id: string, change: (advance: ExpenseAdvance, at: string) => ExpenseAdvance | Promise<ExpenseAdvance>): Promise<ExpenseAdvance> {
    const advance = await requireAdvance(this.deps, scope, id);
    const updated = await change(advance, this.at());
    await this.deps.repositories.advances.save(updated);
    return updated;
  }

  edit(scope: TenantScope, id: string, patch: AdvancePatch, by: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, (advance, at) => editAdvance(advance, patch, by, at));
  }

  approve(scope: TenantScope, id: string, approver: { readonly subject: string; readonly employeeId?: string }, comment?: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, (advance, at) => approveAdvance(advance, approver, at, comment));
  }

  cancel(scope: TenantScope, id: string, note: string, by: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, (advance, at) => cancelAdvance(advance, note, by, at));
  }

  markPaid(scope: TenantScope, id: string, payment: { readonly paidOn: string; readonly method: AdvancePaymentMethod }, by: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, (advance, at) => markAdvancePaid(advance, payment, by, at));
  }

  unpay(scope: TenantScope, id: string, note: string, by: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, async (advance, at) => unpayAdvance(advance, note, by, at, (await linkedClaimSummaries(this.deps, scope, id)).map((claim) => claim.id)));
  }

  refundReceived(scope: TenantScope, id: string, receivedOn: string, by: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, (advance, at) => receiveAdvanceRefund(advance, receivedOn, by, at));
  }

  additionalPaid(scope: TenantScope, id: string, payment: { readonly paidOn: string; readonly method: AdvancePaymentMethod }, by: string): Promise<ExpenseAdvance> {
    return this.update(scope, id, (advance, at) => payAdvanceAdditional(advance, payment, by, at));
  }
}

/** 申請へ仮払を紐付ける / 外す（`PUT /expense/claims/:id/advance`）。判定の前提が変わるので申請は draft へ戻る。 */
export class LinkClaimAdvanceUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(input: { readonly scope: TenantScope; readonly claimId: string; readonly advanceId: string | null; readonly by: string }): Promise<ExpenseClaim> {
    const { scope } = input;
    const claim = await requireClaim(this.deps.repositories.claims, scope, input.claimId);
    let advance: ExpenseAdvance | null = null;
    if (input.advanceId !== null) {
      advance = await requireAdvance(this.deps, scope, input.advanceId);
      if (claim.advanceId !== advance.id) {
        const linked = await linkedClaimSummaries(this.deps, scope, advance.id);
        const blockers = advanceLinkBlockers({ id: claim.id, ...(claim.claimant.employeeId === undefined ? {} : { employeeId: claim.claimant.employeeId }) }, advance, linked.map((entry) => entry.id));
        if (blockers.length > 0) {
          throw new ExpenseTransitionError(`link advance: advance ${advance.id} cannot be linked to claim ${claim.id}`, {
            nextStep: claim.claimant.employeeId === undefined
              ? '申請者を従業員マスタから選んでから、その人の支払済みの仮払を紐付けてください'
              : 'この申請者の支払済みの仮払を選んでください。仮払を渡したなら仮払台帳で「支払済みにする」を先に押します',
            blockingReasons: blockers,
          });
        }
      }
    }
    const updated = linkAdvance(claim, advance, input.by, this.deps.now().toISOString());
    if (updated !== claim) await this.deps.repositories.claims.save(updated, await this.deps.repositories.receipts.hashesByClaim(scope, claim.id));
    return updated;
  }
}
