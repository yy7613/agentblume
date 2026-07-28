import { describe, expect, it, vi } from 'vitest';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { createEvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import { createEvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import { createExperiment, interruptExperiment, startExperiment, type Experiment, type ExperimentCaseResult } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { ExperimentNotFoundError } from '../../domain/evaluation/errors';
import { SemVer } from '../../domain/tool/semver';
import type { ExperimentWorkerPort } from './experiment-worker';
import { CancelExperimentUseCase } from './cancel-experiment';
import { CreateExperimentUseCase } from './create-experiment';
import { QueryExperimentsUseCase } from './query-experiments';
import { ResumeExperimentUseCase } from './resume-experiment';

const scope = { tenantId: 't', workspaceId: 'w' }; const v = SemVer.of(1, 0, 0);
const makeExperiment = () => createExperiment({ id: 'exp', scope, target: { agentId: 'agent', version: v }, dataset: { id: 'set', version: v }, evaluatorProfile: { id: 'profile', version: v }, repetitions: 1, status: 'queued', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 0, total: 1 }, createdAt: 'created' });
class Repo implements ExperimentRepository {
  value: Experiment | null = null; results: ExperimentCaseResult[] = [];
  async create(value: Experiment): Promise<void> { this.value = value; } async update(value: Experiment): Promise<void> { this.value = value; } async find(): Promise<Experiment | null> { return this.value; } async list(): Promise<Experiment[]> { return this.value === null ? [] : [this.value]; } async saveCaseResult(value: ExperimentCaseResult): Promise<void> { this.results.push(value); } async listCaseResults(): Promise<ExperimentCaseResult[]> { return this.results; } async listAllByStatus(): Promise<Experiment[]> { return []; }
}

describe('experiment action use cases', () => {
  it('固定資産を検証してqueued Experimentを作成・enqueueする', async () => {
    const metadata = { internalId: 'set', workingName: 'x', displayName: 'x', publishName: 'x', version: v, owner: 'o', state: 'draft' as const, tenant: scope };
    const dataset = createEvaluationDataset({ metadata, cases: [{ id: 'case', kind: 'turn', input: 'x', tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...metadata, internalId: 'profile' }, metrics: [{ id: 'quality', kind: 'code', scorer: 'completeness', weight: 1, required: true }] });
    const repo = new Repo(); const enqueue = vi.fn();
    const create = new CreateExperimentUseCase(repo, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, { enqueue, cancel: vi.fn(), drainInFlight: vi.fn().mockResolvedValue(true), shutdown: vi.fn() }, () => ({ provider: 'test', model: 'model', modelConfigHash: 'hash' }), () => 'exp', () => new Date('2026-07-10T00:00:00Z'));
    const value = await create.execute({ scope, target: { agentId: 'agent', version: v }, dataset: { id: 'set', version: v }, evaluatorProfile: { id: 'profile', version: v }, repetitions: 1 });
    expect(value).toMatchObject({ status: 'queued', progress: { total: 1 } }); expect(enqueue).toHaveBeenCalledWith(scope, 'exp');
  });

  it('モデル指紋の解決に失敗しても起票は止めず、解決できなかったことをレコードへ残す', async () => {
    // 指紋は観測情報であって起票の前提条件ではない。Run側は解決失敗を握って実行を続けるので、
    // 起票だけが SecretCipherError で 409 になるのは非対称だった（方針をRun側へ揃える）。
    const repo = new Repo(); const enqueue = vi.fn();
    const dataset = createEvaluationDataset({ metadata: { internalId: 'set', workingName: 's', displayName: 's', publishName: 's', version: v, owner: 'o', state: 'draft', tenant: scope }, cases: [{ id: 'case', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] });
    const profile = createEvaluatorProfile({ metadata: { ...dataset.metadata, internalId: 'profile' }, metrics: [{ id: 'quality', kind: 'code', scorer: 'completeness', weight: 1, required: true }] });
    const create = new CreateExperimentUseCase(repo, { findVersion: async () => dataset } as unknown as EvaluationDatasetRepository, { findVersion: async () => profile } as unknown as EvaluatorProfileRepository, { findVersion: async () => ({ kind: 'normal' }) } as unknown as AgentRepository, { enqueue, cancel: vi.fn(), drainInFlight: vi.fn().mockResolvedValue(true), shutdown: vi.fn() }, () => { throw new Error('Stored API key could not be decrypted'); }, () => 'exp', () => new Date('2026-07-10T00:00:00Z'));

    const value = await create.execute({ scope, target: { agentId: 'agent', version: v }, dataset: { id: 'set', version: v }, evaluatorProfile: { id: 'profile', version: v }, repetitions: 1 });

    expect(value).toMatchObject({ status: 'queued', snapshot: { provider: 'unresolved', model: 'unresolved', modelConfigHash: 'unresolved' } });
    expect(enqueue).toHaveBeenCalledWith(scope, 'exp');
  });

  it('cancel/query/resumeとNotFoundを処理する', async () => {
    const repo = new Repo(); repo.value = startExperiment(makeExperiment(), 'start'); const worker = { enqueue: vi.fn(), cancel: vi.fn(), drainInFlight: vi.fn().mockResolvedValue(true), shutdown: vi.fn() } satisfies ExperimentWorkerPort;
    expect(await new QueryExperimentsUseCase(repo).get(scope, 'exp')).toMatchObject({ status: 'running' });
    expect(await new CancelExperimentUseCase(repo, worker, () => new Date('2026-07-10T00:00:01Z')).execute(scope, 'exp')).toMatchObject({ status: 'cancelled' }); expect(worker.cancel).toHaveBeenCalled();
    repo.value = interruptExperiment(startExperiment(makeExperiment(), 'start'), 'stop');
    expect(await new ResumeExperimentUseCase(repo, worker).execute(scope, 'exp')).toMatchObject({ status: 'queued' }); expect(worker.enqueue).toHaveBeenCalled();
    expect(await new QueryExperimentsUseCase(repo).list(scope)).toHaveLength(1); expect(await new QueryExperimentsUseCase(repo).results(scope, 'exp')).toEqual([]);
    repo.value = null; await expect(new QueryExperimentsUseCase(repo).get(scope, 'missing')).rejects.toBeInstanceOf(ExperimentNotFoundError); await expect(new CancelExperimentUseCase(repo, worker).execute(scope, 'missing')).rejects.toBeInstanceOf(ExperimentNotFoundError); await expect(new ResumeExperimentUseCase(repo, worker).execute(scope, 'missing')).rejects.toBeInstanceOf(ExperimentNotFoundError);
  });
});
