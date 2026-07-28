import { expect } from 'vitest';
import { createExperiment, createExperimentCaseResult, interruptExperiment, startExperiment } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { ExperimentConflictError } from '../../domain/evaluation/errors';
import { SemVer } from '../../domain/tool/semver';

const scope = { tenantId: 't', workspaceId: 'w' };
const make = (id: string, createdAt: string, tenant = scope) => createExperiment({ id, scope: tenant, target: { agentId: 'agent', version: SemVer.of(1, 0, 0) }, dataset: { id: 'set', version: SemVer.of(1, 0, 0) }, evaluatorProfile: { id: 'profile', version: SemVer.of(1, 0, 0) }, repetitions: 1, status: 'queued', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 0, total: 1 }, createdAt });

export async function experimentRepositoryContract(repo: ExperimentRepository): Promise<void> {
  const first = make('first', '2026-07-10T00:00:00Z'); const second = make('second', '2026-07-10T00:00:02Z'); const hidden = make('hidden', '2026-07-10T00:00:03Z', { tenantId: 'other', workspaceId: 'w' });
  await repo.create(first); await repo.create(second); await repo.create(hidden);
  await expect(repo.create(first)).rejects.toBeInstanceOf(ExperimentConflictError);
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['second', 'first']);
  const running = startExperiment(first, 'start'); await repo.update(running);
  expect((await repo.list(scope, { status: 'running' })).map((item) => item.id)).toEqual(['first']);
  const result = createExperimentCaseResult({ experimentId: 'first', scope, caseId: 'case', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: ['run'], scores: [], latencyMs: 1, usage: {} });
  await repo.saveCaseResult(result); expect(await repo.listCaseResults(scope, 'first')).toEqual([result]);
  await expect(repo.saveCaseResult(result)).rejects.toBeInstanceOf(ExperimentConflictError);
  // listAllByStatus: 起動時の孤児Run回収が使う横断クエリ。テナント境界を越え、createdAt 昇順で返す。
  expect((await repo.listAllByStatus('running')).map((item) => item.id)).toEqual(['first']);
  expect((await repo.listAllByStatus('queued')).map((item) => item.id)).toEqual(['second', 'hidden']);
  await repo.update(interruptExperiment(running, 'restart'));
  expect(await repo.find(scope, 'first')).toMatchObject({ status: 'interrupted', error: { code: 'PROCESS_INTERRUPTED' } });
  expect(await repo.listAllByStatus('running')).toEqual([]);
  expect(await repo.find({ tenantId: 'other', workspaceId: 'w' }, 'first')).toBeNull();
}
