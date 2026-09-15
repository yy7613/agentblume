/**
 * adapters層: 経費精算の従業員マスタ（docs/21 §20.2.5 / §20.8。UC1）の SQLite 永続化（テーブルは `expense-v9-migrations.ts`）。
 *
 * - 本体は `expense_employees.record_json`。ログイン ID は派生の `expense_employee_subjects` に 1 行ずつ持ち、保存と同じトランザクションで入れ直す。
 * - 社員番号（code_key）とログイン ID の一意は DB の一意制約でも止まるが、生の SQLite エラーでは「誰と重なったか」が分からないので、
 *   書く前に引いて `ExpenseDomainError`（`details.field` / `details.conflictEmployeeId`）にする（画面が相手へ導線を出せるように）。
 * - 並び順は `domain/expense/repositories.ts` の doc コメントが正本で、InMemory 実装と同じ結果になる（共有契約テスト）。
 */
import { employeeCodeKey, employeeNameKey, type ExpenseEmployee } from '../../domain/expense/employee';
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpenseEmployeeListOptions, ExpenseEmployeeRepository } from '../../domain/expense/repositories';
import { deserializeExpenseEmployee, serializeExpenseEmployee } from '../../domain/expense/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';

function parse(value: unknown): ExpenseEmployee {
  let raw: unknown;
  try { raw = JSON.parse(String(value)); } catch { throw new ExpenseDomainError('expense employee: record_json is not valid JSON'); }
  return deserializeExpenseEmployee(raw);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** 一覧の検索語の鍵（氏名・カナ・社員番号の部分一致。NFKC で半角カナも全角に揃う）。 */
export function employeeSearchKey(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

export function employeeMatchesQuery(employee: Pick<ExpenseEmployee, 'name' | 'nameKana' | 'code'>, queryKey: string): boolean {
  return [employee.name, employee.nameKana, employee.code].some((field) => field !== undefined && employeeSearchKey(field).includes(queryKey));
}

export function employeeCodeConflict(code: string, conflictEmployeeId: string): ExpenseDomainError {
  return new ExpenseDomainError(`expense employee: the employee code "${code}" is already used by ${conflictEmployeeId}`, undefined, { field: 'code', conflictEmployeeId });
}

export function employeeSubjectConflict(subject: string, conflictEmployeeId: string): ExpenseDomainError {
  return new ExpenseDomainError(`expense employee: the login ID "${subject}" is already linked to ${conflictEmployeeId}`, undefined, { field: 'loginSubjects', conflictEmployeeId });
}

export class SqliteExpenseEmployeeRepository extends SqliteRepositoryBase implements ExpenseEmployeeRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') { super(source); }

  async save(employee: ExpenseEmployee): Promise<void> {
    const { tenantId, workspaceId } = employee.tenant;
    const codeKey = employee.code === undefined ? null : employeeCodeKey(employee.code);
    this.database.transaction(() => {
      if (employee.code !== undefined) {
        const clash = this.db.prepare(`SELECT id FROM expense_employees WHERE tenant_id=? AND workspace_id=? AND code_key=? AND id<>?`).get(tenantId, workspaceId, codeKey, employee.id);
        if (clash !== undefined) throw employeeCodeConflict(employee.code, String(clash['id']));
      }
      if (employee.loginSubjects.length > 0) {
        const clash = this.db.prepare(
          `SELECT subject, employee_id FROM expense_employee_subjects WHERE tenant_id=? AND workspace_id=? AND employee_id<>? AND subject IN (${placeholders(employee.loginSubjects.length)}) ORDER BY subject ASC LIMIT 1`,
        ).get(tenantId, workspaceId, employee.id, ...employee.loginSubjects);
        if (clash !== undefined) throw employeeSubjectConflict(String(clash['subject']), String(clash['employee_id']));
      }
      this.db.prepare(
        `INSERT INTO expense_employees (tenant_id, workspace_id, id, code_key, name_key, department_id, manager_id, enabled, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workspace_id, id) DO UPDATE SET code_key=excluded.code_key, name_key=excluded.name_key, department_id=excluded.department_id,
           manager_id=excluded.manager_id, enabled=excluded.enabled, updated_at=excluded.updated_at, record_json=excluded.record_json`,
      ).run(tenantId, workspaceId, employee.id, codeKey, employeeNameKey(employee.name), employee.departmentId ?? null, employee.managerEmployeeId ?? null, employee.enabled ? 1 : 0, employee.updatedAt, JSON.stringify(serializeExpenseEmployee(employee)));
      this.db.prepare(`DELETE FROM expense_employee_subjects WHERE tenant_id=? AND workspace_id=? AND employee_id=?`).run(tenantId, workspaceId, employee.id);
      const insert = this.db.prepare(`INSERT INTO expense_employee_subjects (tenant_id, workspace_id, subject, employee_id) VALUES (?, ?, ?, ?)`);
      for (const subject of employee.loginSubjects) insert.run(tenantId, workspaceId, subject, employee.id);
    });
  }

  async findById(scope: TenantScope, id: string): Promise<ExpenseEmployee | null> {
    const row = this.db.prepare(`SELECT record_json FROM expense_employees WHERE tenant_id=? AND workspace_id=? AND id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : parse(row['record_json']);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly ExpenseEmployee[]> {
    const statement = this.db.prepare(`SELECT record_json FROM expense_employees WHERE tenant_id=? AND workspace_id=? AND id=?`);
    const found: ExpenseEmployee[] = [];
    for (const id of ids) {
      const row = statement.get(scope.tenantId, scope.workspaceId, id);
      if (row !== undefined) found.push(parse(row['record_json']));
    }
    return found;
  }

  async findBySubject(scope: TenantScope, subject: string): Promise<ExpenseEmployee | null> {
    const row = this.db.prepare(
      `SELECT e.record_json FROM expense_employee_subjects s
       JOIN expense_employees e ON e.tenant_id=s.tenant_id AND e.workspace_id=s.workspace_id AND e.id=s.employee_id
       WHERE s.tenant_id=? AND s.workspace_id=? AND s.subject=?`,
    ).get(scope.tenantId, scope.workspaceId, subject);
    return row === undefined ? null : parse(row['record_json']);
  }

  async findByCodeKeys(scope: TenantScope, codeKeys: readonly string[]): Promise<readonly ExpenseEmployee[]> {
    const keys = [...new Set(codeKeys)];
    if (keys.length === 0) return [];
    return this.db.prepare(
      `SELECT record_json FROM expense_employees WHERE tenant_id=? AND workspace_id=? AND code_key IN (${placeholders(keys.length)}) ORDER BY code_key ASC`,
    ).all(scope.tenantId, scope.workspaceId, ...keys).map((row) => parse(row['record_json']));
  }

  async findByNameKey(scope: TenantScope, nameKey: string): Promise<readonly ExpenseEmployee[]> {
    return this.db.prepare(`SELECT record_json FROM expense_employees WHERE tenant_id=? AND workspace_id=? AND name_key=? ORDER BY id ASC`)
      .all(scope.tenantId, scope.workspaceId, nameKey).map((row) => parse(row['record_json']));
  }

  async list(scope: TenantScope, options?: ExpenseEmployeeListOptions): Promise<readonly ExpenseEmployee[]> {
    const where: string[] = ['tenant_id=?', 'workspace_id=?'];
    const params: (string | number)[] = [scope.tenantId, scope.workspaceId];
    if (options?.enabled !== undefined) { where.push('enabled=?'); params.push(options.enabled ? 1 : 0); }
    if (options?.departmentId !== undefined) { where.push('department_id=?'); params.push(options.departmentId); }
    const queryKey = options?.query === undefined ? '' : employeeSearchKey(options.query);
    let sql = `SELECT record_json FROM expense_employees WHERE ${where.join(' AND ')} ORDER BY enabled DESC, name_key ASC, id ASC`;
    // カナと社員番号の NFKC は SQL で再現できないので、検索語があるときは全件を読んで JS で絞ってから件数を切る（従業員は数百人規模）。
    if (queryKey === '' && options?.limit !== undefined) { sql += ' LIMIT ?'; params.push(options.limit); }
    const employees = this.db.prepare(sql).all(...params).map((row) => parse(row['record_json']));
    if (queryKey === '') return employees;
    const matched = employees.filter((employee) => employeeMatchesQuery(employee, queryKey));
    return options?.limit === undefined ? matched : matched.slice(0, options.limit);
  }

  async countEnabled(scope: TenantScope): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM expense_employees WHERE tenant_id=? AND workspace_id=? AND enabled=1`).get(scope.tenantId, scope.workspaceId);
    return Number(row?.['n'] ?? 0);
  }
}
