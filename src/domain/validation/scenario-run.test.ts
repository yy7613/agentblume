import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import { createScenarioRun, type CreateScenarioRunProps, type ScenarioRun } from './scenario-run';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function props(overrides: Partial<CreateScenarioRunProps> = {}): CreateScenarioRunProps {
  return {
    id: 'run-1',
    scope,
    scenario: { id: 'scenario-1', version: SemVer.of(1, 0, 0) },
    status: 'completed',
    goalAchieved: true,
    transcript: [
      { speaker: 'user', message: '質問' },
      { speaker: 'agent', message: '回答', runId: 'agent-run-1' },
    ],
    survey: [{ questionId: 'q1', value: true }, { questionId: 'impressions', value: '良い' }],
    impressions: '良い',
    metrics: { userTurns: 1, agentRuns: 1, totalToolCalls: 2, durationMs: 1200, usage: { totalTokens: 30 } },
    startedAt: '2026-07-01T00:00:00.000Z',
    finishedAt: '2026-07-01T00:00:01.200Z',
    ...overrides,
  };
}

describe('createScenarioRun', () => {
  it('最小整合チェックを通し防御的コピーを返す', () => {
    const run = createScenarioRun(props());
    expect(run).toMatchObject({ id: 'run-1', status: 'completed', goalAchieved: true, impressions: '良い' });
    expect(run.transcript[1]).toEqual({ speaker: 'agent', message: '回答', runId: 'agent-run-1' });
    expect(run.metrics.usage).toEqual({ totalTokens: 30 });
    expect('expectedToolHit' in run.metrics).toBe(false);
  });

  it('expectedToolHit と goalAchieved:null を保持する', () => {
    const run = createScenarioRun(props({
      goalAchieved: null,
      metrics: { userTurns: 0, agentRuns: 0, totalToolCalls: 0, expectedToolHit: { expected: ['a', 'b'], called: ['a'], hitRate: 0.5 }, durationMs: 0, usage: {} },
    }));
    expect(run.goalAchieved).toBeNull();
    expect(run.metrics.expectedToolHit).toEqual({ expected: ['a', 'b'], called: ['a'], hitRate: 0.5 });
  });

  it('不変条件違反は ValidationDomainError', () => {
    expect(() => createScenarioRun(props({ id: '' }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ scope: { tenantId: 't', workspaceId: '' } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ scenario: { id: 's', version: '1.0.0' as unknown as SemVer } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ status: 'running' as ScenarioRun['status'] }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ goalAchieved: 'yes' as unknown as boolean }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ transcript: [{ speaker: 'model' as 'user', message: 'x' }] }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ transcript: [{ speaker: 'user', message: 1 as unknown as string }] }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ transcript: [{ speaker: 'agent', message: 'x', runId: '' }] }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ survey: [{ questionId: '', value: 1 }] }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ survey: [{ questionId: 'q', value: null as unknown as string }] }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ impressions: 1 as unknown as string }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ metrics: { ...props().metrics, userTurns: -1 } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ metrics: { ...props().metrics, agentRuns: 0.5 } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ metrics: { ...props().metrics, totalToolCalls: -2 } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ metrics: { ...props().metrics, durationMs: -1 } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ metrics: { ...props().metrics, expectedToolHit: { expected: ['a'], called: [], hitRate: 1.5 } } }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ startedAt: '' }))).toThrow(ValidationDomainError);
    expect(() => createScenarioRun(props({ finishedAt: '' }))).toThrow(ValidationDomainError);
  });
});
