/**
 * adapters層: 経費精算（docs/21-expense.md §12）のスキーマ（version 6）。
 *
 * 業務のテーブルは業務ごとのファイルに置き、`migrations.ts` の `MIGRATIONS` はそれを並べるだけにする（ADR-0039）。
 * 予約版が残る期間は開くたびに流し直されるので、**すべて `IF NOT EXISTS` で冪等**に書く。
 *
 * - 本体は `record_json`（domain の Serialized 型）で、絞り込みと並びに使う値だけを列へ出す（仕訳 v5 と同じ方針）。
 * - `expense_receipts` は証憑画像を申請から分ける（一覧・判定・ツールが画像を読まないため）。
 * - `expense_item_keys` は重複検出の**派生の索引**。申請の保存と同じトランザクションでその申請の行を入れ直す。
 *   正本は `expense_claims.record_json` で、この表だけが壊れても申請から再生成できる。
 */
import { statementMigration } from './schema-migration';

export const EXPENSE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS expense_policy (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id)
  )`,
  `CREATE TABLE IF NOT EXISTS expense_claims (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    status TEXT NOT NULL, verdict TEXT, claimant_key TEXT NOT NULL,
    period_from TEXT NOT NULL, period_to TEXT NOT NULL, total_amount INTEGER NOT NULL,
    created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claims_scope_status ON expense_claims (tenant_id, workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claims_scope_period ON expense_claims (tenant_id, workspace_id, period_from, period_to)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_claims_scope_claimant ON expense_claims (tenant_id, workspace_id, claimant_key)`,
  `CREATE TABLE IF NOT EXISTS expense_receipts (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    claim_id TEXT NOT NULL, item_id TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_receipts_scope_claim ON expense_receipts (tenant_id, workspace_id, claim_id)`,
  `CREATE TABLE IF NOT EXISTS expense_item_keys (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, claim_id TEXT NOT NULL, item_id TEXT NOT NULL,
    transaction_date TEXT, amount INTEGER, payee_key TEXT, category_id TEXT, receipt_sha256 TEXT,
    PRIMARY KEY (tenant_id, workspace_id, claim_id, item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expense_item_keys_scope_date_amount ON expense_item_keys (tenant_id, workspace_id, transaction_date, amount)`,
  `CREATE INDEX IF NOT EXISTS idx_expense_item_keys_scope_sha ON expense_item_keys (tenant_id, workspace_id, receipt_sha256)`,
];

export const EXPENSE_MIGRATION = statementMigration(6, 'expense (policy, claims, receipts, duplicate index)', EXPENSE_STATEMENTS);
