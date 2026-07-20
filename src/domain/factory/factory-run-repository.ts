import type { TenantScope } from '../tool/ids';
import type { FactoryRun, FactoryRunStatus } from './factory-run';

export interface FactoryRunRepository {
  save(run: FactoryRun): Promise<void>;
  find(scope: TenantScope, runId: string): Promise<FactoryRun | null>;
  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: FactoryRunStatus }): Promise<FactoryRun[]>;
}
