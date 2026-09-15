/**
 * 経費精算の実用化のスキーマ（version 9）のテスト。
 *
 * - 空の DB で全テーブル・索引ができる。
 * - MVP（v6）の申請が入った DB に v9 を当てると、派生索引が既存の申請から埋まり、集計（listItemFacts）が承認済みの申請を含む。
 * - 予約版が残る期間は開くたびに流し直されるので、2 回流しても行数が変わらず、新しいコードが入れ直した行を上書きしない。
 * - 一意制約（社員番号・ログイン ID・カードの行・取込ファイル）が DB で効く。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { itemKeyOf } from '../../domain/expense/duplicates';
import { deserializeExpenseClaim } from '../../domain/expense/serialization';
import { EXPENSE_MIGRATION } from './expense-migrations';
import { EXPENSE_V9_MIGRATION, EXPENSE_V9_STATEMENTS } from './expense-v9-migrations';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations';
import { openSqliteDatabase } from './sqlite-database';
import { SqliteExpenseClaimRepository } from './sqlite-expense-repositories';

const V9_TABLES = [
  'expense_employees', 'expense_employee_subjects', 'expense_settings', 'expense_claim_refs', 'expense_item_refs', 'expense_claim_approvers',
  'expense_advances', 'expense_card_imports', 'expense_card_transactions', 'expense_payout_batches', 'expense_policy_hearings',
];
const V9_INDEXES = [
  'idx_expense_employees_scope_code', 'idx_expense_employees_scope_name', 'idx_expense_employees_scope_department', 'idx_expense_employee_subjects_scope_employee',
  'idx_expense_claim_refs_scope_employee', 'idx_expense_claim_refs_scope_department', 'idx_expense_claim_refs_scope_advance', 'idx_expense_claim_refs_scope_payout',
  'idx_expense_item_refs_scope_date', 'idx_expense_item_refs_scope_date_amount', 'idx_expense_claim_approvers_scope_employee',
  'idx_expense_advances_scope_status', 'idx_expense_advances_scope_employee', 'idx_expense_card_imports_scope_sha',
  'idx_expense_card_transactions_scope_dedupe', 'idx_expense_card_transactions_scope_date_amount', 'idx_expense_card_transactions_scope_status',
  'idx_expense_card_transactions_scope_claim', 'idx_expense_card_transactions_scope_import', 'idx_expense_payout_batches_scope_status',
  'idx_expense_policy_hearings_scope_status',
];

/** MVP の実装で採取した申請の JSON（`__fixtures__/v6-claim-*.json`）。 */
function v6Claim(name: 'draft' | 'checked' | 'approved' | 'settled'): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../domain/expense/__fixtures__/v6-claim-${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** v6 の申請を MVP の保存と同じ列で直接入れる（v9 のコードを通さない = 派生索引は空のまま）。 */
function insertV6Claim(db: DatabaseSync, record: Record<string, unknown>): void {
  const claim = deserializeExpenseClaim(record);
  db.prepare(
    `INSERT INTO expense_claims (tenant_id, workspace_id, id, status, verdict, claimant_key, period_from, period_to, total_amount, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(claim.tenant.tenantId, claim.tenant.workspaceId, claim.id, claim.status, claim.judgment?.verdict ?? null, 'x', claim.period.from, claim.period.to, 0, claim.createdAt, JSON.stringify(record));
  const insertKey = db.prepare(`INSERT INTO expense_item_keys (tenant_id, workspace_id, claim_id, item_id, transaction_date, amount, payee_key, category_id, receipt_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of claim.items) {
    const key = itemKeyOf(item);
    insertKey.run(claim.tenant.tenantId, claim.tenant.workspaceId, claim.id, item.id, key.transactionDate ?? null, key.amount ?? null, key.payeeKey ?? null, key.categoryId ?? null, null);
  }
}

/** 下書きの 2 件目の明細を会社払いにした v6 の申請（埋め戻しの corporate 列を見るため）。 */
function corporateDraft(): Record<string, unknown> {
  const record = v6Claim('draft') as { items: { facts: Record<string, unknown> }[] };
  (record.items[1] as { facts: Record<string, unknown> }).facts['corporatePayment'] = true;
  return record as unknown as Record<string, unknown>;
}

function names(db: DatabaseSync, type: 'table' | 'index'): Set<string> {
  return new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type=?`).all(type).map((row) => String(row['name'])));
}

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(['expense_claim_refs', 'expense_item_refs'].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'])]));
}

describe('expense migration (version 9)', () => {
  it('正常: version 9 で、説明は業務名で始まり、予約版ではなく、MIGRATIONS の末尾にある。文はすべて冪等で ALTER を使わない', () => {
    expect(EXPENSE_V9_MIGRATION.version).toBe(9);
    expect(EXPENSE_V9_MIGRATION.description.startsWith('expense ')).toBe(true);
    expect(EXPENSE_V9_MIGRATION.placeholder).toBeUndefined();
    expect(MIGRATIONS[MIGRATIONS.length - 1]).toBe(EXPENSE_V9_MIGRATION);
    for (const statement of EXPENSE_V9_STATEMENTS) {
      expect(statement).toMatch(/^(CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS|INSERT OR IGNORE INTO) /u);
      expect(statement).not.toMatch(/ALTER\s+TABLE/iu);
    }
  });

  it('正常: 空の DB を開くと全テーブルと索引ができ、最新の版まで刻まれる', () => {
    const database = openSqliteDatabase();
    try {
      const tables = names(database.handle, 'table');
      for (const table of V9_TABLES) expect(tables.has(table)).toBe(true);
      const indexes = names(database.handle, 'index');
      for (const index of V9_INDEXES) expect(indexes.has(index)).toBe(true);
      expect(database.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    } finally { database.close(); }
  });

  it('正常: MVP の申請が入った v6 の DB に当てると、派生索引が既存の申請から埋まる（承認日時・精算日時・会社払い・支払先キー）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      EXPENSE_MIGRATION.apply(db);
      insertV6Claim(db, v6Claim('approved'));
      insertV6Claim(db, v6Claim('settled'));
      insertV6Claim(db, corporateDraft());
      EXPENSE_V9_MIGRATION.apply(db);

      const refs = db.prepare(`SELECT claim_id, employee_id, department_id, department_text, claimant_name, advance_id, payout_batch_id, approved_at, settled_at FROM expense_claim_refs ORDER BY claim_id`).all();
      expect(refs).toEqual([
        { claim_id: 'claim-v6-approved', employee_id: null, department_id: null, department_text: '営業部', claimant_name: 'テスト太郎', advance_id: null, payout_batch_id: null, approved_at: '2026-09-16T02:00:00.000Z', settled_at: null },
        { claim_id: 'claim-v6-draft', employee_id: null, department_id: null, department_text: '営業部', claimant_name: 'テスト太郎', advance_id: null, payout_batch_id: null, approved_at: null, settled_at: null },
        { claim_id: 'claim-v6-settled', employee_id: null, department_id: null, department_text: '営業部', claimant_name: 'テスト太郎', advance_id: null, payout_batch_id: null, approved_at: '2026-09-16T02:00:00.000Z', settled_at: '2026-09-17T03:00:00.000Z' },
      ]);
      const items = db.prepare(`SELECT claim_id, item_id, transaction_date, amount, category_id, corporate, payee_key FROM expense_item_refs ORDER BY claim_id, item_id`).all();
      expect(items).toEqual([
        { claim_id: 'claim-v6-approved', item_id: 'item-1', transaction_date: '2026-09-10', amount: 3200, category_id: 'transport.taxi', corporate: 0, payee_key: 'サンプル交通' },
        { claim_id: 'claim-v6-approved', item_id: 'item-2', transaction_date: '2026-09-11', amount: 1980, category_id: 'meal.meeting', corporate: 0, payee_key: 'サンプル喫茶' },
        { claim_id: 'claim-v6-draft', item_id: 'item-1', transaction_date: '2026-09-10', amount: 3200, category_id: 'transport.taxi', corporate: 0, payee_key: 'サンプル交通' },
        { claim_id: 'claim-v6-draft', item_id: 'item-2', transaction_date: '2026-09-11', amount: 1980, category_id: 'meal.meeting', corporate: 1, payee_key: 'サンプル喫茶' },
        { claim_id: 'claim-v6-settled', item_id: 'item-1', transaction_date: '2026-09-10', amount: 3200, category_id: 'transport.taxi', corporate: 0, payee_key: 'サンプル交通' },
        { claim_id: 'claim-v6-settled', item_id: 'item-2', transaction_date: '2026-09-11', amount: 1980, category_id: 'meal.meeting', corporate: 0, payee_key: 'サンプル喫茶' },
      ]);
      // 承認者は MVP の申請から作れない（1 段の承認には段の承認者がいない）ので埋めない。
      expect(db.prepare(`SELECT COUNT(*) AS n FROM expense_claim_approvers`).get()).toMatchObject({ n: 0 });
    } finally { db.close(); }
  });

  it('境界: 索引の行が無い明細の支払先キーは NULL（明細の値そのものは埋まる）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      EXPENSE_MIGRATION.apply(db);
      insertV6Claim(db, v6Claim('checked'));
      db.exec(`DELETE FROM expense_item_keys WHERE item_id='item-2'`);
      EXPENSE_V9_MIGRATION.apply(db);
      expect(db.prepare(`SELECT item_id, amount, payee_key FROM expense_item_refs ORDER BY item_id`).all()).toEqual([
        { item_id: 'item-1', amount: 3200, payee_key: 'サンプル交通' },
        { item_id: 'item-2', amount: 1980, payee_key: null },
      ]);
    } finally { db.close(); }
  });

  it('境界: 2 回流しても行数は同じで、新しいコードが入れ直した行を上書きしない', () => {
    const db = new DatabaseSync(':memory:');
    try {
      EXPENSE_MIGRATION.apply(db);
      insertV6Claim(db, v6Claim('approved'));
      insertV6Claim(db, v6Claim('draft'));
      EXPENSE_V9_MIGRATION.apply(db);
      const first = counts(db);
      expect(first).toEqual({ expense_claim_refs: 2, expense_item_refs: 4 });
      db.exec(`UPDATE expense_claim_refs SET employee_id='emp-taro' WHERE claim_id='claim-v6-approved'`);
      EXPENSE_V9_MIGRATION.apply(db);
      expect(counts(db)).toEqual(first);
      expect(db.prepare(`SELECT employee_id FROM expense_claim_refs WHERE claim_id='claim-v6-approved'`).get()).toMatchObject({ employee_id: 'emp-taro' });
    } finally { db.close(); }
  });

  it('正常: 埋め戻した索引から集計の入力（listItemFacts）が既存の承認済み・精算済みの申請を含む', async () => {
    const database = openSqliteDatabase();
    const claims = new SqliteExpenseClaimRepository(database);
    try {
      // 新しい DB に MVP の保存のまま申請を入れ（派生索引なし）、開き直しと同じく v9 の文を流し直す。
      insertV6Claim(database.handle, v6Claim('approved'));
      insertV6Claim(database.handle, v6Claim('settled'));
      insertV6Claim(database.handle, v6Claim('draft'));
      const tenant = { tenantId: 'local', workspaceId: 'default' };
      expect(await claims.listItemFacts(tenant, { limit: 100 })).toEqual([]);
      EXPENSE_V9_MIGRATION.apply(database.handle);
      const facts = await claims.listItemFacts(tenant, { statuses: ['approved', 'settled'], limit: 100 });
      expect(facts.map((fact) => `${fact.claimId}/${fact.itemId}`)).toEqual(['claim-v6-approved/item-1', 'claim-v6-approved/item-2', 'claim-v6-settled/item-1', 'claim-v6-settled/item-2']);
      expect(facts[3]).toEqual({
        claimId: 'claim-v6-settled', itemId: 'item-2', status: 'settled', transactionDate: '2026-09-11', amount: 1980, categoryId: 'meal.meeting', corporate: false,
        claimantName: 'テスト太郎', departmentText: '営業部', approvedAt: '2026-09-16T02:00:00.000Z', settledAt: '2026-09-17T03:00:00.000Z',
      });
      expect((await claims.list(tenant, { unlinked: true })).map((summary) => summary.id)).toHaveLength(3);
    } finally { database.close(); }
  });

  it('異常: 一意制約（社員番号・ログイン ID・カードの行の dedupe_key・取込ファイルの SHA-256）が DB で効く。NULL の社員番号と別スコープは重ならない', () => {
    const database = openSqliteDatabase();
    const db = database.handle;
    try {
      const employee = db.prepare(`INSERT INTO expense_employees (tenant_id, workspace_id, id, code_key, name_key, department_id, manager_id, enabled, updated_at, record_json) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 'x', '{}')`);
      employee.run('t', 'w', 'e1', 'e001', 'a');
      expect(() => employee.run('t', 'w', 'e2', 'e001', 'b')).toThrow(/UNIQUE/u);
      employee.run('t', 'w', 'e3', null, 'c');
      employee.run('t', 'w', 'e4', null, 'd');
      employee.run('t', 'other', 'e1', 'e001', 'a');

      const subject = db.prepare(`INSERT INTO expense_employee_subjects (tenant_id, workspace_id, subject, employee_id) VALUES (?, ?, ?, ?)`);
      subject.run('t', 'w', 'taro@example.com', 'e1');
      expect(() => subject.run('t', 'w', 'taro@example.com', 'e3')).toThrow(/UNIQUE|PRIMARY/u);
      subject.run('t', 'other', 'taro@example.com', 'e1');

      const transaction = db.prepare(`INSERT INTO expense_card_transactions (tenant_id, workspace_id, id, import_id, card_id, used_on, amount, merchant_key, status, claim_id, item_id, dedupe_key, record_json) VALUES (?, ?, ?, 'i', 'c', '2026-09-10', 100, 'm', 'unmatched', NULL, NULL, ?, '{}')`);
      transaction.run('t', 'w', 'tx-1', 'c|2026-09-10|100|m|0');
      expect(() => transaction.run('t', 'w', 'tx-2', 'c|2026-09-10|100|m|0')).toThrow(/UNIQUE/u);
      transaction.run('t', 'w', 'tx-3', 'c|2026-09-10|100|m|1');
      transaction.run('t', 'other', 'tx-1', 'c|2026-09-10|100|m|0');

      const cardImport = db.prepare(`INSERT INTO expense_card_imports (tenant_id, workspace_id, id, file_sha256, card_id, period_from, period_to, created_at, record_json) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'x', '{}')`);
      cardImport.run('t', 'w', 'import-1', 'a'.repeat(64));
      expect(() => cardImport.run('t', 'w', 'import-2', 'a'.repeat(64))).toThrow(/UNIQUE/u);
      cardImport.run('t', 'other', 'import-1', 'a'.repeat(64));
    } finally { database.close(); }
  });
});
