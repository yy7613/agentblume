import { describe, expect, it } from 'vitest';
import {
  advanceStage,
  appendFactoryEvent,
  attachAnalysisToLastIteration,
  beginFactoryRun,
  cancelFactoryRun,
  DEFAULT_FACTORY_OPTIONS,
  failFactoryRun,
  recordIteration,
  resumeFactoryRun,
  setArtifacts,
  setPlan,
  startFactoryRun,
  succeedFactoryRun,
  updateBudget,
  waitForPlanApproval,
  type FactoryArtifacts,
  type FactoryIteration,
  type FactoryReport,
  type FactoryRun,
} from './factory-run';
import type { FactoryPlan } from './factory-plan';

const scope = { tenantId: 't', workspaceId: 'w' };

function makeRun(): FactoryRun {
  return startFactoryRun({
    id: 'run-1',
    scope,
    input: { goal: { goal: '売上について答える', language: 'ja' }, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS },
    startedAt: '2026-07-20T00:00:00Z',
  });
}

const plan: FactoryPlan = {
  agentBrief: { displayName: '売上アシスタント', role: '売上データについて回答する' },
  tools: [{ key: 'sales-summary', displayName: '売上集計', purpose: '月次売上を集計する', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
  skills: [{ key: 'summarize', displayName: '要約', responsibility: '傾向を要約する', activationCondition: '売上について聞かれたとき', toolKeys: ['sales-summary'] }],
  personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja' }],
  scenarios: [{ key: 'monthly-summary', goal: '先月の売上を知りたい', personaKey: 'accountant', expectedToolKeys: ['sales-summary'], maxUserTurns: 4 }],
};

describe('startFactoryRun', () => {
  it('queued状態・profilingステージ・空のartifacts/iterations/eventsで開始する', () => {
    const run = makeRun();
    expect(run.status).toBe('queued');
    expect(run.stage).toBe('profiling');
    expect(run.artifacts).toEqual({ tools: [], skills: [], agentVersions: [], personas: [], pseudoUsers: [], scenarios: [] });
    expect(run.iterations).toEqual([]);
    expect(run.events).toEqual([]);
    expect(run.budget).toEqual({ consumed: { roleCalls: 0, scenarioRuns: 0, elapsedMs: 0 }, limits: DEFAULT_FACTORY_OPTIONS.budget });
  });

  it('入力を非mutateに複製する（呼び出し元の変更が反映されない）', () => {
    const input = { id: 'run-2', scope, input: { goal: { goal: 'g', language: 'ja' as const }, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS }, startedAt: '2026-07-20T00:00:00Z' };
    const run = startFactoryRun(input);
    input.input.dataSourceIds.push('ds-2');
    expect(run.input.dataSourceIds).toEqual(['ds-1']);
  });
});

describe('beginFactoryRun', () => {
  it('queued → running', () => {
    const run = beginFactoryRun(makeRun());
    expect(run.status).toBe('running');
  });

  it('queuedでない場合は例外を投げる', () => {
    const run = beginFactoryRun(makeRun());
    expect(() => beginFactoryRun(run)).toThrow(/already running/);
  });
});

describe('appendFactoryEvent', () => {
  it('sequenceを自動採番しながら追記する', () => {
    let run = beginFactoryRun(makeRun());
    run = appendFactoryEvent(run, { kind: 'stage_started', at: '2026-07-20T00:00:01Z', stage: 'profiling' });
    run = appendFactoryEvent(run, { kind: 'stage_completed', at: '2026-07-20T00:00:02Z', stage: 'profiling' });
    expect(run.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(run.events[1]?.kind).toBe('stage_completed');
  });
});

describe('advanceStage', () => {
  it('runningの場合のみステージを更新する', () => {
    const run = advanceStage(beginFactoryRun(makeRun()), 'planning');
    expect(run.stage).toBe('planning');
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => advanceStage(makeRun(), 'planning')).toThrow(/not running/);
  });
});

describe('setPlan', () => {
  it('計画を複製して保存する（元のplanを変更しても反映されない）', () => {
    const tools = [...plan.tools];
    const mutablePlan: FactoryPlan = { ...plan, tools };
    const run = setPlan(beginFactoryRun(makeRun()), mutablePlan);
    tools.push({ key: 'extra', displayName: 'x', purpose: 'y', dataSourceId: 'ds-1', sideEffect: 'read-only' });
    expect(run.plan?.tools).toHaveLength(1);
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => setPlan(makeRun(), plan)).toThrow(/not running/);
  });
});

describe('recordIteration', () => {
  const iteration: FactoryIteration = {
    index: 1,
    agentVersion: '0.1.0',
    scenarioRunIds: ['sr-1'],
    metrics: { iteration: 1, goalAchievedRate: 0.5, avgSatisfaction: 3, toolHitRate: 0.8, errorRate: 0, avgUserTurns: 3, scenarioCount: 4, usage: { totalTokens: 100 }, durationMs: 1000 },
    analysis: {
      findings: [{ id: 'f1', severity: 'warning', area: 'tool', detail: '曖昧な回答' }],
      applied: [{ proposal: { kind: 'add-tool', plan: plan.tools[0]!, rationale: '不足していたため' }, resultingVersion: { internalId: 'tool-1', version: '0.1.0' } }],
      rejected: [{ proposal: { kind: 'skill-instructions-revision', skillId: 'skill-1', instructions: 'do X', rationale: 'r' }, reason: '検証失敗' }],
    },
  };

  it('イテレーションを複製して追記する', () => {
    const run = recordIteration(beginFactoryRun(makeRun()), iteration);
    expect(run.iterations).toHaveLength(1);
    expect(run.iterations[0]).toEqual(iteration);
    expect(run.iterations[0]).not.toBe(iteration);
  });

  it('元のiterationオブジェクトを変更しても反映されない', () => {
    const scenarioRunIds = [...iteration.scenarioRunIds];
    const mutable: FactoryIteration = { ...iteration, scenarioRunIds };
    const run = recordIteration(beginFactoryRun(makeRun()), mutable);
    scenarioRunIds.push('sr-2');
    expect(run.iterations[0]?.scenarioRunIds).toEqual(['sr-1']);
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => recordIteration(makeRun(), iteration)).toThrow(/not running/);
  });
});

describe('attachAnalysisToLastIteration', () => {
  const iteration1: FactoryIteration = {
    index: 1,
    agentVersion: '0.1.0',
    scenarioRunIds: ['sr-1'],
    metrics: { iteration: 1, goalAchievedRate: 0.5, avgSatisfaction: 3, toolHitRate: 0.8, errorRate: 0, avgUserTurns: 3, scenarioCount: 4, usage: { totalTokens: 100 }, durationMs: 1000 },
  };
  const iteration2: FactoryIteration = {
    index: 2,
    agentVersion: '0.2.0',
    scenarioRunIds: ['sr-2'],
    metrics: { iteration: 2, goalAchievedRate: 0.8, avgSatisfaction: 4, toolHitRate: 0.9, errorRate: 0, avgUserTurns: 3, scenarioCount: 4, usage: { totalTokens: 120 }, durationMs: 1100 },
  };
  const analysis = {
    findings: [{ id: 'f1', severity: 'warning' as const, area: 'tool', detail: '曖昧な回答' }],
    applied: [{ proposal: { kind: 'add-tool' as const, plan: plan.tools[0]!, rationale: '不足していたため' }, resultingVersion: { internalId: 'tool-1', version: '0.1.0' } }],
    rejected: [{ proposal: { kind: 'skill-instructions-revision' as const, skillId: 'skill-1', instructions: 'do X', rationale: 'r' }, reason: '検証失敗' }],
  };

  it('最後のイテレーションだけへanalysisを付与する（先行イテレーションは変更しない）', () => {
    let run = beginFactoryRun(makeRun());
    run = recordIteration(run, iteration1);
    run = recordIteration(run, iteration2);

    const withAnalysis = attachAnalysisToLastIteration(run, analysis);

    expect(withAnalysis.iterations).toHaveLength(2);
    expect(withAnalysis.iterations[0]?.analysis).toBeUndefined();
    expect(withAnalysis.iterations[1]?.analysis).toEqual(analysis);
    // 元のrunは変更されない（非mutate）。
    expect(run.iterations[1]?.analysis).toBeUndefined();
  });

  it('既存のanalysisを上書きする', () => {
    let run = beginFactoryRun(makeRun());
    run = recordIteration(run, iteration1);
    run = attachAnalysisToLastIteration(run, analysis);
    const replaced = attachAnalysisToLastIteration(run, { findings: [], applied: [], rejected: [] });
    expect(replaced.iterations[0]?.analysis).toEqual({ findings: [], applied: [], rejected: [] });
  });

  it('イテレーションが無い場合は例外を投げる', () => {
    const run = beginFactoryRun(makeRun());
    expect(() => attachAnalysisToLastIteration(run, { findings: [], applied: [], rejected: [] })).toThrow(/no iterations/);
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => attachAnalysisToLastIteration(makeRun(), { findings: [], applied: [], rejected: [] })).toThrow(/not running/);
  });
});

describe('updateBudget', () => {
  it('消費量を更新する', () => {
    const run = updateBudget(beginFactoryRun(makeRun()), { roleCalls: 3, scenarioRuns: 4, elapsedMs: 5000 });
    expect(run.budget.consumed).toEqual({ roleCalls: 3, scenarioRuns: 4, elapsedMs: 5000 });
    expect(run.budget.limits).toEqual(DEFAULT_FACTORY_OPTIONS.budget);
  });
});

describe('setArtifacts', () => {
  const artifacts: FactoryArtifacts = {
    tools: [{ internalId: 'tool-1', version: '0.1.0' }],
    skills: [{ internalId: 'skill-1', version: '0.1.0' }],
    agentVersions: [{ internalId: 'agent-1', version: '0.1.0' }],
    personas: [],
    pseudoUsers: [],
    scenarios: [],
  };

  it('生成資産の出所台帳を複製して差し替える（元の配列を変更しても反映されない）', () => {
    const tools = [...artifacts.tools];
    const mutableArtifacts: FactoryArtifacts = { ...artifacts, tools };
    const run = setArtifacts(beginFactoryRun(makeRun()), mutableArtifacts);
    tools.push({ internalId: 'tool-2', version: '0.1.0' });
    expect(run.artifacts.tools).toHaveLength(1);
    expect(run.artifacts).toEqual(artifacts);
    expect(run.artifacts).not.toBe(artifacts);
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => setArtifacts(makeRun(), artifacts)).toThrow(/not running/);
  });
});

describe('waitForPlanApproval / resumeFactoryRun', () => {
  const checkpoint = { kind: 'plan-approval' as const, expiresAt: '2026-07-21T00:00:00Z', prompt: '計画を確認してください', plan };

  it('running → waiting-approval でcheckpointを複製保存する', () => {
    const run = waitForPlanApproval(beginFactoryRun(makeRun()), checkpoint);
    expect(run.status).toBe('waiting-approval');
    expect(run.checkpoint).toEqual(checkpoint);
    expect(run.checkpoint).not.toBe(checkpoint);
    expect(run.checkpoint?.plan).not.toBe(plan);
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => waitForPlanApproval(makeRun(), checkpoint)).toThrow(/not running/);
  });

  it('waiting-approval → running でcheckpointを消去する', () => {
    const waiting = waitForPlanApproval(beginFactoryRun(makeRun()), checkpoint);
    const resumed = resumeFactoryRun(waiting);
    expect(resumed.status).toBe('running');
    expect(resumed.checkpoint).toBeUndefined();
  });

  it('waiting-approvalでない場合は例外を投げる', () => {
    expect(() => resumeFactoryRun(makeRun())).toThrow(/not waiting for approval/);
  });
});

describe('succeedFactoryRun', () => {
  const report: FactoryReport = { bestIteration: 1, candidate: { agentId: 'agent-1', version: '0.1.0' }, summary: '目標達成', openFindings: [], metricsByIteration: [] };

  it('running → succeeded', () => {
    const run = succeedFactoryRun(beginFactoryRun(makeRun()), report, '2026-07-20T01:00:00Z');
    expect(run.status).toBe('succeeded');
    expect(run.report).toEqual(report);
    expect(run.finishedAt).toBe('2026-07-20T01:00:00Z');
  });

  it('runningでない場合は例外を投げる', () => {
    expect(() => succeedFactoryRun(makeRun(), report, '2026-07-20T01:00:00Z')).toThrow(/already queued/);
  });
});

describe('failFactoryRun', () => {
  it('running → failed', () => {
    const run = failFactoryRun(beginFactoryRun(makeRun()), { stage: 'generating-tools', reason: 'Tool生成に失敗' }, '2026-07-20T01:00:00Z');
    expect(run.status).toBe('failed');
    expect(run.failure).toEqual({ stage: 'generating-tools', reason: 'Tool生成に失敗' });
  });

  it('waiting-approval → failed でcheckpointを消去する', () => {
    const checkpoint = { kind: 'plan-approval' as const, expiresAt: '2026-07-21T00:00:00Z', prompt: 'p', plan };
    const waiting = waitForPlanApproval(beginFactoryRun(makeRun()), checkpoint);
    const failed = failFactoryRun(waiting, { stage: 'planning', reason: '却下' }, '2026-07-20T01:00:00Z');
    expect(failed.status).toBe('failed');
    expect(failed.checkpoint).toBeUndefined();
  });

  it('queuedの場合は例外を投げる', () => {
    expect(() => failFactoryRun(makeRun(), { stage: 'profiling', reason: 'x' }, '2026-07-20T01:00:00Z')).toThrow(/already queued/);
  });
});

describe('cancelFactoryRun', () => {
  it('queued / running / waiting-approval のいずれからもキャンセルできる', () => {
    expect(cancelFactoryRun(makeRun(), 'finish').status).toBe('cancelled');
    expect(cancelFactoryRun(beginFactoryRun(makeRun()), 'finish').status).toBe('cancelled');
    const checkpoint = { kind: 'plan-approval' as const, expiresAt: '2026-07-21T00:00:00Z', prompt: 'p', plan };
    const waiting = waitForPlanApproval(beginFactoryRun(makeRun()), checkpoint);
    const cancelled = cancelFactoryRun(waiting, 'finish');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.checkpoint).toBeUndefined();
  });

  it('終了状態からは例外を投げる', () => {
    const report: FactoryReport = { bestIteration: 1, candidate: { agentId: 'a', version: '0.1.0' }, summary: 's', openFindings: [], metricsByIteration: [] };
    const succeeded = succeedFactoryRun(beginFactoryRun(makeRun()), report, 'finish');
    expect(() => cancelFactoryRun(succeeded, 'finish')).toThrow(/already succeeded/);
  });
});
