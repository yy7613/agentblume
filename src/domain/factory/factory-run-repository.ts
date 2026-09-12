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
  /**
   * 比較して保存する（compare-and-set）: 保存済みRunの `status` が `expected` のいずれかである場合に限り
   * `run` で上書きして `true` を返す。存在しない・status 不一致・`expected` が空なら**何も書かず** `false`。
   *
   * worker（`RunFactoryUseCase`）の進捗保存と `CancelFactoryRunUseCase` の cancelled 確定は同じ行へ競合する。
   * 無条件の `save` では「cancelled を書いた直後に worker のイベント保存が running へ戻す」が起きるため、
   * worker 側は `expected: ['running']`、cancel 側は非終端状態だけを期待して書く。どちらが先でも終端が勝つ。
   */
  saveIfStatus(run: FactoryRun, expected: readonly FactoryRunStatus[]): Promise<boolean>;
}
