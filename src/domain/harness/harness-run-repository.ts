import type { TenantScope } from '../shared/tenant-scope';
import type { HarnessRunRecord, HarnessRunStatus } from './harness-run';
import type { HarnessRunId } from './ids';

export interface HarnessRunRepository {
  /** 無条件の upsert。新規行の挿入と、worker が動いていない状況（起動時の孤児回収など）の更新に使う。 */
  save(record: HarnessRunRecord): Promise<void>;
  /**
   * 保存済み行の現在状態が `expected` のいずれかであるときだけ上書きする compare-and-set。
   * 書き込んだら true。状態が合わない・行が無い・`expected` が空なら何も書かずに false。
   * worker の進捗保存と cancel() は同じ行を取り合う。無条件の `save` では後から来た worker の
   * メモリ上のコピーが cancelled を running へ巻き戻すため、実行中の更新はすべてこちらを通す。
   */
  saveIfStatus(record: HarnessRunRecord, expected: readonly HarnessRunStatus[]): Promise<boolean>;
  find(scope: TenantScope, runId: HarnessRunId): Promise<HarnessRunRecord | null>;
  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: HarnessRunStatus }): Promise<HarnessRunRecord[]>;
  /**
   * 全スコープ横断で、指定状態のRunを返す（起動時の孤児Run回収用・`RecoverInterruptedRunsUseCase`）。
   * Harness実行はHTTPリクエスト内で走るため、`running` が残っているのは異常終了だけである
   * （`waiting-input` / `waiting-approval` は正常な待機状態なので回収対象にしてはならない）。
   */
  listAllByStatus(status: HarnessRunStatus): Promise<HarnessRunRecord[]>;
}
