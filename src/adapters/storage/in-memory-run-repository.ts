import type { TenantScope } from '../../domain/tool/ids';
import type { ListRunsOptions, RunRepository } from '../../domain/run/run-repository';
import type { RunRecord } from '../../domain/run/run';
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
}
