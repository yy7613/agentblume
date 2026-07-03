import type { TenantScope } from '../tool/ids';
import type { RunRecord, RunStatus } from './run';

export interface ListRunsOptions {
  readonly limit?: number;
  readonly status?: RunStatus;
}
export interface RunRepository {
  save(record: RunRecord): Promise<void>;
  find(scope: TenantScope, runId: string): Promise<RunRecord | null>;
  list(scope: TenantScope, options?: ListRunsOptions): Promise<RunRecord[]>;
}
