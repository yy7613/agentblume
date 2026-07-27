/**
 * adapters層: SQLite スキーマのマイグレーション（`PRAGMA user_version` ベース）。
 *
 * これまでスキーマは23個の `Sqlite*Repository` のコンストラクタに散らばった
 * `CREATE TABLE IF NOT EXISTS` と、12箇所のその場しのぎ `ALTER TABLE ADD COLUMN` で
 * 維持されていた。バージョン台帳が無いため「このDBがどの形か」を誰も判定できず、
 * ALTER経路はテストからも到達しなかった（テストは常に新規DBを開くので分岐が常にfalse）。
 *
 * ここでは番号付きマイグレーションへ集約する。
 *
 * ## version 1 の定義（既存DBとの互換が最重要）
 *
 * version 1 は「**現行スキーマ（全 CREATE TABLE + 12箇所のALTER適用後）**」と定義する。
 * ただし単に `user_version = 1` を刻むのではなく、**version 1 の適用そのものを冪等**にした:
 *
 *   1. 全テーブルを `CREATE TABLE IF NOT EXISTS`（最終形の列定義で）
 *   2. 旧DBに欠けうる列を `PRAGMA table_info` で調べて `ALTER TABLE ADD COLUMN`
 *   3. 全インデックスを `CREATE INDEX IF NOT EXISTS`
 *
 * これにより「空DB」も「旧スキーマのDB」も同じ1本の経路で version 1 へ収束する。
 * 旧DBを無検査で version 1 と見なすと、`deleted` 列が無いDBが「移行済み」と刻まれて
 * 次回以降のクエリが壊れるため、**必ず実際に不足分を補ってから**バージョンを刻む。
 * 行の削除・書き換えは一切しないので、既存データはそのまま残る。
 *
 * ## version 2 以降
 *
 * 以降は `statements` を並べるだけでよい（冪等性は不要。適用済みかは user_version が判定する）。
 *
 * ## 未来バージョンの拒否
 *
 * DBの `user_version` がコードの最新版より新しい場合は**起動を拒否**する。
 * 新しいコードが書いたデータを古いコードが壊すのを防ぐため、黙って続行してはならない。
 */
import type { DatabaseSync } from 'node:sqlite';

/** このコードが理解できるスキーマの最新版。 */
export const LATEST_SCHEMA_VERSION = 1;

/** version 1 で作られるテーブル（列定義は「ALTER適用後の最終形」）。 */
const BASELINE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tools (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS skills (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS personas (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS scenarios (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS evaluation_datasets (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS evaluator_profiles (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS judge_rubrics (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS gate_policies (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    record_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_harnesses (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, internal_id TEXT NOT NULL,
    version TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, patch INTEGER NOT NULL,
    definition_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, workspace_id, internal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    started_at TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS scenario_runs (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL, started_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS harness_runs (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS factory_runs (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS experiments (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, experiment_id TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, experiment_id)
  )`,
  `CREATE TABLE IF NOT EXISTS experiment_case_results (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, experiment_id TEXT NOT NULL,
    case_id TEXT NOT NULL, repetition INTEGER NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, experiment_id, case_id, repetition)
  )`,
  `CREATE TABLE IF NOT EXISTS gate_reports (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, report_id TEXT NOT NULL,
    candidate_experiment_id TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, report_id)
  )`,
  `CREATE TABLE IF NOT EXISTS promotion_requests (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, requested_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_pages (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    wiki_id TEXT NOT NULL DEFAULT 'default', updated_at TEXT NOT NULL, definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_spaces (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    updated_at TEXT NOT NULL, definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS memory_proposals (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL, definition_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS run_feedback (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS operations_daily_metrics (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, bucket_start TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, bucket_start)
  )`,
  `CREATE TABLE IF NOT EXISTS retention_policies (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS session_artifacts (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, record_json TEXT NOT NULL, payload_path TEXT,
    PRIMARY KEY (tenant_id, workspace_id, session_id, artifact_id),
    UNIQUE (tenant_id, workspace_id, session_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS data_sources (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, id TEXT NOT NULL,
    updated_at TEXT NOT NULL, record_json TEXT NOT NULL, file_content TEXT,
    PRIMARY KEY (tenant_id, workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
    updated_at TEXT NOT NULL, config_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS model_settings (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, settings_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id)
  )`,
];

/**
 * 旧スキーマのDBに欠けうる列。以前は12箇所のリポジトリのコンストラクタに散在していた
 * `PRAGMA table_info` → `ALTER TABLE ADD COLUMN` を、そのままここへ集約したもの。
 */
export const BASELINE_COLUMNS: readonly { readonly table: string; readonly column: string; readonly definition: string }[] = [
  { table: 'tools', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'agents', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'skills', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'personas', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'scenarios', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'evaluation_datasets', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'evaluator_profiles', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'judge_rubrics', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'gate_policies', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'agent_harnesses', column: 'deleted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'wiki_pages', column: 'wiki_id', definition: "TEXT NOT NULL DEFAULT 'default'" },
  { table: 'session_artifacts', column: 'payload_path', definition: 'TEXT' },
];

/** version 1 のインデックス。`wiki_id` を使うものがあるため列の補完より後に作る。 */
const BASELINE_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_runs_scope_started ON runs (tenant_id, workspace_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scenario_runs_scope_started ON scenario_runs (tenant_id, workspace_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_experiments_scope_created ON experiments (tenant_id, workspace_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gate_reports_candidate ON gate_reports (tenant_id, workspace_id, candidate_experiment_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_agent ON promotion_requests (tenant_id, workspace_id, agent_id, requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope_updated ON wiki_pages (tenant_id, workspace_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_scope_wiki_updated ON wiki_pages (tenant_id, workspace_id, wiki_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_proposals_scope_created ON memory_proposals (tenant_id, workspace_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_run_feedback_scope_updated ON run_feedback (tenant_id, workspace_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_expiry ON agent_sessions (status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_session_artifacts_list ON session_artifacts (tenant_id, workspace_id, session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_data_sources_scope_updated ON data_sources (tenant_id, workspace_id, updated_at DESC)`,
];

/** 1つのスキーマ版。`apply` は呼ばれた時点で必ずトランザクション内にある。 */
export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  apply(db: DatabaseSync): void;
}

/** 列が無ければ追加する（旧DBの取り込み専用。既存の行には既定値が入る）。 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => String(row['name']) === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** 適用順のマイグレーション一覧（version は 1 から連番）。 */
export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: 'baseline schema (all tables, legacy column back-fill, indexes)',
    apply(db) {
      for (const statement of BASELINE_TABLES) db.exec(statement);
      for (const { table, column, definition } of BASELINE_COLUMNS) addColumnIfMissing(db, table, column, definition);
      for (const statement of BASELINE_INDEXES) db.exec(statement);
    },
  },
];

/** DBに刻まれているスキーマ版を読む（未初期化なら 0）。 */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return row === undefined ? 0 : Number(row['user_version'] ?? 0);
}

/** マイグレーションの実行結果。 */
export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

/** コードが理解できない未来バージョンのDBを開こうとしたとき。 */
export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/**
 * 未適用のマイグレーションを順に適用し、`user_version` を進める。
 *
 * - 1バージョン = 1トランザクション。途中で失敗したらそのバージョンは丸ごと巻き戻る。
 * - 既に最新なら何もしない（冪等）。
 * - DBの方が新しければ `SchemaVersionError` で**起動を止める**（古いコードにデータを触らせない）。
 */
export function applyMigrations(db: DatabaseSync): MigrationResult {
  const from = readSchemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `database schema version ${from} is newer than this build supports (${LATEST_SCHEMA_VERSION}); upgrade agentblume instead of downgrading the database`,
    );
  }
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.apply(db);
      // user_version はバインドできないため定数を埋め込む（値はコード内の連番のみ）。
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.version);
  }
  return { from, to: readSchemaVersion(db), applied };
}
