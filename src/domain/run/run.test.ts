import { describe, expect, it } from 'vitest';
import { failRun, resumeRunRecord, startRun, succeedRun, waitRunForApproval, type RunApprovalCheckpoint } from './run';

const started = startRun({ runId: 'run-1', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', tool: { internalId: 'tool' }, startedAt: '2026-07-03T00:00:00.000Z' });

const checkpoint: RunApprovalCheckpoint = {
  kind: 'tool-approval',
  agentRef: { internalId: 'agent', version: '1.0.0' },
  messages: [{ role: 'system', content: 'be safe' }, { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'write_tool', arguments: { id: 7 } }] }],
  pendingCalls: [{ id: 'c1', name: 'write_tool', arguments: { id: 7 } }],
  executedToolRefs: [],
  budget: { remainingModelRounds: 4, remainingToolCalls: 9 },
  step: 1,
  expiresAt: '2026-07-04T00:00:00.000Z',
  prompt: 'Approval required: write_tool',
};

describe('RunRecord transitions', () => {
  it('runningからsucceededへ遷移し入力を複製する', () => {
    const trace = [{ sequence: 1, kind: 'model-response' as const, content: 'done' }];
    const tools = [{ internalId: 'tool', version: '1.0.0' }];
    const run = succeedRun(started, { tool: tools[0], tools, response: 'done', trace, usage: { totalTokens: 3 }, completedAt: '2026-07-03T00:00:01.000Z' });
    expect(run).toMatchObject({ status: 'succeeded', response: 'done', tool: { version: '1.0.0' }, tools: [{ version: '1.0.0' }] });
    trace[0]!.content = 'changed';
    tools[0]!.version = 'changed';
    expect(run.trace[0]).toMatchObject({ content: 'done' });
    expect(run.tools?.[0]?.version).toBe('1.0.0');
  });

  it('runningからfailedへ遷移する', () => {
    expect(failRun(started, { trace: [{ sequence: 1, kind: 'error', code: 'X', message: 'bad' }], failure: { code: 'X', message: 'bad' }, completedAt: '2026-07-03T00:00:01.000Z' })).toMatchObject({ status: 'failed', failure: { code: 'X' } });
  });

  it('完了済みrunの再遷移を拒否する', () => {
    const done = failRun(started, { trace: [], failure: { code: 'X', message: 'bad' }, completedAt: '2026-07-03T00:00:01.000Z' });
    expect(() => failRun(done, { trace: [], failure: { code: 'Y', message: 'again' }, completedAt: '2026-07-03T00:00:02.000Z' })).toThrow(/already failed/);
  });

  it('runningからwaiting-approvalへ遷移し、checkpointと進捗を複製して保持する', () => {
    const trace = [{ sequence: 1, kind: 'model-request' as const, step: 1, toolNames: ['write_tool'] }];
    const waiting = waitRunForApproval(started, checkpoint, { trace, usage: { totalTokens: 4 }, latency: { totalMs: 9, modelMs: 8, toolMs: 0 }, response: checkpoint.prompt });
    expect(waiting).toMatchObject({ status: 'waiting-approval', response: checkpoint.prompt, usage: { totalTokens: 4 } });
    expect(waiting.checkpoint).toEqual(checkpoint);
    expect(waiting.checkpoint).not.toBe(checkpoint);
    trace[0]!.step = 99;
    expect(waiting.trace[0]).toMatchObject({ step: 1 });
    expect(() => waitRunForApproval(waiting, checkpoint)).toThrow(/already waiting-approval/);
  });

  it('waiting-approvalからrunningへ戻すとcheckpointを捨て、succeeded/failedはcheckpointを持たない', () => {
    const waiting = waitRunForApproval(started, checkpoint);
    const resumed = resumeRunRecord(waiting);
    expect(resumed.status).toBe('running');
    expect(resumed.checkpoint).toBeUndefined();
    expect(succeedRun(resumed, { response: 'ok', trace: [], usage: {}, completedAt: '2026-07-03T00:00:02.000Z' }).checkpoint).toBeUndefined();
    expect(failRun(resumed, { trace: [], failure: { code: 'X', message: 'bad' }, completedAt: '2026-07-03T00:00:02.000Z' }).checkpoint).toBeUndefined();
    expect(() => resumeRunRecord(resumed)).toThrow(/not waiting for approval/);
  });
});
