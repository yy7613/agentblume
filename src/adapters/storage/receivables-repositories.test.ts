/**
 * 入金消込 BC の 6 つのリポジトリ: InMemory と SQLite が**同じ共有契約**を満たすことを確かめる。
 * SQLite にしか無い性質（列への値の出し方・配分表・壊れた行・マイグレーションの冪等性）は追加で見る。
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ReceivablesDomainError } from '../../domain/receivables/errors';
import {
  InMemoryBankCsvProfileRepository, InMemoryBankTransactionRepository, InMemoryCustomerRepository, InMemoryInvoiceRepository,
  InMemoryMatchingRepository, InMemoryReceivablesSettingsRepository,
} from './in-memory-receivables-repositories';
import { RECEIVABLES_MIGRATION, RECEIVABLES_STATEMENTS } from './receivables-migrations';
import {
  bankCsvProfileRepositoryContract, bankTransactionRepositoryContract, customerRepositoryContract, invoiceRepositoryContract,
  matchingRepositoryContract, receivablesSettingsRepositoryContract,
} from './receivables-repository.contract';
import { invoiceFixture, issuedInvoiceFixture, matchingFixture, scope } from './receivables-repository.fixtures';
import { openSqliteDatabase } from './sqlite-database';
import {
  SqliteBankCsvProfileRepository, SqliteBankTransactionRepository, SqliteCustomerRepository, SqliteInvoiceRepository,
  SqliteMatchingRepository, SqliteReceivablesSettingsRepository,
} from './sqlite-receivables-repositories';

describe.each([
  ['設定', receivablesSettingsRepositoryContract, () => new InMemoryReceivablesSettingsRepository(), () => new SqliteReceivablesSettingsRepository()],
  ['取引先', customerRepositoryContract, () => new InMemoryCustomerRepository(), () => new SqliteCustomerRepository()],
  ['請求書', invoiceRepositoryContract, () => new InMemoryInvoiceRepository(), () => new SqliteInvoiceRepository()],
  ['明細 CSV プロファイル', bankCsvProfileRepositoryContract, () => new InMemoryBankCsvProfileRepository(), () => new SqliteBankCsvProfileRepository()],
  ['入金明細', bankTransactionRepositoryContract, () => new InMemoryBankTransactionRepository(), () => new SqliteBankTransactionRepository()],
  ['消込', matchingRepositoryContract, () => new InMemoryMatchingRepository(), () => new SqliteMatchingRepository()],
] as const)('%s リポジトリ', (_name, contract, makeMemory, makeSqlite) => {
  it('in-memory 実装が共有契約を満たす', async () => {
    await contract(makeMemory() as never);
  });

  it('sqlite 実装が共有契約を満たす', async () => {
    const repo = makeSqlite();
    try { await contract(repo as never); } finally { repo.close(); }
  });
});

describe('SQLite 固有の性質', () => {
  it('請求書: 絞り込み用の列（番号・取引先・状態・発行日・期日・未入金額）を出す。下書きは番号・発行日が NULL', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteInvoiceRepository(database);
    try {
      await repo.save(invoiceFixture('draft', { issueDate: undefined, customerId: undefined }));
      await repo.save(issuedInvoiceFixture('issued', 'INV-1'));
      expect(database.handle.prepare(`SELECT invoice_number, customer_id, status, issue_date, outstanding_amount FROM receivables_invoices WHERE id=?`).get('draft'))
        .toMatchObject({ invoice_number: null, customer_id: null, status: 'draft', issue_date: null, outstanding_amount: 0 });
      expect(database.handle.prepare(`SELECT invoice_number, due_date, outstanding_amount FROM receivables_invoices WHERE id=?`).get('issued'))
        .toMatchObject({ invoice_number: 'INV-1', due_date: '2026-10-10', outstanding_amount: 110_500 });
    } finally { database.close(); }
  });

  it('消込: 配分表に請求ごとの行を状態つきで書き、取消で状態が変わる', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteMatchingRepository(database);
    try {
      const matching = matchingFixture('m');
      await repo.save(matching);
      await repo.save({ ...matching, status: 'cancelled', cancelledAt: matching.confirmedAt });
      expect(database.handle.prepare(`SELECT invoice_id, amount, status FROM receivables_matching_allocations WHERE matching_id=? ORDER BY invoice_id`).all('m'))
        .toEqual([{ invoice_id: 'i-1', amount: 33_000, status: 'cancelled' }, { invoice_id: 'i-2', amount: 22_000, status: 'cancelled' }]);
    } finally { database.close(); }
  });

  it('連番: 外側のトランザクションを巻き戻すと採番も巻き戻る（二重採番も欠番もしない）', async () => {
    const database = openSqliteDatabase();
    const repo = new SqliteInvoiceRepository(database);
    try {
      const outer = database.enterTransaction();
      expect(await repo.nextNumber(scope, 'S')).toBe(1);
      outer.rollback();
      expect(await repo.nextNumber(scope, 'S')).toBe(1);
      expect(await repo.nextNumber(scope, 'S')).toBe(2);
    } finally { database.close(); }
  });

  it('例外: 壊れた record_json は読み出し時に ReceivablesDomainError（黙って null にしない）', async () => {
    const database = openSqliteDatabase();
    try {
      const broken = JSON.stringify({ id: 'broken' });
      const at = '2026-09-14T00:00:00.000Z';
      database.handle.prepare(`INSERT INTO receivables_settings VALUES (?, ?, ?)`).run(scope.tenantId, scope.workspaceId, broken);
      database.handle.prepare(`INSERT INTO receivables_customers VALUES (?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 1, at, broken);
      database.handle.prepare(`INSERT INTO receivables_invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', null, null, 'draft', null, null, 0, at, broken);
      database.handle.prepare(`INSERT INTO receivables_bank_csv_profiles VALUES (?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', at, broken);
      database.handle.prepare(`INSERT INTO receivables_bank_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 'main', '2026-09-30', 1, 'unmatched', 'fp', at, broken);
      database.handle.prepare(`INSERT INTO receivables_matchings VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scope.tenantId, scope.workspaceId, 'broken', 'tx', 'confirmed', at, broken);
      await expect(new SqliteReceivablesSettingsRepository(database).get(scope)).rejects.toThrow(ReceivablesDomainError);
      await expect(new SqliteCustomerRepository(database).list(scope)).rejects.toThrow(ReceivablesDomainError);
      await expect(new SqliteInvoiceRepository(database).findById(scope, 'broken')).rejects.toThrow(ReceivablesDomainError);
      await expect(new SqliteBankCsvProfileRepository(database).findById(scope, 'broken')).rejects.toThrow(ReceivablesDomainError);
      await expect(new SqliteBankTransactionRepository(database).list(scope)).rejects.toThrow(ReceivablesDomainError);
      await expect(new SqliteMatchingRepository(database).findById(scope, 'broken')).rejects.toThrow(ReceivablesDomainError);
    } finally { database.close(); }
  });

  it('マイグレーション: version 7 の文は冪等（開くたびに流し直しても壊れない）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      expect(RECEIVABLES_MIGRATION).toMatchObject({ version: 7 });
      expect(RECEIVABLES_MIGRATION.description.startsWith('receivables')).toBe(true);
      expect(RECEIVABLES_MIGRATION.placeholder).toBeUndefined();
      RECEIVABLES_MIGRATION.apply(db);
      RECEIVABLES_MIGRATION.apply(db);
      expect(RECEIVABLES_STATEMENTS.every((statement) => /IF NOT EXISTS/u.test(statement))).toBe(true);
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'receivables_%' ORDER BY name`).all().map((row) => row['name']);
      expect(tables).toEqual(['receivables_bank_csv_profiles', 'receivables_bank_transactions', 'receivables_customers', 'receivables_invoice_sequences', 'receivables_invoices', 'receivables_matching_allocations', 'receivables_matchings', 'receivables_settings']);
    } finally { db.close(); }
  });
});
