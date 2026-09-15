/**
 * adapters層: 経費精算の従業員マスタの InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 保存も読み出しも `structuredClone` する（SQLite 実装は JSON を経由するので挙動を揃える）。
 * 社員番号・ログイン ID の一意は SQLite の一意制約に当たる検査をここでも行い、同じ `ExpenseDomainError` を投げる
 * （test プロファイルで二重登録が通ってしまうと、本番でだけ 400 になる差が生まれるため）。
 */
import { employeeCodeKey, employeeNameKey, type ExpenseEmployee } from '../../domain/expense/employee';
import type { ExpenseEmployeeListOptions, ExpenseEmployeeRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { employeeCodeConflict, employeeMatchesQuery, employeeSearchKey, employeeSubjectConflict } from './sqlite-expense-people-repositories';

function key(scope: TenantScope, id: string): string { return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${id}`; }
function inScope(item: { readonly tenant: TenantScope }, scope: TenantScope): boolean {
  return item.tenant.tenantId === scope.tenantId && item.tenant.workspaceId === scope.workspaceId;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class InMemoryExpenseEmployeeRepository implements ExpenseEmployeeRepository {
  private readonly store = new Map<string, ExpenseEmployee>();

  private inScope(scope: TenantScope): readonly ExpenseEmployee[] {
    return [...this.store.values()].filter((employee) => inScope(employee, scope));
  }

  async save(employee: ExpenseEmployee): Promise<void> {
    const others = this.inScope(employee.tenant).filter((other) => other.id !== employee.id);
    if (employee.code !== undefined) {
      const codeKey = employeeCodeKey(employee.code);
      const clash = others.find((other) => other.code !== undefined && employeeCodeKey(other.code) === codeKey);
      if (clash !== undefined) throw employeeCodeConflict(employee.code, clash.id);
    }
    // SQLite と同じく、重なったログイン ID のうち辞書順で最初のものを報告する。
    const taken = new Map(others.flatMap((other) => other.loginSubjects.map((subject) => [subject, other.id] as const)));
    const clash = [...employee.loginSubjects].sort(compareText).find((subject) => taken.has(subject));
    if (clash !== undefined) throw employeeSubjectConflict(clash, taken.get(clash) as string);
    this.store.set(key(employee.tenant, employee.id), structuredClone(employee));
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseEmployee | null> {
    const employee = this.store.get(key(scope, id));
    return employee === undefined ? null : structuredClone(employee);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseEmployee[]> {
    return ids.map((id) => this.store.get(key(scope, id))).filter((employee): employee is ExpenseEmployee => employee !== undefined).map((employee) => structuredClone(employee));
  }

  async findBySubject(scope: TenantScope, subject: string): Promise<ExpenseEmployee | null> {
    const found = this.inScope(scope).find((employee) => employee.loginSubjects.includes(subject));
    return found === undefined ? null : structuredClone(found);
  }

  async findByCodeKeys(scope: TenantScope, codeKeys: readonly string[]): Promise<readonly ExpenseEmployee[]> {
    const keys = new Set(codeKeys);
    return this.inScope(scope)
      .filter((employee) => employee.code !== undefined && keys.has(employeeCodeKey(employee.code)))
      .sort((left, right) => compareText(employeeCodeKey(left.code as string), employeeCodeKey(right.code as string)))
      .map((employee) => structuredClone(employee));
  }

  async findByNameKey(scope: TenantScope, nameKey: string): Promise<readonly ExpenseEmployee[]> {
    return this.inScope(scope)
      .filter((employee) => employeeNameKey(employee.name) === nameKey)
      .sort((left, right) => compareText(left.id, right.id))
      .map((employee) => structuredClone(employee));
  }

  async list(scope: TenantScope, options?: ExpenseEmployeeListOptions): Promise<readonly ExpenseEmployee[]> {
    const queryKey = options?.query === undefined ? '' : employeeSearchKey(options.query);
    const matched = this.inScope(scope)
      .filter((employee) => (options?.enabled === undefined || employee.enabled === options.enabled)
        && (options?.departmentId === undefined || employee.departmentId === options.departmentId)
        && (queryKey === '' || employeeMatchesQuery(employee, queryKey)))
      .sort((left, right) => (left.enabled !== right.enabled ? (left.enabled ? -1 : 1)
        : compareText(employeeNameKey(left.name), employeeNameKey(right.name)) || compareText(left.id, right.id)));
    const limited = options?.limit === undefined ? matched : matched.slice(0, options.limit);
    return limited.map((employee) => structuredClone(employee));
  }

  async countEnabled(scope: TenantScope): Promise<number> {
    return this.inScope(scope).filter((employee) => employee.enabled).length;
  }
}
