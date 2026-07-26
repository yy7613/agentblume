import { expect } from 'vitest';
import { failRun, startRun, succeedRun, waitRunForApproval, type RunApprovalCheckpoint, type RunRecord } from '../../domain/run/run';
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

  // waiting-approval のcheckpoint（会話履歴・保留呼び出し・バジェット）がJSON永続化を往復する。
  const checkpoint: RunApprovalCheckpoint = {
    kind: 'tool-approval',
    agentRef: { internalId: 'agent', version: '1.0.0' },
    messages: [
      { role: 'system', content: 'be safe' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', imageUrl: 'data:image/png;base64,AA==' }] },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'write_tool', arguments: { id: 7 } }] },
    ],
    pendingCalls: [{ id: 'c1', name: 'write_tool', arguments: { id: 7 } }],
    executedToolRefs: [{ internalId: 'read-tool', version: '1.0.0', publishName: 'read_tool' }],
    budget: { remainingModelRounds: 3, remainingToolCalls: 8 },
    step: 2,
    sessionId: 'session-1',
    expiresAt: '2026-07-04T00:00:00.000Z',
    prompt: 'Approval required: write_tool',
  };
  const waiting = waitRunForApproval(running('run-waiting', '2026-07-03T00:00:04.000Z'), checkpoint, {
    trace: [{ sequence: 1, kind: 'approval-requested', tool: 'write_tool', sideEffect: 'write', prompt: checkpoint.prompt }],
    usage: { totalTokens: 7 }, response: checkpoint.prompt,
  });
  await repo.save(waiting);
  await expect(repo.find(scope, 'run-waiting')).resolves.toEqual(waiting);
  await expect(repo.list(scope, { status: 'waiting-approval' })).resolves.toMatchObject([{ runId: 'run-waiting', status: 'waiting-approval' }]);

  const retained = succeedRun(running('run-retained', '2026-07-03T12:00:00.000Z'), { response: 'sensitive payload', trace: [{ sequence: 1, kind: 'model-response', content: 'sensitive trace' }], usage: { totalTokens: 1 }, completedAt: '2026-07-03T12:00:01.000Z' });
  await repo.save(retained);
  expect(repo.applyRetention).toBeTypeOf('function');
  await repo.applyRetention?.(scope, { payloadBefore: '2026-07-04T00:00:00.000Z', traceBefore: '2026-07-01T00:00:00.000Z', deleteBefore: '2026-07-01T00:00:00.000Z' });
  const redacted = await repo.find(scope, 'run-retained');
  expect(redacted?.response).toBeUndefined(); expect(redacted?.trace).toMatchObject([{ kind: 'model-response' }]);
  await repo.applyRetention?.(scope, { payloadBefore: '2026-07-04T00:00:00.000Z', traceBefore: '2026-07-04T00:00:00.000Z', deleteBefore: '2026-07-04T00:00:00.000Z' });
  await expect(repo.find(scope, 'run-retained')).resolves.toBeNull();
}
