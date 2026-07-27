import { describe, expect, it } from 'vitest';
import { deserializeFactoryRun, serializeFactoryRun } from './serialization';
import { FactoryValidationError } from './errors';
import type { FactoryRun } from './factory-run';
import type { FactoryPlan } from './factory-plan';
import type { ImprovementProposal } from './improvement-proposal';

const plan: FactoryPlan = {
  agentBrief: { displayName: '売上アシスタント', role: '売上データについて回答する' },
  tools: [
    { key: 'sales-summary', displayName: '売上集計', purpose: '月次売上を集計する', dataSourceId: 'ds-1', sideEffect: 'read-only', outputShape: 'table', argumentSummary: 'month' },
    { key: 'today', displayName: '現在日時', purpose: '「今月」を具体的な年月に解決する', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId: 'builtin-current-datetime', rationale: '組み込みツールで足りる' } },
  ],
  skills: [{ key: 'summarize', displayName: '要約', responsibility: '傾向を要約する', activationCondition: '売上について聞かれたとき', toolKeys: ['sales-summary'] }],
  personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja', extraInstructions: '専門用語を避ける' }],
  scenarios: [{ key: 'monthly-summary', goal: '先月の売上を知りたい', context: '締め前で急いでいる', personaKey: 'accountant', expectedToolKeys: ['sales-summary'], maxUserTurns: 4 }],
};

const proposals: readonly ImprovementProposal[] = [
  { kind: 'system-prompt-revision', agentId: 'agent-1', sections: { role: '役割文', rules: '追加規則' }, rationale: '目標達成率が低いため' },
  { kind: 'skill-instructions-revision', skillId: 'skill-1', instructions: '新しい手順', activationCondition: '常に', rationale: '曖昧だったため' },
  { kind: 'tool-contract-revision', toolId: 'tool-1', agentTool: { name: 'newName', description: '新しい説明' }, rationale: '説明が不十分' },
  { kind: 'tool-graph-revision', toolId: 'tool-1', graph: { nodes: [{ id: 'n1', type: 'source', config: { sourceId: 'ds-1' } }], edges: [{ from: 'n1', to: 'n2', toInput: 0 }] }, rationale: 'グラフ修正' },
  { kind: 'add-tool', plan: plan.tools[0]!, rationale: '不足Tool追加' },
  { kind: 'add-skill', plan: { key: 'anomaly', displayName: '異常値の説明', responsibility: '異常な売上行を説明する', activationCondition: '数字が不自然だと聞かれたとき', inputDescription: '質問', outputDescription: '説明', instructions: 'sales_lookup で行を取得し、外れ値を説明する', toolRefs: ['tool-1', 'sales-summary'] }, rationale: '不足Skill追加' },
  // 任意フィールド（input/outputDescription）を省いた形も往復できること。
  { kind: 'add-skill', plan: { key: 'minimal', displayName: '最小', responsibility: 'r', activationCondition: 'c', instructions: 'i', toolRefs: [] }, rationale: '最小形' },
];

function makeFullRun(): FactoryRun {
  return {
    id: 'run-1',
    scope: { tenantId: 't', workspaceId: 'w' },
    input: {
      goal: { goal: '売上について答える', targetUsers: '経理担当者', constraints: 'SQL不可', language: 'ja' },
      dataSourceIds: ['ds-1'],
      options: { maxIterations: 3, personaCount: 2, scenarioCount: 4, requirePlanApproval: true, promptStrategy: 'rewrite', targets: { minGoalAchievedRate: 0.75, minAvgSatisfaction: 4 }, budget: { maxDurationMs: 1_800_000, maxRoleCalls: 40, maxScenarioRuns: 20, maxRepairAttempts: 2, maxProposalsPerIteration: 4 } },
    },
    status: 'succeeded',
    stage: 'reporting',
    plan,
    artifacts: {
      tools: [{ internalId: 'tool-1', version: '0.1.0' }],
      skills: [{ internalId: 'skill-1', version: '0.1.0' }],
      agentVersions: [{ internalId: 'agent-1', version: '0.1.0' }, { internalId: 'agent-1', version: '0.2.0' }],
      personas: [{ internalId: 'persona-1', version: '0.1.0' }],
      pseudoUsers: [{ internalId: 'pseudo-1', version: '0.1.0' }],
      scenarios: [{ internalId: 'scenario-1', version: '0.1.0' }],
    },
    iterations: [
      {
        index: 1,
        agentVersion: '0.1.0',
        scenarioRunIds: ['sr-1', 'sr-2'],
        metrics: { iteration: 1, goalAchievedRate: 0.5, avgSatisfaction: 3, toolHitRate: 0.8, errorRate: 0, avgUserTurns: 3, scenarioCount: 4, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, durationMs: 1000 },
        analysis: {
          findings: [{ id: 'f1', severity: 'critical', area: 'tool', detail: '重大な不具合' }],
          applied: proposals.map((proposal, index) => ({ proposal, resultingVersion: { internalId: `asset-${index}`, version: '0.1.0' } })),
          rejected: proposals.map((proposal) => ({ proposal, reason: '検証失敗' })),
        },
      },
      {
        index: 2,
        agentVersion: '0.2.0',
        scenarioRunIds: ['sr-3'],
        metrics: { iteration: 2, goalAchievedRate: 0.9, avgSatisfaction: 4.5, toolHitRate: 1, errorRate: 0, avgUserTurns: 2, scenarioCount: 4, usage: {}, durationMs: 500 },
      },
    ],
    report: { bestIteration: 2, candidate: { agentId: 'agent-1', version: '0.2.0' }, summary: '目標達成', openFindings: [{ id: 'f2', severity: 'info', area: 'scenario', detail: '軽微な指摘' }], metricsByIteration: [{ iteration: 1, goalAchievedRate: 0.5, avgSatisfaction: 3, toolHitRate: 0.8, errorRate: 0, avgUserTurns: 3, scenarioCount: 4, usage: {}, durationMs: 1000 }] },
    checkpoint: undefined,
    budget: { consumed: { roleCalls: 12, scenarioRuns: 8, elapsedMs: 120_000 }, limits: { maxDurationMs: 1_800_000, maxRoleCalls: 40, maxScenarioRuns: 20, maxRepairAttempts: 2, maxProposalsPerIteration: 4 } },
    failure: undefined,
    events: [
      { sequence: 1, kind: 'stage_started', at: '2026-07-20T00:00:00Z', stage: 'profiling' },
      { sequence: 2, kind: 'tool_generated', at: '2026-07-20T00:01:00Z', stage: 'generating-tools', iteration: 1, message: 'Tool生成完了', ref: { internalId: 'tool-1', version: '0.1.0' } },
    ],
    startedAt: '2026-07-20T00:00:00Z',
    finishedAt: '2026-07-20T00:30:00Z',
  };
}

describe('serializeFactoryRun / deserializeFactoryRun', () => {
  it('往復でロスレスに復元する（plan/checkpoint/iterations/report/budget/failureを含む）', () => {
    const run = makeFullRun();
    const restored = deserializeFactoryRun(serializeFactoryRun(run));
    expect(restored).toEqual(run);
    // 既存Toolの再利用計画（reuse）も落とさず往復する。
    expect(restored.plan?.tools[1]?.reuse).toEqual({ internalId: 'builtin-current-datetime', rationale: '組み込みツールで足りる' });
  });

  it('waiting-approvalのcheckpoint（planを含む）も往復する', () => {
    const run: FactoryRun = { ...makeFullRun(), status: 'waiting-approval', report: undefined, checkpoint: { kind: 'plan-approval', expiresAt: '2026-07-21T00:00:00Z', prompt: '計画を確認してください', plan } };
    const restored = deserializeFactoryRun(serializeFactoryRun(run));
    expect(restored).toEqual(run);
  });

  it('既存Agent強化モードの input.baseAgent（版指定あり/なし・データソース0件）も往復する', () => {
    const base = makeFullRun();
    const pinned: FactoryRun = { ...base, input: { ...base.input, dataSourceIds: [], baseAgent: { internalId: 'agent-1', version: '0.1.0' } } };
    expect(deserializeFactoryRun(serializeFactoryRun(pinned))).toEqual(pinned);
    const latest: FactoryRun = { ...base, input: { ...base.input, baseAgent: { internalId: 'agent-1' } } };
    expect(deserializeFactoryRun(serializeFactoryRun(latest)).input.baseAgent).toEqual({ internalId: 'agent-1' });
    // 生成モード（baseAgent未指定）は従来どおりフィールドごと現れない。
    expect(deserializeFactoryRun(serializeFactoryRun(base)).input.baseAgent).toBeUndefined();
  });

  it('promptStrategy を持たない旧レコードは preserve（従来の挙動）として読み出す', () => {
    const legacy = JSON.parse(serializeFactoryRun(makeFullRun())) as { input: { options: Record<string, unknown> } };
    delete legacy.input.options['promptStrategy'];
    expect(deserializeFactoryRun(JSON.stringify(legacy)).input.options.promptStrategy).toBe('preserve');
  });

  it('failureを含むfailed runも往復する', () => {
    const run: FactoryRun = { ...makeFullRun(), status: 'failed', report: undefined, failure: { stage: 'generating-tools', reason: 'Tool生成に失敗' } };
    const restored = deserializeFactoryRun(serializeFactoryRun(run));
    expect(restored).toEqual(run);
  });

  it('不正なJSON文字列はFactoryValidationErrorを投げる', () => {
    expect(() => deserializeFactoryRun('{not-json')).toThrow(FactoryValidationError);
  });

  it('スキーマ不適合はFactoryValidationErrorを投げる', () => {
    expect(() => deserializeFactoryRun(JSON.stringify({ id: 'x' }))).toThrow(FactoryValidationError);
  });

  it('スキーマ不適合な値はserializeでもFactoryValidationErrorを投げる', () => {
    const invalid = { ...makeFullRun(), status: 'bogus' } as unknown as FactoryRun;
    expect(() => serializeFactoryRun(invalid)).toThrow(FactoryValidationError);
  });
});
