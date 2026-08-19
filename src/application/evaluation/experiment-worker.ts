import type { ExperimentId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/tool/ids';

export interface ExperimentWorkerPort {
  enqueue(scope: TenantScope, experimentId: ExperimentId): void;
  cancel(scope: TenantScope, experimentId: ExperimentId): void;
  /**
   * shutdown猶予: 新規enqueueとキュー消化を止め、**実行中のジョブ**の完了を最大 `graceMs` 待ってから abort する。
   * 戻り値は猶予内に終わったか。`shutdown()` はこの待ちを省いた即時版。
   */
  drainInFlight(graceMs: number): Promise<boolean>;
  shutdown(): void;
}
