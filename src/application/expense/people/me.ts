/**
 * application層: 見ている人（`GET /expense/me`。docs/21 §20.9.2。系統 A）と、「実用機能の準備」カードの状況（従業員・振込元）。
 *
 * - me: 操作者（api の `expenseActorOf` が作る）に、ログイン ID で結ばれた従業員の要約を添える。
 * - readiness: 有効な従業員が 1 人以上いるか、組織を保存したか、振込元（口座・依頼人コード・依頼人名）が揃っているか。
 *   未設定は失敗ではない（「使うときに設定」）。画面は `readinessRows(policy, { employees, payout })` へそのまま渡す。
 */
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseActor } from '../actor';
import type { ExpenseSystemDeps } from '../system-deps';

export interface ExpenseMe {
  readonly subject: string;
  readonly displayName?: string;
  readonly singleUser: boolean;
  readonly canApprove: boolean;
  readonly employee?: { readonly id: string; readonly name: string; readonly departmentId?: string };
}

export class GetExpenseMeUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, actor: ExpenseActor): Promise<ExpenseMe> {
    const employee = actor.employeeId === undefined ? null : await this.deps.employeeDirectory.findById(scope, actor.employeeId);
    return {
      subject: actor.subject,
      ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
      singleUser: actor.singleUser,
      canApprove: actor.canApprove,
      ...(employee === null ? {} : { employee: { id: employee.id, name: employee.name, ...(employee.departmentId === undefined ? {} : { departmentId: employee.departmentId }) } }),
    };
  }
}

export interface ExpensePeopleReadiness {
  readonly employees: { readonly configured: boolean; readonly enabledCount: number };
  readonly organization: { readonly saved: boolean; readonly departmentCount: number; readonly approverGroupCount: number };
  readonly payout: { readonly configured: boolean; readonly saved: boolean };
}

export class GetExpensePeopleReadinessUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope): Promise<ExpensePeopleReadiness> {
    const [enabledCount, organization, payout] = await Promise.all([
      this.deps.repositories.employees.countEnabled(scope),
      this.deps.settings.load(scope, 'organization'),
      this.deps.settings.load(scope, 'payout'),
    ]);
    const source = payout.value;
    return {
      employees: { configured: enabledCount > 0, enabledCount },
      organization: { saved: organization.saved, departmentCount: organization.value.departments.length, approverGroupCount: organization.value.approverGroups.length },
      payout: {
        saved: payout.saved,
        configured: payout.saved && source.source !== undefined && (source.requesterCode ?? '') !== '' && (source.requesterNameKana ?? '') !== '',
      },
    };
  }
}
