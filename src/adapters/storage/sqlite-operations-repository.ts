import { DatabaseSync } from 'node:sqlite';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { utcDayStart, type OperationsDailyMetric, type RetentionPolicy, type RunFeedback, type RunMetricSample } from '../../domain/operations/operations';
import { deserializeDailyMetric, deserializeFeedback, deserializeRetentionPolicy, serializeDailyMetric, serializeFeedback, serializeRetentionPolicy } from '../../domain/operations/serialization';
import type { TenantScope } from '../../domain/tool/ids';

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS run_feedback (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_run_feedback_scope_updated ON run_feedback (tenant_id, workspace_id, updated_at);
  CREATE TABLE IF NOT EXISTS operations_daily_metrics (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, bucket_start TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, bucket_start)
  );
  CREATE TABLE IF NOT EXISTS retention_policies (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id)
  );
`;

export class SqliteOperationsRepository implements OperationsRepository {
  private readonly db: DatabaseSync;
  constructor(path: string = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(CREATE_TABLES_SQL); }
  close(): void { this.db.close(); }

  async saveFeedback(record: RunFeedback): Promise<void> {
    const serialized = serializeFeedback(record);
    this.db.prepare(`INSERT INTO run_feedback (tenant_id, workspace_id, run_id, updated_at, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, workspace_id, run_id) DO UPDATE SET updated_at = excluded.updated_at, record_json = excluded.record_json`)
      .run(record.scope.tenantId, record.scope.workspaceId, record.runId, record.updatedAt, JSON.stringify(serialized));
  }
  async findFeedback(scope: TenantScope, runId: string): Promise<RunFeedback | null> {
    const row = this.db.prepare(`SELECT record_json FROM run_feedback WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?`).get(scope.tenantId, scope.workspaceId, runId);
    return row === undefined ? null : deserializeFeedback(JSON.parse(String(row['record_json'])));
  }

  async recordRunMetric(sample: RunMetricSample): Promise<void> {
    const bucketStart = utcDayStart(sample.recordedAt);
    const current = this.findMetric(sample.scope, bucketStart) ?? emptyMetric(sample.scope, bucketStart);
    this.saveMetric({ ...current, runCount: current.runCount + 1, failureCount: current.failureCount + (sample.status === 'failed' ? 1 : 0), latencySamples: [...current.latencySamples, sample.latencyMs], totalTokens: current.totalTokens + (sample.totalTokens ?? 0), estimatedCost: current.estimatedCost + (sample.estimatedCost ?? 0), pricedRunCount: current.pricedRunCount + (sample.estimatedCost === undefined ? 0 : 1) });
  }
  async recordFeedbackMetric(scope: TenantScope, recordedAt: string): Promise<void> {
    const bucketStart = utcDayStart(recordedAt);
    const current = this.findMetric(scope, bucketStart) ?? emptyMetric(scope, bucketStart);
    this.saveMetric({ ...current, feedbackCount: current.feedbackCount + 1 });
  }
  async listDailyMetrics(scope: TenantScope, from?: string): Promise<OperationsDailyMetric[]> {
    const rows = from === undefined
      ? this.db.prepare(`SELECT record_json FROM operations_daily_metrics WHERE tenant_id = ? AND workspace_id = ? ORDER BY bucket_start`).all(scope.tenantId, scope.workspaceId)
      : this.db.prepare(`SELECT record_json FROM operations_daily_metrics WHERE tenant_id = ? AND workspace_id = ? AND bucket_start >= ? ORDER BY bucket_start`).all(scope.tenantId, scope.workspaceId, from);
    return rows.map((row) => deserializeDailyMetric(JSON.parse(String(row['record_json']))));
  }

  async getRetentionPolicy(scope: TenantScope): Promise<RetentionPolicy | null> {
    const row = this.db.prepare(`SELECT record_json FROM retention_policies WHERE tenant_id = ? AND workspace_id = ?`).get(scope.tenantId, scope.workspaceId);
    return row === undefined ? null : deserializeRetentionPolicy(JSON.parse(String(row['record_json'])));
  }
  async saveRetentionPolicy(policy: RetentionPolicy): Promise<void> {
    const serialized = serializeRetentionPolicy(policy);
    this.db.prepare(`INSERT INTO retention_policies (tenant_id, workspace_id, record_json) VALUES (?, ?, ?)
      ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET record_json = excluded.record_json`)
      .run(policy.scope.tenantId, policy.scope.workspaceId, JSON.stringify(serialized));
  }
  async deleteFeedbackBefore(scope: TenantScope, before: string): Promise<number> {
    return Number(this.db.prepare(`DELETE FROM run_feedback WHERE tenant_id = ? AND workspace_id = ? AND updated_at <= ?`).run(scope.tenantId, scope.workspaceId, before).changes);
  }
  async deleteMetricsBefore(scope: TenantScope, before: string): Promise<number> {
    return Number(this.db.prepare(`DELETE FROM operations_daily_metrics WHERE tenant_id = ? AND workspace_id = ? AND bucket_start <= ?`).run(scope.tenantId, scope.workspaceId, before).changes);
  }

  private findMetric(scope: TenantScope, bucketStart: string): OperationsDailyMetric | null {
    const row = this.db.prepare(`SELECT record_json FROM operations_daily_metrics WHERE tenant_id = ? AND workspace_id = ? AND bucket_start = ?`).get(scope.tenantId, scope.workspaceId, bucketStart);
    return row === undefined ? null : deserializeDailyMetric(JSON.parse(String(row['record_json'])));
  }
  private saveMetric(metric: OperationsDailyMetric): void {
    const serialized = serializeDailyMetric(metric);
    this.db.prepare(`INSERT INTO operations_daily_metrics (tenant_id, workspace_id, bucket_start, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, workspace_id, bucket_start) DO UPDATE SET record_json = excluded.record_json`)
      .run(metric.scope.tenantId, metric.scope.workspaceId, metric.bucketStart, JSON.stringify(serialized));
  }
}

function emptyMetric(scope: TenantScope, bucketStart: string): OperationsDailyMetric {
  return { scope: { ...scope }, bucketStart, runCount: 0, failureCount: 0, latencySamples: [], totalTokens: 0, estimatedCost: 0, pricedRunCount: 0, feedbackCount: 0 };
}
