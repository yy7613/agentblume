import { describe, expect, it } from 'vitest';
import { SemVer } from '../../domain/tool/semver';
import { createScenarioRun, type ScenarioRun } from '../../domain/validation/scenario-run';
import { aggregateIterationMetrics } from './metrics';

const scope = { tenantId: 't', workspaceId: 'w' };

function makeRun(overrides: Partial<Parameters<typeof createScenarioRun>[0]> = {}): ScenarioRun {
  return createScenarioRun({
    id: overrides.id ?? 'run-1',
    scope,
    scenario: { id: 'scenario-1', version: SemVer.of(1, 0, 0) },
    status: 'completed',
    goalAchieved: true,
    transcript: [],
    survey: [{ questionId: 'q2', value: 4 }],
    impressions: '',
    metrics: { userTurns: 2, agentRuns: 2, totalToolCalls: 1, durationMs: 100, usage: {} },
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:00:01.000Z',
    ...overrides,
  });
}

describe('aggregateIterationMetrics', () => {
  it('happy path: 複数Runの平均・比率を集計する', () => {
    const runs: ScenarioRun[] = [
      makeRun({
        id: 'run-1',
        goalAchieved: true,
        survey: [{ questionId: 'q2', value: 5 }],
        metrics: { userTurns: 2, agentRuns: 2, totalToolCalls: 1, expectedToolHit: { expected: ['a'], called: ['a'], hitRate: 1 }, durationMs: 100, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      }),
      makeRun({
        id: 'run-2',
        goalAchieved: false,
        survey: [{ questionId: 'q2', value: 3 }],
        metrics: { userTurns: 4, agentRuns: 3, totalToolCalls: 0, expectedToolHit: { expected: ['a'], called: [], hitRate: 0 }, durationMs: 200, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } },
      }),
    ];

    const metrics = aggregateIterationMetrics({ iteration: 1, runs, durationMs: 300 });

    expect(metrics).toEqual({
      iteration: 1,
      goalAchievedRate: 0.5,
      avgSatisfaction: 4,
      toolHitRate: 0.5,
      errorRate: 0,
      avgUserTurns: 3,
      scenarioCount: 2,
      usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
      durationMs: 300,
    });
  });

  it('空のRun集合はすべて0（ゼロ除算しない）', () => {
    const metrics = aggregateIterationMetrics({ iteration: 1, runs: [], durationMs: 0 });
    expect(metrics).toEqual({
      iteration: 1,
      goalAchievedRate: 0,
      avgSatisfaction: 0,
      toolHitRate: 0,
      errorRate: 0,
      avgUserTurns: 0,
      scenarioCount: 0,
      usage: {},
      durationMs: 0,
    });
  });

  it('errorステータスのRunはerrorRateへ反映され、goalAchievedはfalse扱いになる', () => {
    const runs: ScenarioRun[] = [
      makeRun({ id: 'run-1', status: 'completed', goalAchieved: true, survey: [{ questionId: 'q2', value: 5 }] }),
      makeRun({ id: 'run-2', status: 'error', goalAchieved: null, survey: [], metrics: { userTurns: 1, agentRuns: 1, totalToolCalls: 0, durationMs: 50, usage: {} } }),
    ];

    const metrics = aggregateIterationMetrics({ iteration: 2, runs, durationMs: 150 });

    expect(metrics.errorRate).toBe(0.5);
    expect(metrics.goalAchievedRate).toBe(0.5); // 1/2件のみgoalAchieved:true。
    expect(metrics.avgSatisfaction).toBe(5); // q2欠落Runは平均から除外（分母1）。
    expect(metrics.avgUserTurns).toBe(1.5);
  });

  it('アンケート未回答・expectedToolHit未設定のRunは平均の分母から除外する', () => {
    const runs: ScenarioRun[] = [
      makeRun({ id: 'run-1', survey: [], metrics: { userTurns: 3, agentRuns: 1, totalToolCalls: 0, durationMs: 10, usage: {} } }), // q2なし・expectedToolHitなし。
      makeRun({ id: 'run-2', survey: [{ questionId: 'q2', value: 2 }], metrics: { userTurns: 1, agentRuns: 1, totalToolCalls: 1, expectedToolHit: { expected: ['a'], called: ['a'], hitRate: 1 }, durationMs: 10, usage: {} } }),
    ];

    const metrics = aggregateIterationMetrics({ iteration: 1, runs, durationMs: 20 });

    expect(metrics.avgSatisfaction).toBe(2); // run-1はq2なしなので除外。
    expect(metrics.toolHitRate).toBe(1); // run-1はexpectedToolHitなしなので除外。
    expect(metrics.usage).toEqual({}); // 両Runともusageが空オブジェクトなので全フィールド省略。
  });
});
