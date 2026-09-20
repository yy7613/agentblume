import { describe, expect, it } from 'vitest';
import type { FactoryPlan, FactoryScenarioPlan } from '../../../domain/factory/factory-plan';
import type { DataProfile, PeriodColumnProfile } from '../profile-data-sources';
import { describeScenarioGroundingViolations } from './plan-grounding';

function profile(id: string, periodColumns: readonly PeriodColumnProfile[]): DataProfile {
  return {
    dataSourceId: id, name: id, kind: 'file',
    columns: [{ name: 'amount', type: 'number', nullable: false }],
    sampleRowCount: 0, sampleRows: [], rowCount: 0,
    periodColumns, categoricalColumns: [], joinCandidates: [],
  };
}

/** ds-1 に「時点」列（2012-01-01〜2025-11-01）を持つプロファイル。eStat 実測（ADR-0047/0050）と同じ範囲。 */
const withPeriod: readonly DataProfile[] = [
  profile('ds-1', [{ column: '時点', granularities: { month: 167 }, minStart: '2012-01-01', maxStart: '2025-11-01', mixed: false }]),
];

function scenario(overrides: Partial<FactoryScenarioPlan> & { readonly key: string; readonly goal: string }): FactoryScenarioPlan {
  return { personaKey: 'p1', expectedToolKeys: ['lookup'], maxUserTurns: 3, ...overrides };
}

/** ds-1 を読む単一Toolの計画。シナリオだけ差し替えて使う。 */
function planWith(...scenarios: readonly FactoryScenarioPlan[]): FactoryPlan {
  return {
    agentBrief: { displayName: 'A', role: 'r' },
    tools: [{ key: 'lookup', displayName: 'Lookup', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
    skills: [],
    personas: [{ key: 'p1', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios,
  };
}

describe('describeScenarioGroundingViolations', () => {
  it('正常: 範囲内の年・年を含まない目標は違反にならない', () => {
    const inRangeYear = planWith(scenario({ key: 's1', goal: '2015年の総支給額を教えて' }));
    const noYear = planWith(scenario({ key: 's1', goal: '直近の総支給額を教えて' }));
    expect(describeScenarioGroundingViolations(inRangeYear, withPeriod)).toEqual([]);
    expect(describeScenarioGroundingViolations(noYear, withPeriod)).toEqual([]);
  });

  it('異常: 範囲外の年は違反文になる（index・key・年・範囲を含む）', () => {
    const plan = planWith(scenario({ key: 'wage-2030', goal: '2030年の総支給額を教えて' }));
    const violations = describeScenarioGroundingViolations(plan, withPeriod);
    expect(violations).toEqual(["scenarios.0 ('wage-2030') mentions 2030, but the data covers 2012–2025; use a period inside the data or do not name a year"]);
  });

  it('異常: goalだけでなくcontextの中の年も見る', () => {
    const plan = planWith(scenario({ key: 's1', goal: '総支給額を教えて', context: '2030年度の数字が知りたい' }));
    const violations = describeScenarioGroundingViolations(plan, withPeriod);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('mentions 2030');
  });

  it('境界: 下限-1年は許すが上限+1年は違反', () => {
    const lower = planWith(scenario({ key: 's1', goal: '2011年の総支給額を教えて' })); // minYear(2012) - 1
    const upper = planWith(scenario({ key: 's1', goal: '2026年の総支給額を教えて' })); // maxYear(2025) + 1
    expect(describeScenarioGroundingViolations(lower, withPeriod)).toEqual([]);
    expect(describeScenarioGroundingViolations(upper, withPeriod)).toHaveLength(1);
  });

  it('境界: 期間列の無いデータは検査しない', () => {
    const noPeriod = [profile('ds-1', [])];
    const plan = planWith(scenario({ key: 's1', goal: '2030年の総支給額を教えて' }));
    expect(describeScenarioGroundingViolations(plan, noPeriod)).toEqual([]);
  });

  it('境界: 複数ソースを参照するシナリオは範囲の和集合で判定する', () => {
    const wide: readonly DataProfile[] = [
      profile('ds-1', [{ column: '時点', granularities: { month: 1 }, minStart: '2012-01-01', maxStart: '2018-01-01', mixed: false }]),
      profile('ds-2', [{ column: '時点', granularities: { month: 1 }, minStart: '2019-01-01', maxStart: '2025-01-01', mixed: false }]),
    ];
    const joined: FactoryPlan = {
      agentBrief: { displayName: 'A', role: 'r' },
      tools: [{ key: 'joined', displayName: 'Joined', purpose: 'p', dataSourceId: 'ds-1', additionalDataSourceIds: ['ds-2'], sideEffect: 'read-only' }],
      skills: [],
      personas: [{ key: 'p1', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
      scenarios: [scenario({ key: 's1', goal: '2022年の推移を教えて', expectedToolKeys: ['joined'] })],
    };
    expect(describeScenarioGroundingViolations(joined, wide)).toEqual([]); // 2022 は和集合(2012-2025)の範囲内
    const outside: FactoryPlan = { ...joined, scenarios: [{ ...joined.scenarios[0]!, goal: '2030年の推移を教えて' }] };
    expect(describeScenarioGroundingViolations(outside, wide)).toHaveLength(1);
  });

  it('境界: 電話番号のような長い数字列に含まれる4桁は年とみなさない', () => {
    const plan = planWith(scenario({ key: 's1', goal: 'お問い合わせは 090-2030-1234 まで連絡してください' }));
    expect(describeScenarioGroundingViolations(plan, withPeriod)).toEqual([]);
  });

  it('境界: 再利用Toolしか指さないシナリオは全プロファイルへフォールバックする（§3.2 と同じ対象決定規則）', () => {
    const reuseOnly: FactoryPlan = {
      agentBrief: { displayName: 'A', role: 'r' },
      tools: [{ key: 'today', displayName: 'Now', purpose: 'p', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId: 'builtin-current-datetime' } }],
      skills: [],
      personas: [{ key: 'p1', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
      scenarios: [scenario({ key: 's1', goal: '2030年の総支給額を教えて', expectedToolKeys: ['today'] })],
    };
    expect(describeScenarioGroundingViolations(reuseOnly, withPeriod)).toHaveLength(1);
  });

  it('境界: 未知のtoolKeyしか指さないシナリオも全プロファイルへフォールバックする', () => {
    const unknownKey = planWith(scenario({ key: 's1', goal: '2030年の総支給額を教えて', expectedToolKeys: ['ghost'] }));
    expect(describeScenarioGroundingViolations(unknownKey, withPeriod)).toHaveLength(1);
  });
});
