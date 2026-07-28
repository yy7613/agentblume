import type { TenantScope } from '../tool/ids';
import type { HarnessRunRecord, HarnessRunStatus } from './harness-run';

export interface HarnessRunRepository {
  save(record: HarnessRunRecord): Promise<void>;
  find(scope: TenantScope, runId: string): Promise<HarnessRunRecord | null>;
  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: HarnessRunStatus }): Promise<HarnessRunRecord[]>;
  /**
   * 全スコープ横断で、指定状態のRunを返す（起動時の孤児Run回収用・`RecoverInterruptedRunsUseCase`）。
   * Harness実行はHTTPリクエスト内で走るため、`running` が残っているのは異常終了だけである
   * （`waiting-input` / `waiting-approval` は正常な待機状態なので回収対象にしてはならない）。
   */
  listAllByStatus(status: HarnessRunStatus): Promise<HarnessRunRecord[]>;
}
