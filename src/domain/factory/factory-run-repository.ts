import type { TenantScope } from '../shared/tenant-scope';
import type { FactoryRun, FactoryRunStatus } from './factory-run';
import type { FactoryRunId } from './ids';

export interface FactoryRunRepository {
  save(run: FactoryRun): Promise<void>;
  find(scope: TenantScope, runId: FactoryRunId): Promise<FactoryRun | null>;
  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: FactoryRunStatus }): Promise<FactoryRun[]>;
  /**
   * 全スコープ横断で、指定状態のRunを返す（起動時の孤児Run回収用・`RecoverInterruptedRunsUseCase`）。
   *
   * `list` と違いスコープを取らないのは、回収が「このプロセスが持っていた全ジョブ」を対象にするため。
   * 起動時点でどのテナントのRunが中断されているかは事前に分からない（保存先はテナント横断の1ファイル）。
   * 件数上限も設けない: 取りこぼした孤児Runは `running` のまま永久に固まる。
   */
  listAllByStatus(status: FactoryRunStatus): Promise<FactoryRun[]>;
}
