/**
 * application層: 承認経路の解決（docs/21 §20.2.6。`ApprovalRoutePlanner` の実装。系統 A）。
 *
 * 判定そのものは domain の `people/approval-route.ts`（純関数）。ここは組織と、解決に要る従業員だけを索引で引いて渡す
 * （申請者 → 上長・指定の承認者・グループのメンバー・部門長の順に 2 回で引く。全従業員を読まない）。
 * 骨格のチェック（承認者の索引）・承認（段の承認）・申請の応答（承認の見通し）が同じ 3 関数を呼ぶ。
 */
import type { ApprovalPlan, ApprovalSettings } from '../../../domain/expense/approval';
import type { ExpenseClaim } from '../../../domain/expense/claim';
import type { ExpenseOrganization } from '../../../domain/expense/organization';
import {
  actorStepBlockers, approvalEmployeeIdsToLoad, approvalSubjectOf, currentApproverIds, resolveApprovalPlanFor,
  type ApprovalEmployee, type ApprovalRouteSubject,
} from '../../../domain/expense/people/approval-route';
import type { ExpensePolicy } from '../../../domain/expense/policy';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ApprovalActorDecision, ApprovalRoutePlanner, EmployeeDirectoryPort, ExpenseActor } from '../ports';
import type { ExpenseSystemDeps } from '../system-deps';

/** 解決に要る従業員を引く（申請者を先に読み、その上長・部門も辿れるようにする）。 */
export async function loadApprovalEmployees(
  directory: EmployeeDirectoryPort,
  scope: TenantScope,
  subject: ApprovalRouteSubject,
  approval: ApprovalSettings,
  organization: ExpenseOrganization,
): Promise<readonly ApprovalEmployee[]> {
  const claimant = subject.claimantEmployeeId === undefined ? null : await directory.findById(scope, subject.claimantEmployeeId);
  const ids = approvalEmployeeIdsToLoad(subject, approval, organization, claimant ?? undefined);
  return ids.length === 0 ? [] : directory.findByIds(scope, ids);
}

export class PeopleApprovalPlanner implements ApprovalRoutePlanner {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async plan(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy): Promise<ApprovalPlan> {
    return this.planFor(scope, approvalSubjectOf(claim), policy.approval);
  }

  /** 申請を作らずに経路を解決する（規程タブの試算。保存していない承認設定でも使える）。 */
  async planFor(scope: TenantScope, subject: ApprovalRouteSubject, approval: ApprovalSettings): Promise<ApprovalPlan> {
    const organization = await this.deps.organization.get(scope);
    const employees = await loadApprovalEmployees(this.deps.employeeDirectory, scope, subject, approval, organization);
    return resolveApprovalPlanFor(subject, approval, organization, employees);
  }

  async actorBlockers(
    scope: TenantScope,
    input: { readonly claim: ExpenseClaim; readonly policy: ExpensePolicy; readonly flow: Parameters<typeof actorStepBlockers>[0]; readonly actor: ExpenseActor; readonly comment?: string },
  ): Promise<ApprovalActorDecision> {
    const organization = await this.deps.organization.get(scope);
    return actorStepBlockers(input.flow, input.actor, input.claim, input.policy, organization, input.comment);
  }

  async currentApprovers(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy): Promise<readonly string[]> {
    if (claim.status === 'in-approval') return currentApproverIds(claim, undefined);
    if (claim.status !== 'checked') return [];
    return currentApproverIds(claim, await this.plan(scope, claim, policy));
  }
}
