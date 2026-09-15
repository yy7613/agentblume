/**
 * adapters層: 入金消込（docs/22-receivables.md §9）のスキーマ（version 7）。
 *
 * 業務のテーブルは業務ごとのファイルに置き、`migrations.ts` の `MIGRATIONS` はそれを並べるだけにする（ADR-0039）。
 * 並行実装中は手前の版が予約版のままのことがあり、そのあいだは開くたびに流し直されるので、すべて `IF NOT EXISTS` で冪等に書く。
 *
 * 本体は `record_json`（domain の Serialized 型）で、**絞り込み・並び・一意性に使う値だけを列へ出す**。
 * - 請求書番号は下書きで NULL。部分一意索引で発行済みだけを一意にする。発行日・取引先も下書きでは空のことがある
 *   （ツールの請求書案や JSON 貼付は発行日を人に決めてもらうため）。
 * - `outstanding_amount` は期日超過の一覧の索引用の非正規化値で、消込の確定 / 取消と同じ UnitOfWork で更新する。
 * - 明細の指紋の一意索引が重複取込の最後の砦（アプリ側の事前チェックと競合しても二重に入らない）。
 * - 配分表は請求からの逆引き（入金履歴・取消の可否）用。消込の record_json と同じ書き込みで更新する。
 */
import { statementMigration } from './schema-migration';

export const RECEIVABLES_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS receivables_settings (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id)
  )`,
  `CREATE TABLE IF NOT EXISTS receivables_customers (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    enabled INTEGER NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS receivables_invoices (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    invoice_number TEXT, customer_id TEXT, status TEXT NOT NULL,
    issue_date TEXT, due_date TEXT, outstanding_amount INTEGER NOT NULL,
    created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_receivables_invoices_number ON receivables_invoices (tenant_id, workspace_id, invoice_number) WHERE invoice_number IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_receivables_invoices_scope_status_due ON receivables_invoices (tenant_id, workspace_id, status, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_receivables_invoices_scope_customer ON receivables_invoices (tenant_id, workspace_id, customer_id)`,
  `CREATE TABLE IF NOT EXISTS receivables_invoice_sequences (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, series_key TEXT NOT NULL, next_value INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, series_key)
  )`,
  `CREATE TABLE IF NOT EXISTS receivables_bank_csv_profiles (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS receivables_bank_transactions (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    account_key TEXT NOT NULL, transaction_date TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_receivables_bank_transactions_fingerprint ON receivables_bank_transactions (tenant_id, workspace_id, fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_receivables_bank_transactions_scope_status_date ON receivables_bank_transactions (tenant_id, workspace_id, status, transaction_date)`,
  `CREATE TABLE IF NOT EXISTS receivables_matchings (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    transaction_id TEXT NOT NULL, status TEXT NOT NULL, confirmed_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receivables_matchings_scope_transaction ON receivables_matchings (tenant_id, workspace_id, transaction_id)`,
  `CREATE TABLE IF NOT EXISTS receivables_matching_allocations (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, matching_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
    amount INTEGER NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, matching_id, invoice_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_receivables_matching_allocations_scope_invoice ON receivables_matching_allocations (tenant_id, workspace_id, invoice_id)`,
];

export const RECEIVABLES_MIGRATION = statementMigration(7, 'receivables (settings, customers, invoices, bank CSV profiles, bank transactions, matchings)', RECEIVABLES_STATEMENTS);
