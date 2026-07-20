import type { TenantScope } from '../../domain/tool/ids';

/**
 * Agent Factory の非同期実行ポート（v33 実装契約 §3 / docs/16-agent-factory.md §7）。
 * `ExperimentWorkerPort`（v23）と同じqueue / cancel / shutdownの規律。実装は `InProcessFactoryWorker`。
 */
export interface FactoryWorkerPort {
  enqueue(scope: TenantScope, runId: string): void;
  cancel(scope: TenantScope, runId: string): void;
  shutdown(): void;
}
