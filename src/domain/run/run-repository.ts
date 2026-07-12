import type { TenantScope } from '../tool/ids';
import type { RunRecord, RunStatus } from './run';

export interface ListRunsOptions {
  readonly limit?: number;
  readonly status?: RunStatus;
}
export interface RunRetentionOptions {
  readonly payloadBefore: string;
  readonly traceBefore: string;
  readonly deleteBefore: string;
}
export interface RunRetentionResult { readonly payloadRedacted: number; readonly traceRedacted: number; readonly deleted: number }
export interface RunRepository {
  save(record: RunRecord): Promise<void>;
  find(scope: TenantScope, runId: string): Promise<RunRecord | null>;
  list(scope: TenantScope, options?: ListRunsOptions): Promise<RunRecord[]>;
  /** v26。カスタムRepositoryは未対応でも既存実行を継続できる。 */
  applyRetention?(scope: TenantScope, options: RunRetentionOptions): Promise<RunRetentionResult>;
}
