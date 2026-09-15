/**
 * 経費精算のスキーマ（version 6）のテスト。
 *
 * 予約版が残る並行期間は開くたびに流し直されるので、文が冪等であること、既存の仕訳のデータを壊さないことを見る。
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EXPENSE_MIGRATION, EXPENSE_STATEMENTS } from './expense-migrations';
import { JOURNAL_STATEMENTS } from './journal-migrations';
import { openSqliteDatabase } from './sqlite-database';

function tablesOf(db: DatabaseSync): Set<string> {
  return new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => String(row['name'])));
}

describe('expense migration (version 6)', () => {
  it('正常: version 6 で、説明は業務名で始まり、予約版ではない', () => {
    expect(EXPENSE_MIGRATION.version).toBe(6);
    expect(EXPENSE_MIGRATION.description.startsWith('expense')).toBe(true);
    expect(EXPENSE_MIGRATION.placeholder).toBeUndefined();
    for (const statement of EXPENSE_STATEMENTS) expect(statement).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /u);
  });

  it('正常: 空の DB を開くと 4 つのテーブルと索引ができる', () => {
    const database = openSqliteDatabase();
    try {
      const tables = tablesOf(database.handle);
      for (const table of ['expense_policy', 'expense_claims', 'expense_receipts', 'expense_item_keys']) expect(tables.has(table)).toBe(true);
      const indexes = database.handle.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_expense_%'`).all().map((row) => String(row['name']));
      expect(indexes).toEqual(expect.arrayContaining(['idx_expense_claims_scope_status', 'idx_expense_item_keys_scope_date_amount', 'idx_expense_item_keys_scope_sha']));
    } finally { database.close(); }
  });

  it('境界: 2 回流しても壊れず、仕訳（version 5）のデータはそのまま残る', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const statement of JOURNAL_STATEMENTS) db.exec(statement);
      db.prepare(`INSERT INTO journal_chart (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)`).run('t', 'w', '{"kept":true}');
      EXPENSE_MIGRATION.apply(db);
      db.prepare(`INSERT INTO expense_policy (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)`).run('t', 'w', '{}');
      EXPENSE_MIGRATION.apply(db);
      expect(db.prepare(`SELECT record_json FROM journal_chart`).get()).toMatchObject({ record_json: '{"kept":true}' });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM expense_policy`).get()).toMatchObject({ n: 1 });
    } finally { db.close(); }
  });
});
