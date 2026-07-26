import { describe, expect, it } from 'vitest';
import { validateFactoryPlan, type FactoryPlan } from './factory-plan';
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
