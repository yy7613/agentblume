import type { FactoryRunId } from '../../domain/factory/ids';
import type { TenantScope } from '../../domain/tool/ids';

/**
 * Agent Factory の非同期実行ポート（v33 実装契約 §3 / docs/16-agent-factory.md §7）。
 * `ExperimentWorkerPort`（v23）と同じqueue / cancel / shutdownの規律。実装は `InProcessFactoryWorker`。
 */
export interface FactoryWorkerPort {
  enqueue(scope: TenantScope, runId: FactoryRunId): void;
  cancel(scope: TenantScope, runId: FactoryRunId): void;
  /**
   * shutdown猶予: 新規enqueueとキュー消化を止め、**実行中のRun**の完了を最大 `graceMs` 待ってから abort する。
   * 戻り値は猶予内に終わったか。`shutdown()` はこの待ちを省いた即時版。
   */
  drainInFlight(graceMs: number): Promise<boolean>;
  shutdown(): void;
}
