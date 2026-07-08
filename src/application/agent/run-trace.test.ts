import { describe, expect, it } from 'vitest';
import { failureFrom, sanitizeRunTrace } from './run-trace';
import { AgentRunError } from './errors';

describe('run trace persistence helpers', () => {
  it('secret-like keyを再帰maskしDateをISO化する', () => {
    const trace = sanitizeRunTrace([{ sequence: 1, kind: 'tool-call', name: 'x', arguments: {
      password: 'p', nested: { apiKey: 'k', at: new Date('2026-07-03T00:00:00Z') }, safe: 'ok',
    } }]);
    expect(trace[0]).toMatchObject({ arguments: { password: '[REDACTED]', nested: { apiKey: '[REDACTED]', at: '2026-07-03T00:00:00.000Z' }, safe: 'ok' } });
  });

  it('coded errorだけmessageを保持しunknownは秘匿する', () => {
    expect(failureFrom(new AgentRunError('bad'))).toEqual({ code: 'AGENT_RUN', message: 'bad' });
    expect(failureFrom(new Error('secret detail'))).toEqual({ code: 'INTERNAL', message: 'internal error' });
  });

  it('agent_callイベントを保持したままサニタイズする', () => {
    const trace = sanitizeRunTrace([
      { sequence: 1, kind: 'agent_call', toolName: 'ask_scorer', agentRef: { internalId: 'scorer', version: '1.0.0' }, childRunId: 'run-child', ok: true, summary: 'scored 42' },
    ]);
    expect(trace[0]).toEqual({ sequence: 1, kind: 'agent_call', toolName: 'ask_scorer', agentRef: { internalId: 'scorer', version: '1.0.0' }, childRunId: 'run-child', ok: true, summary: 'scored 42' });
  });
});
