import type { TenantScope } from '../shared/tenant-scope';
import type { RunId } from './ids';
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
  find(scope: TenantScope, runId: RunId): Promise<RunRecord | null>;
  list(scope: TenantScope, options?: ListRunsOptions): Promise<RunRecord[]>;
  /**
   * 全スコープ横断で、指定状態のRunを返す（起動時の孤児Run回収用・`RecoverInterruptedRunsUseCase`）。
   *
   * Agent RunはHTTPリクエスト内で同期実行されるため、`running` のまま残っているのは異常終了時だけ。
   * `waiting-approval` は人間の承認を待つ**正常な**状態なので回収してはならない（`list` の
   * status フィルタと違い、ここは回収側が状態を明示して呼ぶ前提）。
   */
  listAllByStatus(status: RunStatus): Promise<RunRecord[]>;
  /**
   * Runを1件以上持つスコープの一覧（retentionの定期実行が「どのスコープを掃除するか」を決めるのに使う）。
   *
   * retentionポリシーはスコープごとに保存されるが、`apply` はスコープを1つずつしか受け取れない。
   * 定期実行にはスコープの列挙手段が要る。`runs` は保持期限の主対象（無制限に増える唯一のテーブル）
   * なので、ここを基準にする。
   */
  listScopes(): Promise<TenantScope[]>;
  /** v26。カスタムRepositoryは未対応でも既存実行を継続できる。 */
  applyRetention?(scope: TenantScope, options: RunRetentionOptions): Promise<RunRetentionResult>;
}
