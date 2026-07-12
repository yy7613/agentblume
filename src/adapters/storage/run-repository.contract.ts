import { expect } from 'vitest';
import { failRun, startRun, succeedRun, type RunRecord } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function running(runId: string, startedAt: string): RunRecord {
  return startRun({ runId, scope, mode: 'preview', tool: { internalId: 'tool', version: '1.0.0' }, startedAt });
}
export async function runRepositoryContract(repo: RunRepository): Promise<void> {
  const first = running('run-1', '2026-07-03T00:00:00.000Z');
  await repo.save(first);
  await expect(repo.find(scope, 'run-1')).resolves.toEqual(first);

  const success = succeedRun(first, {
    tool: { internalId: 'tool', version: '1.0.0', publishName: 'tool_call' }, response: 'done', trace: [{ sequence: 1, kind: 'model-response', content: 'done' }], usage: { totalTokens: 5 }, completedAt: '2026-07-03T00:00:01.000Z',
  });
  await repo.save(success);
  await expect(repo.find(scope, 'run-1')).resolves.toMatchObject({ status: 'succeeded', response: 'done' });

  const second = running('run-2', '2026-07-03T00:00:02.000Z');
  await repo.save(failRun(second, { trace: [{ sequence: 1, kind: 'error', code: 'FAIL', message: 'failed' }], failure: { code: 'FAIL', message: 'failed' }, completedAt: '2026-07-03T00:00:03.000Z' }));
  await expect(repo.list(scope, { limit: 1 })).resolves.toMatchObject([{ runId: 'run-2' }]);
  await expect(repo.list(scope, { status: 'failed' })).resolves.toMatchObject([{ runId: 'run-2', status: 'failed' }]);
  await expect(repo.find({ tenantId: 'other', workspaceId: 'workspace' }, 'run-1')).resolves.toBeNull();

  const retained = succeedRun(running('run-retained', '2026-07-03T12:00:00.000Z'), { response: 'sensitive payload', trace: [{ sequence: 1, kind: 'model-response', content: 'sensitive trace' }], usage: { totalTokens: 1 }, completedAt: '2026-07-03T12:00:01.000Z' });
  await repo.save(retained);
  expect(repo.applyRetention).toBeTypeOf('function');
  await repo.applyRetention?.(scope, { payloadBefore: '2026-07-04T00:00:00.000Z', traceBefore: '2026-07-01T00:00:00.000Z', deleteBefore: '2026-07-01T00:00:00.000Z' });
  const redacted = await repo.find(scope, 'run-retained');
  expect(redacted?.response).toBeUndefined(); expect(redacted?.trace).toMatchObject([{ kind: 'model-response' }]);
  await repo.applyRetention?.(scope, { payloadBefore: '2026-07-04T00:00:00.000Z', traceBefore: '2026-07-04T00:00:00.000Z', deleteBefore: '2026-07-04T00:00:00.000Z' });
  await expect(repo.find(scope, 'run-retained')).resolves.toBeNull();
}
