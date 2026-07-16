import { DatabaseSync } from 'node:sqlite';
import type { HarnessRunRecord } from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';
import type { TenantScope } from '../../domain/tool/ids';

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS harness_runs (
  tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, run_id)
);`;
function fromJson(value: unknown): HarnessRunRecord { return JSON.parse(String(value)) as HarnessRunRecord; }
export class SqliteHarnessRunRepository implements HarnessRunRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(CREATE_TABLE); }
  close(): void { this.db.close(); }
  async save(record: HarnessRunRecord): Promise<void> {
    this.db.prepare(`INSERT INTO harness_runs (tenant_id, workspace_id, run_id, status, started_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, workspace_id, run_id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json`).run(record.scope.tenantId, record.scope.workspaceId, record.runId, record.status, record.startedAt, JSON.stringify(record));
  }
  async find(scope: TenantScope, runId: string): Promise<HarnessRunRecord | null> { const row = this.db.prepare(`SELECT record_json FROM harness_runs WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?`).get(scope.tenantId, scope.workspaceId, runId); return row === undefined ? null : fromJson(row['record_json']); }
  async list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: HarnessRunRecord['status'] }): Promise<HarnessRunRecord[]> {
    const rows = options?.status === undefined
      ? this.db.prepare(`SELECT record_json FROM harness_runs WHERE tenant_id = ? AND workspace_id = ? ORDER BY started_at DESC LIMIT ?`).all(scope.tenantId, scope.workspaceId, options?.limit ?? 100)
      : this.db.prepare(`SELECT record_json FROM harness_runs WHERE tenant_id = ? AND workspace_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?`).all(scope.tenantId, scope.workspaceId, options.status, options?.limit ?? 100);
    return rows.map((row) => fromJson(row['record_json']));
  }
}
