import { describe, expect, it } from 'vitest';
import { MAX_ADDITIONAL_DATA_SOURCES, MAX_PLANNED_COMPUTATIONS, validateFactoryPlan, type FactoryPlan } from './factory-plan';
import { MAX_TOOL_SPEC_COMPUTATIONS } from './tool-spec';
import { FactoryValidationError } from './errors';

const validPlan: FactoryPlan = {
  agentBrief: { displayName: '売上アシスタント', role: '売上データについて回答する' },
  tools: [{ key: 'sales-summary', displayName: '売上集計', purpose: '月次売上を集計する', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
  skills: [{ key: 'summarize', displayName: '要約', responsibility: '傾向を要約する', activationCondition: '売上について聞かれたとき', toolKeys: ['sales-summary'] }],
  personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja' }],
  scenarios: [{ key: 'monthly-summary', goal: '先月の売上を知りたい', personaKey: 'accountant', expectedToolKeys: ['sales-summary'], maxUserTurns: 4 }],
};
const ctx = { dataSourceIds: ['ds-1'] };

describe('validateFactoryPlan', () => {
  it('妥当な計画は例外を投げない', () => {
    expect(() => validateFactoryPlan(validPlan, ctx)).not.toThrow();
  });

  it('agentBrief.displayNameが空の場合は例外を投げる', () => {
    expect(() => validateFactoryPlan({ ...validPlan, agentBrief: { ...validPlan.agentBrief, displayName: '  ' } }, ctx)).toThrow(FactoryValidationError);
  });

  it('tool.dataSourceIdが入力のdataSourceIdsに含まれない場合は例外を投げる', () => {
    const plan: FactoryPlan = { ...validPlan, tools: [{ ...validPlan.tools[0]!, dataSourceId: 'ds-unknown' }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/unknown data source/);
  });

  it('既存Toolの再利用計画はdataSourceIdの省略（空文字）を許す', () => {
    const plan: FactoryPlan = {
      ...validPlan,
      tools: [{ ...validPlan.tools[0]!, dataSourceId: '', reuse: { internalId: 'builtin-current-datetime', rationale: '現在日時は組み込みツールで足りる' } }],
    };
    expect(() => validateFactoryPlan(plan, ctx)).not.toThrow();
  });

  it('再利用計画でもdataSourceIdを指定するなら既知のデータソースでなければならない', () => {
    const plan: FactoryPlan = { ...validPlan, tools: [{ ...validPlan.tools[0]!, dataSourceId: 'ds-unknown', reuse: { internalId: 'tool-1' } }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/unknown data source/);
  });

  it('reuse.internalIdが空の場合は例外を投げる', () => {
    const plan: FactoryPlan = { ...validPlan, tools: [{ ...validPlan.tools[0]!, dataSourceId: '', reuse: { internalId: '  ' } }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/reuse\.internalId/);
  });

  it.each(['write', 'external-action'] as const)('tool.sideEffectが%sの場合は例外を投げる', (sideEffect) => {
    const plan: FactoryPlan = { ...validPlan, tools: [{ ...validPlan.tools[0]!, sideEffect }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/sideEffect/);
  });

  it('toolsの件数が上限を超える場合は例外を投げる', () => {
    const tool = validPlan.tools[0]!;
    const plan: FactoryPlan = { ...validPlan, tools: [1, 2, 3, 4, 5].map((n) => ({ ...tool, key: `tool-${n}` })) };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/tools count/);
  });

  it('カスタム上限を尊重する', () => {
    expect(() => validateFactoryPlan(validPlan, { ...ctx, limits: { maxTools: 0, maxSkills: 3, maxPersonas: 3, maxScenarios: 6 } })).toThrow(/tools count/);
  });

  it('toolキーが重複する場合は例外を投げる', () => {
    const tool = validPlan.tools[0]!;
    const plan: FactoryPlan = { ...validPlan, tools: [tool, { ...tool }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/duplicate tool key/);
  });

  it('skill.toolKeysが未知のtoolキーを参照する場合は例外を投げる', () => {
    const plan: FactoryPlan = { ...validPlan, skills: [{ ...validPlan.skills[0]!, toolKeys: ['unknown-tool'] }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/unknown tool key/);
  });

  it('scenario.personaKeyが未知のpersonaキーを参照する場合は例外を投げる', () => {
    const plan: FactoryPlan = { ...validPlan, scenarios: [{ ...validPlan.scenarios[0]!, personaKey: 'unknown-persona' }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/unknown persona key/);
  });

  it('scenario.expectedToolKeysが未知のtoolキーを参照する場合は例外を投げる', () => {
    const plan: FactoryPlan = { ...validPlan, scenarios: [{ ...validPlan.scenarios[0]!, expectedToolKeys: ['unknown-tool'] }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/unknown tool key/);
  });

  it.each([0, 9, 1.5])('scenario.maxUserTurnsが範囲外(%s)の場合は例外を投げる', (maxUserTurns) => {
    const plan: FactoryPlan = { ...validPlan, scenarios: [{ ...validPlan.scenarios[0]!, maxUserTurns }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/maxUserTurns/);
  });

  it('persona.archetypeが不正な場合は例外を投げる', () => {
    const plan: FactoryPlan = { ...validPlan, personas: [{ ...validPlan.personas[0]!, archetype: 'unknown' as never }] };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/archetype/);
  });
});

// ─── ADR-0047 round 3: 複数データソースを結合するTool計画 ──────────────────────────────
describe('validateFactoryPlan（結合する追加データソース）', () => {
  const basePlan = (additionalDataSourceIds?: readonly string[]): FactoryPlan => ({
    agentBrief: { displayName: 'A', role: 'r' },
    tools: [{
      key: 'joined', displayName: 'Joined', purpose: '賃金と労働時間を同じ時点で並べる。', dataSourceId: 'ds-1', sideEffect: 'read-only',
      ...(additionalDataSourceIds === undefined ? {} : { additionalDataSourceIds }),
    }],
    skills: [], personas: [], scenarios: [],
  });
  const ctx = { dataSourceIds: ['ds-1', 'ds-2', 'ds-3', 'ds-4'] };

  it('正常(回帰固定): 追加idを持たない従来の計画はそのまま通る', () => {
    expect(() => validateFactoryPlan(basePlan(), ctx)).not.toThrow();
    expect(() => validateFactoryPlan(basePlan([]), ctx)).not.toThrow();
  });

  it('異常: Runに無いデータソースを結合先にはできない', () => {
    expect(() => validateFactoryPlan(basePlan(['ds-9']), ctx)).toThrow(/additionalDataSourceIds.0 references unknown data source: ds-9/);
  });

  it('異常: 主データソース自身・重複は拒否する（同じ表を2回読ませない）', () => {
    expect(() => validateFactoryPlan(basePlan(['ds-1']), ctx)).toThrow(/repeats the primary dataSourceId/);
    expect(() => validateFactoryPlan(basePlan(['ds-2', 'ds-2']), ctx)).toThrow(/has a duplicate: ds-2/);
  });

  it('境界: 上限ちょうどは通り、超えたら拒否する', () => {
    expect(() => validateFactoryPlan(basePlan(['ds-2', 'ds-3']), ctx)).not.toThrow();
    expect(() => validateFactoryPlan(basePlan(['ds-2', 'ds-3', 'ds-4']), ctx)).toThrow(new RegExp(`exceeds limit ${MAX_ADDITIONAL_DATA_SOURCES}`));
  });

  it('例外: 既存Toolの再利用計画に結合は付けられない（既存グラフをそのまま使うため）', () => {
    const plan: FactoryPlan = {
      ...basePlan(['ds-2']),
      tools: [{ key: 'reused', displayName: 'R', purpose: 'p', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId: 'tool-x' }, additionalDataSourceIds: ['ds-2'] }],
    };
    expect(() => validateFactoryPlan(plan, ctx)).toThrow(/cannot combine reuse with additionalDataSourceIds/);
  });
});


describe('planned computation contracts', () => {
  it('uses the staged compiler limit and rejects declarations attached to unchanged reused tools', () => {
    expect(MAX_PLANNED_COMPUTATIONS).toBe(MAX_TOOL_SPEC_COMPUTATIONS);
    expect(() => validateFactoryPlan({ ...validPlan, tools: [{ ...validPlan.tools[0]!, reuse: { internalId: 'saved-tool' }, computations: [{ outputColumn: 'x', intent: 'ratio' }] }] }, ctx)).toThrow(/cannot add computations to a reused tool/);
  });
  const planWith = (computations: unknown): FactoryPlan => ({ ...validPlan, tools: [{ ...validPlan.tools[0]!, computations } as FactoryPlan['tools'][number]] });
  it('accepts legacy plans, empty declarations and three distinct computations', () => {
    for (const plan of [validPlan, planWith([]), planWith(['a', 'b', 'c'].map(outputColumn => ({ outputColumn, intent: 'divide two columns' })))]) expect(() => validateFactoryPlan(plan, ctx)).not.toThrow();
  });
  it.each([null, {}, [{ outputColumn: '', intent: 'ratio' }], [{ outputColumn: 'x', intent: '' }], [{ outputColumn: 'x', intent: 'a' }, { outputColumn: 'x', intent: 'b' }], ['a','b','c','d'].map(outputColumn => ({ outputColumn, intent: 'ratio' }))].map(computations => ({ computations })))('rejects malformed or excessive declarations: %j', ({ computations }) => {
    expect(() => validateFactoryPlan(planWith(computations), ctx)).toThrow(FactoryValidationError);
  });
});
