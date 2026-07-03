import { describe, expect, it } from 'vitest';
import { failRun, startRun, succeedRun } from './run';

const started = startRun({ runId: 'run-1', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', tool: { internalId: 'tool' }, startedAt: '2026-07-03T00:00:00.000Z' });

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
});
