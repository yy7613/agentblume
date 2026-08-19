import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { FactoryRun, FactoryRunStatus } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { deserializeFactoryRun, serializeFactoryRun } from '../../domain/factory/serialization';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export class SqliteFactoryRunRepository extends SqliteRepositoryBase implements FactoryRunRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async save(run: FactoryRun): Promise<void> {
    this.db.prepare(`INSERT INTO factory_runs (tenant_id, workspace_id, run_id, status, started_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, workspace_id, run_id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json`).run(run.scope.tenantId, run.scope.workspaceId, run.id, run.status, run.startedAt, serializeFactoryRun(run));
  }
  async find(scope: TenantScope, runId: string): Promise<FactoryRun | null> { const row = this.db.prepare(`SELECT record_json FROM factory_runs WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?`).get(scope.tenantId, scope.workspaceId, runId); return row === undefined ? null : deserializeFactoryRun(String(row['record_json'])); }
  async list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: FactoryRunStatus }): Promise<FactoryRun[]> {
    const rows = options?.status === undefined
      ? this.db.prepare(`SELECT record_json FROM factory_runs WHERE tenant_id = ? AND workspace_id = ? ORDER BY started_at DESC LIMIT ?`).all(scope.tenantId, scope.workspaceId, options?.limit ?? 100)
      : this.db.prepare(`SELECT record_json FROM factory_runs WHERE tenant_id = ? AND workspace_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?`).all(scope.tenantId, scope.workspaceId, options.status, options?.limit ?? 100);
    return rows.map((row) => deserializeFactoryRun(String(row['record_json'])));
  }
  async listAllByStatus(status: FactoryRunStatus): Promise<FactoryRun[]> {
    return this.db.prepare(`SELECT record_json FROM factory_runs WHERE status = ? ORDER BY started_at ASC`).all(status).map((row) => deserializeFactoryRun(String(row['record_json'])));
  }
}
