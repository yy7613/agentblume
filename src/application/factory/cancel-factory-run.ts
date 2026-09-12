/**
 * application層: Agent Factory `CancelFactoryRunUseCase`（v33 実装契約 §3）。
 * `CancelExperimentUseCase`（v23）と同じ形: ドメイン遷移 → 保存 → worker.cancel通知。
 *
 * 保存は compare-and-set（`saveIfStatus`）で行う。worker は同じ行へ進捗を書き続けているため、無条件に保存すると
 * 「cancelled を書いた直後に worker のイベント保存が running へ戻す」競合が起きる。worker 側も running を期待して
 * 書くので、どちらが先でも cancelled が残る。通知は保存の**後**: worker 側の確定処理は「記録が cancelled 済み」を
 * 見て何も書かない。
 *
 * 終端（succeeded / failed / cancelled）の Run への cancel は冪等: 保存済みの記録をそのまま返し、イベントも
 * worker への通知も行わない（2回目の cancel・完了直後の cancel を UI の失敗にしない）。
 */
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { appendFactoryEvent, cancelFactoryRun, type FactoryRun, type FactoryRunStatus } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { FactoryRunId } from '../../domain/factory/ids';
import { FactoryNotFoundError } from '../../domain/factory/errors';
import { USER_CANCEL_MESSAGE } from './abort';
import type { FactoryWorkerPort } from './factory-worker';

/** cancel が遷移させられる（= 終端でない）状態。`cancelFactoryRun` が受け付ける集合と同じ。 */
const CANCELLABLE_STATUSES: readonly FactoryRunStatus[] = ['queued', 'running', 'waiting-approval'];

export class CancelFactoryRunUseCase {
  constructor(
    private readonly runs: FactoryRunRepository,
    private readonly worker: FactoryWorkerPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope, runId: FactoryRunId): Promise<FactoryRun> {
    const stored = await this.runs.find(scope, runId);
    if (stored === null) throw new FactoryNotFoundError(`Factory run not found: ${runId}`);
    if (!CANCELLABLE_STATUSES.includes(stored.status)) return stored;

    let cancelled = cancelFactoryRun(stored, this.now().toISOString());
    cancelled = appendFactoryEvent(cancelled, { kind: 'run_cancelled', at: this.now().toISOString(), stage: stored.stage, message: USER_CANCEL_MESSAGE });
    if (!(await this.runs.saveIfStatus(cancelled, CANCELLABLE_STATUSES))) {
      // find と保存の間に worker（または別の cancel）が終端へ確定させた: 確定済みの記録をそのまま返す。
      const latest = await this.runs.find(scope, runId);
      if (latest === null) throw new FactoryNotFoundError(`Factory run not found: ${runId}`);
      return latest;
    }
    this.worker.cancel(scope, runId);
    return cancelled;
  }
}
