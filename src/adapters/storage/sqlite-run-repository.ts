import { DatabaseSync } from 'node:sqlite';
import type { RunRecord } from '../../domain/run/run';
import type { ListRunsOptions, RunRepository } from '../../domain/run/run-repository';
import { deserializeRun, serializeRun } from '../../domain/run/serialization';
import type { TenantScope } from '../../domain/tool/ids';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS runs (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_runs_scope_started
    ON runs (tenant_id, workspace_id, started_at DESC);
`;

function fromJson(value: unknown): RunRecord {
  return deserializeRun(JSON.parse(String(value)));
}
export class SqliteRunRepository implements RunRepository {
  private readonly db: DatabaseSync;

  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(CREATE_TABLE_SQL);
  }

  close(): void { this.db.close(); }

  async save(record: RunRecord): Promise<void> {
    const data = serializeRun(record);
    this.db.prepare(`
      INSERT INTO runs (tenant_id, workspace_id, run_id, started_at, status, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, workspace_id, run_id) DO UPDATE SET
        started_at = excluded.started_at,
        status = excluded.status,
        record_json = excluded.record_json
    `).run(record.scope.tenantId, record.scope.workspaceId, record.runId, record.startedAt, record.status, JSON.stringify(data));
  }

  async find(scope: TenantScope, runId: string): Promise<RunRecord | null> {
    const row = this.db.prepare(`SELECT record_json FROM runs WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?`).get(scope.tenantId, scope.workspaceId, runId);
    return row === undefined ? null : fromJson(row['record_json']);
  }

  async list(scope: TenantScope, options?: ListRunsOptions): Promise<RunRecord[]> {
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
    const rows = options?.status === undefined
      ? this.db.prepare(`SELECT record_json FROM runs WHERE tenant_id = ? AND workspace_id = ? ORDER BY started_at DESC LIMIT ?`).all(scope.tenantId, scope.workspaceId, limit)
      : this.db.prepare(`SELECT record_json FROM runs WHERE tenant_id = ? AND workspace_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?`).all(scope.tenantId, scope.workspaceId, options.status, limit);
    return rows.map((row) => fromJson(row['record_json']));
  }
}
