import { describe, expect, it } from 'vitest';
import { InMemoryExperimentRepository } from '../../adapters/storage/in-memory-experiment-repository';
import { InMemoryFactoryRunRepository } from '../../adapters/storage/in-memory-factory-run-repository';
import { InMemoryHarnessRunRepository } from '../../adapters/storage/in-memory-harness-run-repository';
import { InMemoryRunRepository } from '../../adapters/storage/in-memory-run-repository';
import { createExperiment, startExperiment, type Experiment } from '../../domain/evaluation/experiment';
import { beginFactoryRun, DEFAULT_FACTORY_OPTIONS, startFactoryRun, succeedFactoryRun, waitForPlanApproval, type FactoryRun } from '../../domain/factory/factory-run';
import { startHarnessRun, waitForHarnessInput, type HarnessRunRecord } from '../../domain/harness/harness-run';
import { startRun, waitRunForApproval, type RunRecord } from '../../domain/run/run';
import { SemVer } from '../../domain/tool/semver';
import type { TenantScope } from '../../domain/tool/ids';
import type { ExperimentWorkerPort } from '../evaluation/experiment-worker';
import type { FactoryWorkerPort } from '../factory/factory-worker';
import type { LoggerPort } from './logger';
import { INTERRUPTED_FAILURE_CODE, RecoverInterruptedRunsUseCase } from './recover-interrupted-runs';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const other: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
const AT = '2026-07-28T09:00:00.000Z';

class RecordingWorker implements FactoryWorkerPort, ExperimentWorkerPort {
  readonly enqueued: string[] = [];
  enqueue(_scope: TenantScope, id: string): void { this.enqueued.push(id); }
  cancel(): void {}
  async drainInFlight(): Promise<boolean> { return true; }
  shutdown(): void {}
}

function factoryRun(id: string, tenant = scope): FactoryRun {
  return startFactoryRun({
    id, scope: tenant,
    input: { goal: { goal: '売上の質問に答える', language: 'ja' }, dataSourceIds: [], options: DEFAULT_FACTORY_OPTIONS },
    startedAt: '2026-07-28T08:00:00.000Z',
  });
}

function experiment(id: string, tenant = scope): Experiment {
  return createExperiment({
    id, scope: tenant, target: { agentId: 'agent', version: SemVer.of(1, 0, 0) },
    dataset: { id: 'set', version: SemVer.of(1, 0, 0) }, evaluatorProfile: { id: 'profile', version: SemVer.of(1, 0, 0) },
    repetitions: 1, status: 'queued', snapshot: { provider: 'p', model: 'm', modelConfigHash: 'h' },
    progress: { completed: 0, total: 1 }, createdAt: '2026-07-28T08:00:00.000Z',
  });
}

function agentRun(runId: string, tenant = scope): RunRecord {
  return startRun({ runId, scope: tenant, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: '2026-07-28T08:00:00.000Z' });
}

function harnessRun(runId: string, tenant = scope): HarnessRunRecord {
  return startHarnessRun({
    runId, scope: tenant, harness: { internalId: 'harness', version: '1.0.0', displayName: 'H' },
    mode: 'preview', message: 'go', startedAt: '2026-07-28T08:00:00.000Z',
  });
}

interface Harness {
  readonly factoryRuns: InMemoryFactoryRunRepository;
  readonly experiments: InMemoryExperimentRepository;
  readonly runs: InMemoryRunRepository;
  readonly harnessRuns: InMemoryHarnessRunRepository;
  readonly factoryWorker: RecordingWorker;
  readonly experimentWorker: RecordingWorker;
  readonly useCase: RecoverInterruptedRunsUseCase;
}

function harness(logger?: LoggerPort): Harness {
  const factoryRuns = new InMemoryFactoryRunRepository();
  const experiments = new InMemoryExperimentRepository();
  const runs = new InMemoryRunRepository();
  const harnessRuns = new InMemoryHarnessRunRepository();
  const factoryWorker = new RecordingWorker();
  const experimentWorker = new RecordingWorker();
  const useCase = new RecoverInterruptedRunsUseCase({
    factoryRuns, factoryWorker, experiments, experimentWorker, runs, harnessRuns,
    now: () => new Date(AT), ...(logger === undefined ? {} : { logger }),
  });
  return { factoryRuns, experiments, runs, harnessRuns, factoryWorker, experimentWorker, useCase };
}

describe('RecoverInterruptedRunsUseCase', () => {
  it('runningのFactory Runをfailedへ確定させ、retryできる状態にする', async () => {
    const h = harness();
    await h.factoryRuns.save(beginFactoryRun(factoryRun('stuck')));

    const summary = await h.useCase.execute();

    expect(summary.factoryRunsFailed).toBe(1);
    const recovered = await h.factoryRuns.find(scope, 'stuck');
    // RetryFactoryRunUseCase は `failed` のRunだけを受け付ける（UIの「再実行」ボタンの前提）。
    expect(recovered).toMatchObject({ status: 'failed', finishedAt: AT, failure: { stage: 'profiling' } });
    expect(recovered?.failure?.reason).toMatch(/restarted/);
    // 監査証跡としてイベントも残す。
    expect(recovered?.events.at(-1)).toMatchObject({ kind: 'run_failed', at: AT });
  });

  it('queuedのFactory Runをワーカーへ再投入する（状態は変えない）', async () => {
    const h = harness();
    await h.factoryRuns.save(factoryRun('waiting-in-queue'));
    await h.factoryRuns.save(factoryRun('from-other-tenant', other));

    const summary = await h.useCase.execute();

    expect(summary.factoryRunsRequeued).toBe(2);
    // 回収はテナント境界を越える（どのテナントのRunが残っているかは起動時点で分からない）。
    expect(h.factoryWorker.enqueued.sort()).toEqual(['from-other-tenant', 'waiting-in-queue']);
    expect(await h.factoryRuns.find(scope, 'waiting-in-queue')).toMatchObject({ status: 'queued' });
  });

  it('waiting-approvalのFactory Runには触らない（人間の応答を待つ正常な状態）', async () => {
    const h = harness();
    const checkpoint = {
      kind: 'plan-approval' as const, expiresAt: '2026-07-29T00:00:00.000Z', prompt: 'approve?',
      plan: { agentBrief: { displayName: 'a', role: 'r' }, tools: [], skills: [], personas: [], scenarios: [] },
    };
    await h.factoryRuns.save(waitForPlanApproval(beginFactoryRun(factoryRun('awaiting')), checkpoint));

    const summary = await h.useCase.execute();

    expect(summary).toMatchObject({ factoryRunsFailed: 0, factoryRunsRequeued: 0 });
    expect(await h.factoryRuns.find(scope, 'awaiting')).toMatchObject({ status: 'waiting-approval', checkpoint: { kind: 'plan-approval' } });
  });

  it('終端状態のFactory Runには触らない', async () => {
    const h = harness();
    const done = succeedFactoryRun(beginFactoryRun(factoryRun('done')), {
      bestIteration: 0, candidate: { agentId: 'a', version: '1.0.0' }, summary: 's', openFindings: [], metricsByIteration: [],
    }, '2026-07-28T07:00:00.000Z');
    await h.factoryRuns.save(done);

    await h.useCase.execute();

    expect(await h.factoryRuns.find(scope, 'done')).toMatchObject({ status: 'succeeded', finishedAt: '2026-07-28T07:00:00.000Z' });
  });

  it('runningの実験をinterruptedにし、queuedを再投入する', async () => {
    const h = harness();
    await h.experiments.create(startExperiment(experiment('stuck'), '2026-07-28T08:00:01.000Z'));
    await h.experiments.create(experiment('queued'));

    const summary = await h.useCase.execute();

    expect(summary).toMatchObject({ experimentsInterrupted: 1, experimentsRequeued: 1 });
    // `interrupted` は「プロセスが止まった」ために既にあるドメイン状態で、resume が受け付ける。
    expect(await h.experiments.find(scope, 'stuck')).toMatchObject({ status: 'interrupted', finishedAt: AT, error: { code: INTERRUPTED_FAILURE_CODE } });
    expect(h.experimentWorker.enqueued).toEqual(['queued']);
    expect(await h.experiments.find(scope, 'queued')).toMatchObject({ status: 'queued' });
  });

  it('runningのAgent Runをfailedにするが、waiting-approvalは触らない', async () => {
    const h = harness();
    await h.runs.save(agentRun('stuck'));
    const waiting = waitRunForApproval(agentRun('awaiting'), {
      kind: 'tool-approval', agentRef: { internalId: 'agent', version: '1.0.0' }, messages: [], pendingCalls: [],
      executedToolRefs: [], budget: { remainingModelRounds: 1, remainingToolCalls: 1 }, step: 1,
      expiresAt: '2026-07-29T00:00:00.000Z', prompt: 'approve?',
    });
    await h.runs.save(waiting);

    const summary = await h.useCase.execute();

    expect(summary.agentRunsFailed).toBe(1);
    expect(await h.runs.find(scope, 'stuck')).toMatchObject({ status: 'failed', completedAt: AT, failure: { code: INTERRUPTED_FAILURE_CODE } });
    expect(await h.runs.find(scope, 'awaiting')).toMatchObject({ status: 'waiting-approval', checkpoint: { kind: 'tool-approval' } });
  });

  it('runningのHarness Runをfailedにするが、waiting-inputは触らない', async () => {
    const h = harness();
    await h.harnessRuns.save(harnessRun('stuck'));
    await h.harnessRuns.save(waitForHarnessInput(harnessRun('awaiting'), 'need input', {
      kind: 'handoff-input', activeSlotId: 'a', history: [],
      budget: { remainingModelRounds: 1, remainingToolCalls: 1, remainingParticipantRuns: 1 },
      expiresAt: '2026-07-29T00:00:00.000Z', prompt: 'need input',
    }));

    const summary = await h.useCase.execute();

    expect(summary.harnessRunsFailed).toBe(1);
    const failed = await h.harnessRuns.find(scope, 'stuck');
    expect(failed).toMatchObject({ status: 'failed', completedAt: AT, failure: { code: INTERRUPTED_FAILURE_CODE } });
    expect(failed?.events.at(-1)).toMatchObject({ kind: 'harness_failed', at: AT });
    expect(await h.harnessRuns.find(scope, 'awaiting')).toMatchObject({ status: 'waiting-input' });
  });

  it('回収対象が無ければ全て0件（起動のたびに安全に呼べる）', async () => {
    await expect(harness().useCase.execute()).resolves.toEqual({
      factoryRunsFailed: 0, factoryRunsRequeued: 0, experimentsInterrupted: 0, experimentsRequeued: 0,
      agentRunsFailed: 0, harnessRunsFailed: 0, failures: 0,
    });
  });

  it('1件の回収失敗で残りを道連れにせず、理由をログへ残す', async () => {
    const warns: { message: string; context?: Record<string, unknown> }[] = [];
    const logger: LoggerPort = { info: () => {}, warn: (message, context) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); }, error: () => {} };
    const h = harness(logger);
    await h.factoryRuns.save(beginFactoryRun(factoryRun('broken')));
    await h.factoryRuns.save(beginFactoryRun(factoryRun('healthy')));
    const save = h.factoryRuns.save.bind(h.factoryRuns);
    h.factoryRuns.save = async (run): Promise<void> => {
      if (run.id === 'broken') throw new Error('disk is full');
      await save(run);
    };

    const summary = await h.useCase.execute();

    expect(summary).toMatchObject({ factoryRunsFailed: 1, failures: 1 });
    expect(await h.factoryRuns.find(scope, 'healthy')).toMatchObject({ status: 'failed' });
    expect(await h.factoryRuns.find(scope, 'broken')).toMatchObject({ status: 'running' });
    expect(warns).toEqual([{ message: 'failed to recover factory run', context: { id: 'broken', reason: 'disk is full' } }]);
  });
});
