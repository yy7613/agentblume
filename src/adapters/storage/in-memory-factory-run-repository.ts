import type { FactoryRun, FactoryRunStatus } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';

function key(scope: TenantScope, runId: string): string { return `${tenantKey(scope)} ${runId}`; }
export class InMemoryFactoryRunRepository implements FactoryRunRepository {
  private readonly store = new Map<string, FactoryRun>();
  async save(run: FactoryRun): Promise<void> { this.store.set(key(run.scope, run.id), structuredClone(run)); }
  async find(scope: TenantScope, runId: string): Promise<FactoryRun | null> { const run = this.store.get(key(scope, runId)); return run === undefined ? null : structuredClone(run); }
  async list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: FactoryRunStatus }): Promise<FactoryRun[]> {
    return [...this.store.values()].filter((run) => tenantKey(run.scope) === tenantKey(scope) && (options?.status === undefined || run.status === options.status)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, options?.limit ?? 100).map((run) => structuredClone(run));
  }
  async listAllByStatus(status: FactoryRunStatus): Promise<FactoryRun[]> {
    return [...this.store.values()].filter((run) => run.status === status).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((run) => structuredClone(run));
  }
}
