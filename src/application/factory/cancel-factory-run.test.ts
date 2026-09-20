import { describe, expect, it } from 'vitest';
import { InMemoryFactoryRunRepository } from '../../adapters/storage/in-memory-factory-run-repository';
import { FactoryNotFoundError } from '../../domain/factory/errors';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import {
  appendFactoryEvent,
  beginFactoryRun,
  DEFAULT_FACTORY_OPTIONS,
  failFactoryRun,
  startFactoryRun,
  succeedFactoryRun,
  waitForPlanApproval,
  type FactoryRun,
  type FactoryRunStatus,
} from '../../domain/factory/factory-run';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { USER_CANCEL_MESSAGE } from './abort';
import { CancelFactoryRunUseCase } from './cancel-factory-run';
import type { FactoryWorkerPort } from './factory-worker';

const scope = { tenantId: 't', workspaceId: 'w' };
const STARTED_AT = '2026-08-01T00:00:00.000Z';
const CANCELLED_AT = '2026-08-01T00:10:00.000Z';
const plan: FactoryPlan = { agentBrief: { displayName: 'Sales Assistant', role: 'answers sales questions' }, tools: [], skills: [], personas: [], scenarios: [] };

function makeRun(id: string): FactoryRun {
  return startFactoryRun({ id, scope, input: { goal: { goal: '売上について答える', language: 'ja' }, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS }, startedAt: STARTED_AT });
}

/** 各状態の Run を作る（イベントを1件持たせ、cancel が既存イベントを壊さないことも見る）。 */
function runIn(status: Exclude<FactoryRunStatus, 'cancelled'>, id: string): FactoryRun {
  const queued = appendFactoryEvent(makeRun(id), { kind: 'stage_started', at: STARTED_AT, stage: 'profiling' });
  switch (status) {
    case 'queued': return queued;
    case 'running': return beginFactoryRun(queued);
    case 'waiting-approval': return waitForPlanApproval(beginFactoryRun(queued), { kind: 'plan-approval', expiresAt: '2026-08-02T00:00:00.000Z', prompt: 'review', plan });
    case 'succeeded': return succeedFactoryRun(beginFactoryRun(queued), { bestIteration: 1, candidate: { agentId: 'a', version: '1.0.0' }, summary: 's', openFindings: [], metricsByIteration: [], quality: 'unverified', qualityReasons: [] }, STARTED_AT);
    case 'failed': return failFactoryRun(beginFactoryRun(queued), { stage: 'planning', reason: 'boom' }, STARTED_AT);
  }
}

class RecordingWorker implements FactoryWorkerPort {
  readonly cancels: string[] = [];
  enqueue(): void {}
  cancel(_scope: TenantScope, runId: string): void { this.cancels.push(runId); }
  async drainInFlight(): Promise<boolean> { return true; }
  shutdown(): void {}
}

function harness(repo: InMemoryFactoryRunRepository = new InMemoryFactoryRunRepository()): { repo: InMemoryFactoryRunRepository; worker: RecordingWorker; useCase: CancelFactoryRunUseCase } {
  const worker = new RecordingWorker();
  return { repo, worker, useCase: new CancelFactoryRunUseCase(repo, worker, () => new Date(CANCELLED_AT)) };
}

describe('CancelFactoryRunUseCase', () => {
  it.each(['queued', 'running', 'waiting-approval'] as const)('%s の Run は cancelled + run_cancelled(Cancelled by user) で確定し、保存してから worker へ通知する', async (status) => {
    const { repo, worker, useCase } = harness();
    await repo.save(runIn(status, 'run'));

    const cancelled = await useCase.execute(scope, 'run');

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).toBe(CANCELLED_AT);
    expect(cancelled.checkpoint).toBeUndefined();
    expect(cancelled.events.map((event) => event.kind)).toEqual(['stage_started', 'run_cancelled']);
    expect(cancelled.events.at(-1)).toMatchObject({ kind: 'run_cancelled', at: CANCELLED_AT, message: USER_CANCEL_MESSAGE });
    expect(await repo.find(scope, 'run')).toEqual(cancelled);
    expect(worker.cancels).toEqual(['run']);
  });

  it('未存在の Run は FactoryNotFoundError（worker へは通知しない）', async () => {
    const { worker, useCase } = harness();
    await expect(useCase.execute(scope, 'missing')).rejects.toBeInstanceOf(FactoryNotFoundError);
    // 別テナントの同名 Run も見えない。
    const { repo: other, useCase: otherUseCase } = harness();
    await other.save({ ...runIn('running', 'run'), scope: { tenantId: 'other', workspaceId: 'w' } });
    await expect(otherUseCase.execute(scope, 'run')).rejects.toBeInstanceOf(FactoryNotFoundError);
    expect(worker.cancels).toEqual([]);
  });

  it('2回目の cancel は冪等: 記録は変わらず、イベントも worker への通知も増えない', async () => {
    const { repo, worker, useCase } = harness();
    await repo.save(runIn('running', 'run'));
    const first = await useCase.execute(scope, 'run');

    const second = await useCase.execute(scope, 'run');

    expect(second).toEqual(first);
    expect(second.events.filter((event) => event.kind === 'run_cancelled')).toHaveLength(1);
    expect(await repo.find(scope, 'run')).toEqual(first);
    expect(worker.cancels).toEqual(['run']);
  });

  it.each(['succeeded', 'failed'] as const)('%s（終端）の Run への cancel は記録をそのまま返し、何も書かず worker へも通知しない', async (status) => {
    const { repo, worker, useCase } = harness();
    const terminal = runIn(status, 'run');
    await repo.save(terminal);

    const result = await useCase.execute(scope, 'run');

    expect(result).toEqual(terminal);
    expect(result.status).toBe(status);
    expect(result.events.map((event) => event.kind)).not.toContain('run_cancelled');
    expect(await repo.find(scope, 'run')).toEqual(terminal);
    expect(worker.cancels).toEqual([]);
  });

  it('find と保存の間に worker が終端へ確定させた場合は上書きせず、確定済みの記録を返して通知もしない', async () => {
    /** compare-and-set の直前に「worker が succeeded を書いた」状況を1回だけ差し込む。 */
    class RacingRepository extends InMemoryFactoryRunRepository {
      raced = false;
      override async saveIfStatus(run: FactoryRun, expected: readonly FactoryRunStatus[]): Promise<boolean> {
        if (!this.raced) { this.raced = true; await this.save(runIn('succeeded', run.id)); }
        return super.saveIfStatus(run, expected);
      }
    }
    const { repo, worker, useCase } = harness(new RacingRepository());
    await repo.save(runIn('running', 'run'));

    const result = await useCase.execute(scope, 'run');

    expect(result.status).toBe('succeeded');
    expect(result.events.map((event) => event.kind)).not.toContain('run_cancelled');
    expect(await repo.find(scope, 'run')).toMatchObject({ status: 'succeeded' });
    expect(worker.cancels).toEqual([]);
  });
});
