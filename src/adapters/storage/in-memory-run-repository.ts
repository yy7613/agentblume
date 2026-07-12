import type { TenantScope } from '../../domain/tool/ids';
import type { ListRunsOptions, RunRepository, RunRetentionOptions, RunRetentionResult } from '../../domain/run/run-repository';
import { redactRun, type RunRecord } from '../../domain/run/run';
import { deserializeRun, serializeRun } from '../../domain/run/serialization';

function key(scope: TenantScope, runId: string): string {
  return `${scope.tenantId}\u0000${scope.workspaceId}\u0000${runId}`;
}
export class InMemoryRunRepository implements RunRepository {
  private readonly records = new Map<string, RunRecord>();

  async save(record: RunRecord): Promise<void> {
    this.records.set(key(record.scope, record.runId), serializeRun(record));
  }

  async find(scope: TenantScope, runId: string): Promise<RunRecord | null> {
    const record = this.records.get(key(scope, runId));
    return record === undefined ? null : deserializeRun(record);
  }

  async list(scope: TenantScope, options?: ListRunsOptions): Promise<RunRecord[]> {
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
    return [...this.records.values()]
      .filter((record) => record.scope.tenantId === scope.tenantId && record.scope.workspaceId === scope.workspaceId && (options?.status === undefined || record.status === options.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(deserializeRun);
  }

  async applyRetention(scope: TenantScope, options: RunRetentionOptions): Promise<RunRetentionResult> {
    let payloadRedacted = 0; let traceRedacted = 0; let deleted = 0;
    for (const [recordKey, record] of this.records) {
      if (record.scope.tenantId !== scope.tenantId || record.scope.workspaceId !== scope.workspaceId) continue;
      if (record.startedAt <= options.deleteBefore) { this.records.delete(recordKey); deleted += 1; continue; }
      const payload = record.startedAt <= options.payloadBefore && (record.response !== undefined || record.structuredResponse !== undefined || (record.failure !== undefined && record.failure.message !== '[redacted]'));
      const trace = record.startedAt <= options.traceBefore && record.trace.length > 0;
      if (payload || trace) {
        this.records.set(recordKey, serializeRun(redactRun(record, { payload, trace })));
        if (payload) payloadRedacted += 1;
        if (trace) traceRedacted += 1;
      }
    }
    return { payloadRedacted, traceRedacted, deleted };
  }
}
