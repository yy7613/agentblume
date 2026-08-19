import type { HarnessRunRecord, HarnessRunStatus } from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';

function key(scope: TenantScope, runId: string): string { return `${tenantKey(scope)} ${runId}`; }
export class InMemoryHarnessRunRepository implements HarnessRunRepository {
  private readonly store = new Map<string, HarnessRunRecord>();
  async save(record: HarnessRunRecord): Promise<void> { this.store.set(key(record.scope, record.runId), structuredClone(record)); }
  async find(scope: TenantScope, runId: string): Promise<HarnessRunRecord | null> { const record = this.store.get(key(scope, runId)); return record === undefined ? null : structuredClone(record); }
  async list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: HarnessRunRecord['status'] }): Promise<HarnessRunRecord[]> {
    return [...this.store.values()].filter((record) => tenantKey(record.scope) === tenantKey(scope) && (options?.status === undefined || record.status === options.status)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, options?.limit ?? 100).map((record) => structuredClone(record));
  }
  async listAllByStatus(status: HarnessRunStatus): Promise<HarnessRunRecord[]> {
    return [...this.store.values()].filter((record) => record.status === status).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((record) => structuredClone(record));
  }
}
