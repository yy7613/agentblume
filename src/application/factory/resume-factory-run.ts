/**
 * application層: Agent Factory `ResumeFactoryRunUseCase`（v33 実装契約 §3 / docs/16-agent-factory.md §5, §9）。
 *
 * `waiting-approval` checkpoint（`plan-approval`）への応答を処理する。Magentic計画承認と同じ応答型
 * （approve / revise / reject）。reject は再計画ではなく監査可能な `cancelled` として確定する。
 *
 * 保存は `waiting-approval` を期待する compare-and-set: 応答の処理中（revise の再計画はモデル呼び出しを含む）に
 * 利用者が cancel していれば、cancelled を running / waiting-approval で上書きせず、承認待ちでない旨で拒否する。
 */
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { appendFactoryEvent, cancelFactoryRun, resumeFactoryRun, type FactoryRun } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import type { FactoryRunId } from '../../domain/factory/ids';
import { FactoryNotFoundError, FactoryValidationError } from '../../domain/factory/errors';
import type { FactoryWorkerPort } from './factory-worker';
import type { RunFactoryUseCase } from './run-factory';

export interface ResumeFactoryRunInput {
  readonly scope: TenantScope;
  readonly runId: FactoryRunId;
  readonly decision: 'approve' | 'revise' | 'reject';
  readonly feedback?: string;
}

export class ResumeFactoryRunUseCase {
  constructor(
    private readonly runs: FactoryRunRepository,
    private readonly runFactory: RunFactoryUseCase,
    private readonly worker: FactoryWorkerPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ResumeFactoryRunInput, signal?: AbortSignal): Promise<FactoryRun> {
    const stored = await this.runs.find(input.scope, input.runId);
    if (stored === null) throw new FactoryNotFoundError(`Factory run not found: ${input.runId}`);
    if (stored.status !== 'waiting-approval') throw new FactoryValidationError(`Factory run '${input.runId}' is not waiting for approval`);

    if (input.decision === 'reject') {
      let cancelled = cancelFactoryRun(stored, this.now().toISOString());
      cancelled = appendFactoryEvent(cancelled, { kind: 'run_cancelled', at: this.now().toISOString(), stage: stored.stage, message: input.feedback?.trim() || 'Plan rejected by reviewer' });
      await this.commitFromWaiting(cancelled);
      return cancelled;
    }

    if (input.decision === 'approve') {
      let resumed = resumeFactoryRun(stored);
      resumed = appendFactoryEvent(resumed, { kind: 'approval_resolved', at: this.now().toISOString(), stage: stored.stage, message: 'approved' });
      await this.commitFromWaiting(resumed);
      this.worker.enqueue(input.scope, input.runId);
      return resumed;
    }

    // revise: 再開してから再プロファイル・再計画し、新しい checkpoint で waiting-approval に戻す。
    let resumed = resumeFactoryRun(stored);
    resumed = appendFactoryEvent(resumed, { kind: 'approval_resolved', at: this.now().toISOString(), stage: stored.stage, message: input.feedback?.trim() || 'revision requested' });
    const revised = await this.runFactory.replan(resumed, input.feedback, signal);
    await this.commitFromWaiting(revised);
    return revised;
  }

  /** `waiting-approval` を期待して書く。その間に cancel 等で確定していれば上書きせず、承認待ちでない旨で拒否する。 */
  private async commitFromWaiting(run: FactoryRun): Promise<void> {
    if (await this.runs.saveIfStatus(run, ['waiting-approval'])) return;
    throw new FactoryValidationError(`Factory run '${run.id}' is not waiting for approval`);
  }
}
