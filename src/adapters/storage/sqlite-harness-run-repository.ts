import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { HarnessRunRecord, HarnessRunStatus } from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';
import type { TenantScope } from '../../domain/tool/ids';

function fromJson(value: unknown): HarnessRunRecord { return JSON.parse(String(value)) as HarnessRunRecord; }
export class SqliteHarnessRunRepository extends SqliteRepositoryBase implements HarnessRunRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
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
  async listAllByStatus(status: HarnessRunStatus): Promise<HarnessRunRecord[]> {
    return this.db.prepare(`SELECT record_json FROM harness_runs WHERE status = ? ORDER BY started_at ASC`).all(status).map((row) => fromJson(row['record_json']));
  }
}
