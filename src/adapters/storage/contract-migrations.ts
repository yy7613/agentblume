/**
 * adapters層: 契約書レビューと期限台帳（docs/23-contract.md §8）のスキーマ（version 8）。
 *
 * 業務のテーブルは業務ごとのファイルに置き、`migrations.ts` の `MIGRATIONS` はそれを並べるだけにする（ADR-0039）。
 * 本体は各集約の `record_json`（domain の Serialized 型）で、**絞り込みと並びに使う値だけを列へ出す**。
 * 予約版（6・7）が残っている間は開くたびに流し直されるので、すべて `IF NOT EXISTS` で冪等に書く。
 *
 * - 文書は状態で絞るので (scope, status) に索引。レビューは文書からの逆引きだけなので document_id に索引。
 * - 締結済み契約は 1 文書 1 件なので (scope, document_id) を一意にする（二重の締結登録を DB でも止める）。
 * - 期限は契約の `deadlines[]` の投影。契約の保存と同じトランザクションで削除 → 再挿入し、
 *   期限の近い順の一覧（台帳・`contract_deadlines` ツール）を (scope, status, due_date) の索引で引く。
 */
import { statementMigration } from './schema-migration';

export const CONTRACT_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS contract_playbooks (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    name TEXT NOT NULL, is_default INTEGER NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS contract_documents (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    status TEXT NOT NULL, title TEXT NOT NULL, counterparty_name TEXT, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contract_documents_scope_status ON contract_documents (tenant_id, workspace_id, status)`,
  `CREATE TABLE IF NOT EXISTS contract_reviews (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    document_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contract_reviews_scope_document ON contract_reviews (tenant_id, workspace_id, document_id)`,
  `CREATE TABLE IF NOT EXISTS contract_signed_contracts (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    document_id TEXT NOT NULL, status TEXT NOT NULL, counterparty_name TEXT NOT NULL, signed_date TEXT NOT NULL,
    created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contract_signed_scope_status ON contract_signed_contracts (tenant_id, workspace_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_signed_scope_document ON contract_signed_contracts (tenant_id, workspace_id, document_id)`,
  `CREATE TABLE IF NOT EXISTS contract_deadlines (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, contract_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contract_deadlines_scope_due ON contract_deadlines (tenant_id, workspace_id, status, due_date)`,
];

export const CONTRACT_MIGRATION = statementMigration(8, 'contract (playbooks, documents, reviews, signed contracts, deadlines)', CONTRACT_STATEMENTS);
