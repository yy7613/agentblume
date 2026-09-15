/**
 * adapters層: 仕訳（docs/20-journal.md）のスキーマ（version 5）。
 *
 * 業務のテーブルは業務ごとのファイルに置き、`migrations.ts` の `MIGRATIONS` はそれを並べるだけにする（ADR-0039）。
 */
import { statementMigration } from './schema-migration';

/**
 * version 5: 仕訳（`docs/20-journal.md` §11）。
 *
 * 5つの集約（科目マスタ・文書・ルール・仕訳・ヒアリング）を1テーブルずつ。本体は `record_json`
 * （domain の Serialized 型）で、**絞り込みと並びに使う値だけを列へ出す**。
 *
 * - `journal_chart` はワークスペースに1つなので (tenant_id, workspace_id) が主キー（id を持たない）。
 * - 文書は状態フィルタ（未判定だけ表示）と取引日の範囲が一覧の主な使われ方なので、その2つに索引を張る。
 * - ルールは判定のたびに全件を priority 順で読むため priority の索引を張る。
 * - 仕訳は状態（draft/confirmed）・仕訳日の範囲・文書からの逆引きの3経路があるので3本張る。
 * - ヒアリングは「その文書のヒアリング」だけを引くので document_id に張る。
 */
export const JOURNAL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS journal_chart (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id)
  )`,
  `CREATE TABLE IF NOT EXISTS journal_documents (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, transaction_date TEXT, created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_documents_scope_status ON journal_documents (tenant_id, workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_documents_scope_date ON journal_documents (tenant_id, workspace_id, transaction_date)`,
  `CREATE TABLE IF NOT EXISTS journal_rules (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    enabled INTEGER NOT NULL, priority INTEGER NOT NULL, created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_rules_scope_priority ON journal_rules (tenant_id, workspace_id, priority)`,
  `CREATE TABLE IF NOT EXISTS journal_entries (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    document_id TEXT, status TEXT NOT NULL, entry_date TEXT NOT NULL, created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_scope_status ON journal_entries (tenant_id, workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_scope_date ON journal_entries (tenant_id, workspace_id, entry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_scope_document ON journal_entries (tenant_id, workspace_id, document_id)`,
  `CREATE TABLE IF NOT EXISTS journal_hearings (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    document_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_hearings_scope_document ON journal_hearings (tenant_id, workspace_id, document_id)`,
];

export const JOURNAL_MIGRATION = statementMigration(5, 'journal (chart of accounts, documents, rules, entries, hearings)', JOURNAL_STATEMENTS);
