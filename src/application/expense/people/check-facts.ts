/**
 * application層: 判定に要る「人と承認」の事実を集める（docs/21 §20.3.3。系統 A）。
 *
 * 集めるもの: 有効な従業員が 1 人以上いるか（件数の索引）、申請者の従業員（有効か・見つからないか）、
 * 未紐付けの申請者と氏名キーが一致する有効な従業員（最大 3）、承認計画の未解決（`claimant-unlinked` 原因を除く最初の 1 件）。
 * 画像本体・全従業員は読まない。マスタも経路も無いワークスペースでは理由を 1 つも出さない事実になる（MVP と同じ判定）。
 */
import type { CheckExtensionsInput } from '../../../domain/expense/check-extensions';
import type { ExpenseClaim } from '../../../domain/expense/claim';
import { employeeNameKey } from '../../../domain/expense/employee';
import type { PeopleCheckFacts } from '../../../domain/expense/people/check-facts';
import { CLAIMANT_CANDIDATES_MAX } from '../../../domain/expense/people/check-people';
import { sameNameEmployees } from '../../../domain/expense/people/employee-links';
import type { ExpensePolicy } from '../../../domain/expense/policy';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseCheckFactsProvider } from '../ports';
import type { ExpenseSystemDeps } from '../system-deps';
import { PeopleApprovalPlanner } from './approval-planner';

export class PeopleCheckFactsProvider implements ExpenseCheckFactsProvider {
  private readonly planner: PeopleApprovalPlanner;

  constructor(private readonly deps: ExpenseSystemDeps) {
    this.planner = new PeopleApprovalPlanner(deps);
  }

  async gather(scope: TenantScope, claim: ExpenseClaim, policy: ExpensePolicy): Promise<Partial<CheckExtensionsInput>> {
    const employees = this.deps.repositories.employees;
    const employeeId = claim.claimant.employeeId;
    const [enabledCount, claimantEmployee, plan] = await Promise.all([
      employees.countEnabled(scope),
      employeeId === undefined ? Promise.resolve(undefined) : employees.findById(scope, employeeId),
      this.planner.plan(scope, claim, policy),
    ]);
    const masterInUse = enabledCount > 0;
    const candidates = employeeId === undefined && masterInUse
      ? sameNameEmployees(claim.claimant.name, await employees.findByNameKey(scope, employeeNameKey(claim.claimant.name))).slice(0, CLAIMANT_CANDIDATES_MAX)
      : [];
    const unresolved = plan.unresolved.find((entry) => entry.cause !== 'claimant-unlinked');
    const people: PeopleCheckFacts = {
      masterInUse,
      ...(claimantEmployee === undefined ? {} : { claimantEmployee: claimantEmployee === null ? null : { id: claimantEmployee.id, name: claimantEmployee.name, enabled: claimantEmployee.enabled } }),
      ...(candidates.length === 0 ? {} : { nameCandidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name })) }),
      ...(unresolved === undefined ? {} : {
        approvalUnresolved: {
          ...(plan.routeId === undefined ? {} : { routeId: plan.routeId }),
          routeName: plan.routeName, stepId: unresolved.stepId, stepName: unresolved.stepName, cause: unresolved.cause, params: unresolved.params,
        },
      }),
    };
    return { people };
  }
}
