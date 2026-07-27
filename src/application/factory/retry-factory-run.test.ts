import { describe, expect, it } from 'vitest';
import { InMemoryFactoryRunRepository } from '../../adapters/storage/in-memory-factory-run-repository';
import { FactoryNotFoundError, FactoryValidationError } from '../../domain/factory/errors';
import {
  beginFactoryRun,
  failFactoryRun,
  startFactoryRun,
  succeedFactoryRun,
  type FactoryOptions,
  type FactoryRun,
  type FactoryRunStatus,
} from '../../domain/factory/factory-run';
import type { TenantScope } from '../../domain/tool/ids';
import { CreateFactoryRunUseCase } from './create-factory-run';
import type { FactoryWorkerPort } from './factory-worker';
import { RetryFactoryRunUseCase } from './retry-factory-run';

const scope: TenantScope = { tenantId: 't', workspaceId: 'w' };

/** enqueue / cancel の呼び出しを記録するテスト用worker（`run-factory.test.ts` の noopWorker を記録可能にしたもの）。 */
class RecordingWorker implements FactoryWorkerPort {
  readonly enqueued: { readonly scope: TenantScope; readonly runId: string }[] = [];
  enqueue(scope: TenantScope, runId: string): void { this.enqueued.push({ scope, runId }); }
  cancel(): void {}
  shutdown(): void {}
}

const options: FactoryOptions = {
  maxIterations: 2,
  personaCount: 3,
  scenarioCount: 5,
  requirePlanApproval: true,
  targets: { minGoalAchievedRate: 0.9, minAvgSatisfaction: 4.5 },
  budget: { maxDurationMs: 60_000, maxRoleCalls: 7, maxScenarioRuns: 8, maxRepairAttempts: 1, maxProposalsPerIteration: 2 },
};

function seedRun(id: string, baseAgent?: { readonly internalId: string; readonly version?: string }): FactoryRun {
  return startFactoryRun({
    id,
    scope,
    input: {
      goal: { goal: 'Answer sales questions', targetUsers: 'Accounting staff', constraints: 'No SQL', language: 'ja' },
      dataSourceIds: ['ds-1', 'ds-2'],
      options,
      ...(baseAgent === undefined ? {} : { baseAgent }),
    },
    startedAt: '2026-07-20T00:00:00.000Z',
  });
}

/** 決定的にID列を発行する（新Runのidを検証できるようにする）。 */
function makeSequentialId(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}

async function setup(): Promise<{
  repo: InMemoryFactoryRunRepository; worker: RecordingWorker; retryFactoryRun: RetryFactoryRunUseCase;
}> {
  const repo = new InMemoryFactoryRunRepository();
  const worker = new RecordingWorker();
  const createFactoryRun = new CreateFactoryRunUseCase(repo, worker, makeSequentialId('retry-run'), () => new Date('2026-07-21T00:00:00.000Z'));
  return { repo, worker, retryFactoryRun: new RetryFactoryRunUseCase(repo, createFactoryRun) };
}

describe('RetryFactoryRunUseCase', () => {
  it('failedのRunを同じ入力の新しいRunとして起票し、queuedでworkerへenqueueする', async () => {
    const { repo, worker, retryFactoryRun } = await setup();
    const failed = failFactoryRun(beginFactoryRun(seedRun('run-1')), { stage: 'generating-tools', reason: 'model provider error' }, '2026-07-20T00:01:00.000Z');
    await repo.save(failed);

    const retried = await retryFactoryRun.execute({ scope, runId: 'run-1' });

    expect(retried.id).toBe('retry-run-1');
    expect(retried.status).toBe('queued');
    expect(retried.stage).toBe('profiling');
    expect(retried.failure).toBeUndefined();
    // 入力（goal / dataSourceIds / options）は元Runから引き継ぐ。
    expect(retried.input.goal).toEqual(failed.input.goal);
    expect(retried.input.dataSourceIds).toEqual(['ds-1', 'ds-2']);
    expect(retried.input.options).toEqual(options);
    // 新Runは保存され、workerへenqueueされる。
    expect(await repo.find(scope, 'retry-run-1')).toMatchObject({ id: 'retry-run-1', status: 'queued' });
    expect(worker.enqueued).toEqual([{ scope, runId: 'retry-run-1' }]);
    // 元のfailed Runは監査証跡としてそのまま残る。
    expect(await repo.find(scope, 'run-1')).toMatchObject({ id: 'run-1', status: 'failed' });
  });

  it('強化モードのRunをretryすると baseAgent（版指定含む）も引き継ぐ', async () => {
    const { repo, retryFactoryRun } = await setup();
    const failed = failFactoryRun(
      beginFactoryRun(seedRun('run-1', { internalId: 'base-agent', version: '1.2.3' })),
      { stage: 'assembling-agent', reason: 'model provider error' },
      '2026-07-20T00:01:00.000Z',
    );
    await repo.save(failed);

    const retried = await retryFactoryRun.execute({ scope, runId: 'run-1' });

    // baseAgent を落とすと、強化のつもりのRunが0→1生成として再実行されてしまう。
    expect(retried.input.baseAgent).toEqual({ internalId: 'base-agent', version: '1.2.3' });
    expect(retried.status).toBe('queued');
    expect(await repo.find(scope, 'retry-run-1')).toMatchObject({ input: { baseAgent: { internalId: 'base-agent', version: '1.2.3' } } });
  });

  it('生成モードのRunをretryしても baseAgent は付かない', async () => {
    const { repo, retryFactoryRun } = await setup();
    await repo.save(failFactoryRun(beginFactoryRun(seedRun('run-1')), { stage: 'planning', reason: 'boom' }, '2026-07-20T00:01:00.000Z'));
    const retried = await retryFactoryRun.execute({ scope, runId: 'run-1' });
    expect(retried.input.baseAgent).toBeUndefined();
  });

  it('存在しないRunはFactoryNotFoundError', async () => {
    const { worker, retryFactoryRun } = await setup();
    await expect(retryFactoryRun.execute({ scope, runId: 'missing' })).rejects.toThrow(FactoryNotFoundError);
    expect(worker.enqueued).toEqual([]);
  });

  it.each<{ readonly label: string; readonly make: (run: FactoryRun) => FactoryRun; readonly status: FactoryRunStatus }>([
    { label: 'queued', make: (run) => run, status: 'queued' },
    { label: 'running', make: (run) => beginFactoryRun(run), status: 'running' },
    {
      label: 'succeeded',
      make: (run) => succeedFactoryRun(
        beginFactoryRun(run),
        { bestIteration: 1, candidate: { agentId: 'asset-3', version: '1.0.0' }, summary: 'done', openFindings: [], metricsByIteration: [] },
        '2026-07-20T00:01:00.000Z',
      ),
      status: 'succeeded',
    },
  ])('failed以外（$label）のRunはFactoryValidationError', async ({ make, status }) => {
    const { repo, worker, retryFactoryRun } = await setup();
    const stored = make(seedRun('run-1'));
    expect(stored.status).toBe(status);
    await repo.save(stored);

    const caught = await retryFactoryRun.execute({ scope, runId: 'run-1' }).catch((cause: unknown) => cause);
    expect(caught).toBeInstanceOf(FactoryValidationError);
    expect((caught as Error).message).toBe(`Factory run 'run-1' is not failed`);
    expect(worker.enqueued).toEqual([]);
  });
});
