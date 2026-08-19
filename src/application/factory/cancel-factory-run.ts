/**
 * application層: Agent Factory `CancelFactoryRunUseCase`（v33 実装契約 §3）。
 * `CancelExperimentUseCase`（v23）と同じ形: ドメイン遷移 → 保存 → worker.cancel通知。
 */
import type { TenantScope } from '../../domain/tool/ids';
import { appendFactoryEvent, cancelFactoryRun, type FactoryRun } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { FactoryRunId } from '../../domain/factory/ids';
import { FactoryNotFoundError } from '../../domain/factory/errors';
import type { FactoryWorkerPort } from './factory-worker';

export class CancelFactoryRunUseCase {
  constructor(
    private readonly runs: FactoryRunRepository,
    private readonly worker: FactoryWorkerPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope, runId: FactoryRunId): Promise<FactoryRun> {
    const stored = await this.runs.find(scope, runId);
    if (stored === null) throw new FactoryNotFoundError(`Factory run not found: ${runId}`);
    let cancelled = cancelFactoryRun(stored, this.now().toISOString());
    cancelled = appendFactoryEvent(cancelled, { kind: 'run_cancelled', at: this.now().toISOString(), stage: stored.stage, message: 'Cancelled by user' });
    await this.runs.save(cancelled);
    this.worker.cancel(scope, runId);
    return cancelled;
  }
}
