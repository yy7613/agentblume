import type { TenantScope } from '../tool/ids';
import type { Experiment, ExperimentCaseResult, ExperimentStatus } from './experiment';

export interface ExperimentFilter { readonly status?: ExperimentStatus }
export interface ExperimentRepository {
  create(experiment: Experiment): Promise<void>;
  update(experiment: Experiment): Promise<void>;
  find(scope: TenantScope, id: string): Promise<Experiment | null>;
  list(scope: TenantScope, filter?: ExperimentFilter): Promise<Experiment[]>;
  saveCaseResult(result: ExperimentCaseResult): Promise<void>;
  listCaseResults(scope: TenantScope, experimentId: string): Promise<ExperimentCaseResult[]>;
  /**
   * 全スコープ横断で、指定状態の実験を返す（起動時の孤児Run回収用・`RecoverInterruptedRunsUseCase`）。
   *
   * 以前はリポジトリ自身が `interruptRunning(finishedAt)` で状態遷移まで行っていたが、
   * 「どの状態をどう扱うか」は保存の都合ではなく回収の方針なので application 層へ移した。
   * ここは**問い合わせだけ**を担う。
   */
  listAllByStatus(status: ExperimentStatus): Promise<Experiment[]>;
}
