import { describe, expect, it } from 'vitest';
import { startRun, type RunRecord } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import { RunNotFoundError } from '../../domain/run/errors';
import { QueryRunsUseCase } from './query-runs';

class FakeRuns implements RunRepository {
  constructor(private readonly record: RunRecord | null) {}
  async save(): Promise<void> {}
  async find(): Promise<RunRecord | null> { return this.record; }
  async list(): Promise<RunRecord[]> { return this.record === null ? [] : [this.record]; }
}

const record = startRun({ runId: 'run-1', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', tool: { internalId: 'tool' }, startedAt: 'now' });

describe('QueryRunsUseCase', () => {
  it('get/listをportへ委譲する', async () => {
    const useCase = new QueryRunsUseCase(new FakeRuns(record));
    await expect(useCase.get(record.scope, record.runId)).resolves.toEqual(record);
    await expect(useCase.list(record.scope, { limit: 1, status: 'running' })).resolves.toEqual([record]);
  });

  it('未存在をRunNotFoundErrorにする', async () => {
    await expect(new QueryRunsUseCase(new FakeRuns(null)).get(record.scope, 'nope')).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
