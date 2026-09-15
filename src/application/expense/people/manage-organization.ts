/**
 * application層: 組織（部門・承認グループ）の読み書き（docs/21 §20.2.5 / §20.9.2。系統 A）。
 *
 * 規程と同じく**未保存なら空の組織を返すが保存しない**（`saved: false`）。検証は骨格の `createExpenseOrganization`
 * （部門名の一意・親の循環・グループの形）。部門長・メンバーの従業員の存在は検証しない（解決できないことはチェックの
 * `approval-route-unresolved` と承認経路の試算で見せる）。
 */
import type { ExpenseApproverGroup, ExpenseDepartment, ExpenseOrganization } from '../../../domain/expense/organization';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';

export class GetExpenseOrganizationUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope): Promise<{ readonly organization: ExpenseOrganization; readonly saved: boolean }> {
    const { value, saved } = await this.deps.settings.load(scope, 'organization');
    return { organization: value, saved };
  }
}

export class SaveExpenseOrganizationUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, input: { readonly departments: readonly ExpenseDepartment[]; readonly approverGroups: readonly ExpenseApproverGroup[] }): Promise<ExpenseOrganization> {
    return this.deps.settings.save(scope, 'organization', { departments: input.departments, approverGroups: input.approverGroups, updatedAt: this.deps.now().toISOString() });
  }
}
