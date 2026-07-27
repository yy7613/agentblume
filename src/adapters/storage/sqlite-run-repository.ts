import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import { redactRun, type RunRecord } from '../../domain/run/run';
import type { ListRunsOptions, RunRepository, RunRetentionOptions, RunRetentionResult } from '../../domain/run/run-repository';
import { deserializeRun, serializeRun } from '../../domain/run/serialization';
import type { TenantScope } from '../../domain/tool/ids';

function fromJson(value: unknown): RunRecord {
  return deserializeRun(JSON.parse(String(value)));
}
export class SqliteRunRepository extends SqliteRepositoryBase implements RunRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }

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

  async applyRetention(scope: TenantScope, options: RunRetentionOptions): Promise<RunRetentionResult> {
    const rows = this.db.prepare(`SELECT run_id, record_json FROM runs WHERE tenant_id = ? AND workspace_id = ?`).all(scope.tenantId, scope.workspaceId);
    let payloadRedacted = 0; let traceRedacted = 0; let deleted = 0;
    // 接続は共有なので、外側にトランザクションがあればSAVEPOINTとして合流する（BEGINの入れ子を避ける）。
    this.database.transaction(() => {
      for (const row of rows) {
        const record = fromJson(row['record_json']);
        if (record.startedAt <= options.deleteBefore) {
          this.db.prepare(`DELETE FROM runs WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?`).run(scope.tenantId, scope.workspaceId, String(row['run_id']));
          deleted += 1; continue;
        }
        const payload = record.startedAt <= options.payloadBefore && (record.response !== undefined || record.structuredResponse !== undefined || (record.failure !== undefined && record.failure.message !== '[redacted]'));
        const trace = record.startedAt <= options.traceBefore && record.trace.length > 0;
        if (!payload && !trace) continue;
        const next = serializeRun(redactRun(record, { payload, trace }));
        this.db.prepare(`UPDATE runs SET record_json = ? WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?`).run(JSON.stringify(next), scope.tenantId, scope.workspaceId, String(row['run_id']));
        if (payload) payloadRedacted += 1;
        if (trace) traceRedacted += 1;
      }
    });
    return { payloadRedacted, traceRedacted, deleted };
  }
}
