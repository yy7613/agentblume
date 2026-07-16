import type { TenantScope } from '../tool/ids';
import type { HarnessRunRecord, HarnessRunStatus } from './harness-run';

export interface HarnessRunRepository {
  save(record: HarnessRunRecord): Promise<void>;
  find(scope: TenantScope, runId: string): Promise<HarnessRunRecord | null>;
  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: HarnessRunStatus }): Promise<HarnessRunRecord[]>;
}
