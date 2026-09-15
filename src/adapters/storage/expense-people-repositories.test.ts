/**
 * 経費精算の従業員マスタのリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 *
 * 契約本体は `expense-people-repository.contract.ts`。ここでは SQLite にしか無い性質（絞り込み用の列・ログイン ID の派生行・
 * 壊れた行の扱い）を追加で見る。
 */
import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from '../../domain/expense/errors';
import { expenseEmployeeRepositoryContract } from './expense-people-repository.contract';
import { employeeFixture, FIXTURE_EMPLOYEE_IDS, fixtureEmployees, scope, V9_AT } from './expense-v9.fixtures';
import { InMemoryExpenseEmployeeRepository } from './in-memory-expense-people-repositories';
import { openSqliteDatabase } from './sqlite-database';
import { SqliteExpenseEmployeeRepository } from './sqlite-expense-people-repositories';

describe('従業員リポジトリ', () => {
  it('in-memory 実装が共有契約を満たす', async () => {
    await expenseEmployeeRepositoryContract(new InMemoryExpenseEmployeeRepository());
  });

  it('sqlite 実装が共有契約を満たす', async () => {
    const repo = new SqliteExpenseEmployeeRepository();
    try { await expenseEmployeeRepositoryContract(repo); } finally { repo.close(); }
  });
});

describe('SQLite 固有の性質（従業員）', () => {
  it('絞り込み用の列（社員番号・氏名の鍵・部門・上長・有効）を出し、ログイン ID の派生行を入れ直す。口座番号は列に出ない', async () => {
    const database = openSqliteDatabase();
    const employees = new SqliteExpenseEmployeeRepository(database);
    try {
      for (const employee of fixtureEmployees()) await employees.save(employee);
      const rows = database.handle.prepare(`SELECT id, code_key, name_key, department_id, manager_id, enabled, updated_at FROM expense_employees ORDER BY id`).all();
      expect(rows).toEqual([
        { id: 'emp-hanako', code_key: 'e002', name_key: 'テスト花子', department_id: 'dept-sales', manager_id: 'emp-jiro', enabled: 1, updated_at: V9_AT },
        { id: 'emp-jiro', code_key: 'e003', name_key: 'テスト次郎', department_id: 'dept-admin', manager_id: null, enabled: 1, updated_at: V9_AT },
        { id: 'emp-saburo', code_key: null, name_key: 'テスト三郎', department_id: 'dept-accounting', manager_id: 'emp-jiro', enabled: 1, updated_at: V9_AT },
        { id: 'emp-shiro', code_key: 'e005', name_key: 'テスト四郎', department_id: 'dept-sales', manager_id: 'emp-hanako', enabled: 0, updated_at: '2026-09-15T01:00:00.000Z' },
        { id: 'emp-taro', code_key: 'e001', name_key: 'テスト太郎', department_id: 'dept-sales', manager_id: 'emp-hanako', enabled: 1, updated_at: V9_AT },
      ]);
      const columns = database.handle.prepare(`PRAGMA table_info(expense_employees)`).all().map((row) => String(row['name']));
      expect(columns).not.toContain('account_number');
      const subjects = () => database.handle.prepare(`SELECT subject FROM expense_employee_subjects WHERE employee_id=? ORDER BY subject`).all(FIXTURE_EMPLOYEE_IDS.saburo).map((row) => row['subject']);
      expect(subjects()).toEqual(['saburo-sso', 'saburo@example.com']);
      await employees.save(employeeFixture(FIXTURE_EMPLOYEE_IDS.saburo, { name: 'テスト三郎' }));
      expect(subjects()).toEqual([]);
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json（形が違う・JSON でない）は読み出し時に ExpenseDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    const employees = new SqliteExpenseEmployeeRepository(database);
    try {
      const insert = database.handle.prepare(`INSERT INTO expense_employees (tenant_id, workspace_id, id, code_key, name_key, department_id, manager_id, enabled, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(scope.tenantId, scope.workspaceId, 'broken', 'b1', 'broken', 'dept-x', null, 1, V9_AT, JSON.stringify({ id: 'broken' }));
      insert.run(scope.tenantId, scope.workspaceId, 'not-json', null, 'not-json', null, null, 1, V9_AT, '{not json');
      database.handle.prepare(`INSERT INTO expense_employee_subjects (tenant_id, workspace_id, subject, employee_id) VALUES (?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken@example.com', 'broken');
      await expect(employees.findById(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(employees.findById(scope, 'not-json')).rejects.toThrow('record_json is not valid JSON');
      await expect(employees.findByIds(scope, ['broken'])).rejects.toThrow(ExpenseDomainError);
      await expect(employees.findBySubject(scope, 'broken@example.com')).rejects.toThrow(ExpenseDomainError);
      await expect(employees.findByCodeKeys(scope, ['b1'])).rejects.toThrow(ExpenseDomainError);
      await expect(employees.findByNameKey(scope, 'broken')).rejects.toThrow(ExpenseDomainError);
      await expect(employees.list(scope, { departmentId: 'dept-x' })).rejects.toThrow(ExpenseDomainError);
      await expect(employees.list(scope, { query: 'x' })).rejects.toThrow(ExpenseDomainError);
    } finally { database.close(); }
  });
});
