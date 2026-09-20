import { describe, expect, it } from 'vitest';
import type { FactoryPlan, FactoryScenarioPlan, FactoryToolPlan } from '../../domain/factory/factory-plan';
import type { DataProfile } from './profile-data-sources';
import { composeScenarioContext, describeScenarioGrounding, groundingProfilesOf, SCENARIO_GROUNDING_HEADING } from './scenario-grounding';

/** プロファイルの雛形。テストごとに必要な要素（期間列・カテゴリ列・列型）だけを差し替える。 */
function profileOf(overrides: Partial<DataProfile> & Pick<DataProfile, 'dataSourceId' | 'name'>): DataProfile {
  return {
    kind: 'file', format: 'csv', columns: [], sampleRowCount: 0, sampleRows: [], rowCount: 0,
    periodColumns: [], categoricalColumns: [], joinCandidates: [],
    ...overrides,
  };
}

/** e-Stat の実データと同じ形（`時点, 地域コード, 地域, <値列>, 注記`）。ADR-0047 / ADR-0050 の実測の出どころ。 */
function estatProfile(dataSourceId: string, name: string, valueColumn: string): DataProfile {
  return profileOf({
    dataSourceId, name, rowCount: 168,
    columns: [
      { name: '時点', type: 'string', nullable: false },
      { name: '地域コード', type: 'string', nullable: false },
      { name: '地域', type: 'string', nullable: false },
      { name: valueColumn, type: 'number', nullable: true },
      { name: '注記', type: 'string', nullable: true },
    ],
    periodColumns: [{ column: '時点', granularities: { month: 167, year: 13, 'fiscal-year': 13 }, minStart: '2012-01-01', maxStart: '2025-11-01', mixed: true }],
    categoricalColumns: [
      { column: '地域コード', distinctCount: 1, values: ['00000'] },
      { column: '地域', distinctCount: 1, values: ['全国'] },
    ],
  });
}

const wageProfile = estatProfile('ds-wage', 'eStat 現金給与総額', '現金給与総額【円】');
const hoursProfile = estatProfile('ds-hours', 'eStat 総実労働時間', '総実労働時間【時間】');
const unrelatedProfile = estatProfile('ds-jobs', 'eStat 完全失業者数', '完全失業者数【万人】');

function toolOf(key: string, overrides?: Partial<FactoryToolPlan>): FactoryToolPlan {
  return { key, displayName: key, purpose: `${key} の値を引く。`, dataSourceId: `ds-${key}`, sideEffect: 'read-only', ...overrides };
}

function planOf(tools: readonly FactoryToolPlan[], scenario: Partial<FactoryScenarioPlan>): FactoryPlan {
  return {
    agentBrief: { displayName: '賃金アシスタント', role: '賃金の統計に答える。' },
    tools,
    skills: [],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'hourly-wage', goal: '特定の月の時間当たり給与を調べる', personaKey: 'accountant', expectedToolKeys: [], maxUserTurns: 3, ...scenario }],
  };
}

/** 2ソース（賃金・労働時間）を1つのシナリオが使う、実測に一番近い形。 */
function twoSourceInput(language: 'ja' | 'en'): Parameters<typeof describeScenarioGrounding>[0] {
  const plan = planOf([toolOf('wage'), toolOf('hours')], { expectedToolKeys: ['wage', 'hours'] });
  return { plan, scenario: plan.scenarios[0]!, profiles: [wageProfile, hoursProfile], language };
}

describe('describeScenarioGrounding（前提ブロックの文面）', () => {
  it('正常: 2ソースのシナリオは、名前・行数・値の列・期間の範囲と粒度・カテゴリの例が1ソース1行で日本語で出る', () => {
    expect(describeScenarioGrounding(twoSourceInput('ja'))).toBe([
      '# Validation premises / 検証の前提 (factory-managed)',
      '- あなたは自分のデータを持っていない。アシスタントが持つ下記のデータについて質問する。金額・件数などの数値を自分で作って渡したり、その数値での計算を頼んだりしない。',
      '- アシスタントが持つデータ:',
      '  - eStat 現金給与総額（168 行）: 値の列 = 現金給与総額【円】 / 期間の列「時点」= 2012-01-01 〜 2025-11-01（month 167・year 13・fiscal-year 13） / 地域 = 全国',
      '  - eStat 総実労働時間（168 行）: 値の列 = 総実労働時間【時間】 / 期間の列「時点」= 2012-01-01 〜 2025-11-01（month 167・year 13・fiscal-year 13） / 地域 = 全国',
      '- 質問は上の期間とカテゴリの範囲内にする。データに無い指標（別の業種・別の統計・個別の会社や従業員）は尋ねない。目標が範囲外の質問を明示的に求めている場合だけ例外とする。',
      '- アシスタントがデータの値を時点と単位つきで答えたら、その数値は正しいものとして扱う。自分で作った試算と比べて誤りだと主張しない。',
      '- 目標に書かれた内容に、アシスタントがデータの値で答えたら、その時点で目標は達成である（goalAchieved と endConversation を true にする）。目標に無い追加の分析（要因の考察・示唆・別の比較・追加の計算）を求めて会話を延ばさない。',
    ].join('\n'));
  });

  it('正常: 英語のRunでは同じ構造の英文になる（見出しだけは日英併記のまま変えない）', () => {
    expect(describeScenarioGrounding(twoSourceInput('en'))).toBe([
      '# Validation premises / 検証の前提 (factory-managed)',
      '- You have no data of your own. Ask about the data the assistant holds, listed below. Never make up figures (amounts, counts) and hand them over, and never ask for a calculation on figures you supplied.',
      '- Data the assistant holds:',
      '  - eStat 現金給与総額 (168 rows): value columns = 現金給与総額【円】 / period column "時点" = 2012-01-01 to 2025-11-01 (month 167, year 13, fiscal-year 13) / 地域 = 全国',
      '  - eStat 総実労働時間 (168 rows): value columns = 総実労働時間【時間】 / period column "時点" = 2012-01-01 to 2025-11-01 (month 167, year 13, fiscal-year 13) / 地域 = 全国',
      '- Keep your questions inside the periods and categories above. Do not ask for indicators that are not in the data (another industry, another statistic, an individual company or employee). The only exception is when your goal explicitly asks for something outside that range.',
      '- When the assistant answers with a value from the data, with its period and unit, treat that number as correct. Do not claim it is wrong by comparing it with an estimate of your own.',
      '- Once the assistant answers what the goal asks for with a value from the data, the goal is achieved at that point (set goalAchieved and endConversation to true). Do not extend the conversation by asking for analysis the goal does not call for (root-cause discussion, implications, another comparison, additional calculations).',
    ].join('\n'));
  });

  it('正常: 対象は expectedToolKeys が指すToolのデータソースだけで、無関係なソースは載らない', () => {
    const plan = planOf([toolOf('wage'), toolOf('jobs')], { expectedToolKeys: ['wage'] });
    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [wageProfile, unrelatedProfile], language: 'ja' });

    expect(block).toContain('eStat 現金給与総額');
    expect(block).not.toContain('eStat 完全失業者数');
  });

  it('正常: 結合する追加データソース（additionalDataSourceIds）も対象に入る', () => {
    const plan = planOf([toolOf('wage', { additionalDataSourceIds: ['ds-hours'] })], { expectedToolKeys: ['wage'] });

    expect(groundingProfilesOf({ plan, scenario: plan.scenarios[0]!, profiles: [wageProfile, hoursProfile, unrelatedProfile] }))
      .toEqual([wageProfile, hoursProfile]);
  });

  it('異常: 再利用Toolしか指さないシナリオは、Runの全プロファイルへフォールバックする', () => {
    const plan = planOf([toolOf('today', { dataSourceId: '', reuse: { internalId: 'builtin-current-datetime' } })], { expectedToolKeys: ['today'] });
    const profiles = [wageProfile, hoursProfile];

    expect(groundingProfilesOf({ plan, scenario: plan.scenarios[0]!, profiles })).toEqual(profiles);
  });

  it('異常: 未知のtoolKey・プロファイルに無いdataSourceId しか指さないシナリオも全プロファイルへフォールバックする', () => {
    const plan = planOf([toolOf('wage', { dataSourceId: 'ds-missing' })], { expectedToolKeys: ['wage', 'unknown-key'] });
    const profiles = [wageProfile, hoursProfile];

    expect(groundingProfilesOf({ plan, scenario: plan.scenarios[0]!, profiles })).toEqual(profiles);
  });

  it('異常: プロファイルが1件も無いRun（データソースなしの強化モード）では前提ブロックを付けない', () => {
    const plan = planOf([], { expectedToolKeys: [] });

    expect(describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [], language: 'ja' })).toBeUndefined();
  });

  it('境界: 値の列は先頭6つまでで、超えた分は「ほか N 列」にまとめる', () => {
    const plan = planOf([toolOf('wide')], { expectedToolKeys: ['wide'] });
    const profile = profileOf({
      dataSourceId: 'ds-wide', name: '横長', rowCount: 3,
      columns: Array.from({ length: 7 }, (_, index) => ({ name: `値${index + 1}`, type: 'number', nullable: true })),
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    expect(block).toContain('値の列 = 値1、値2、値3、値4、値5、値6、ほか 1 列');
    expect(block).not.toContain('値7');
  });

  it('境界: カテゴリの値は先頭8つまでで、超えた分は「ほか N 種類」にまとめる', () => {
    const plan = planOf([toolOf('regions')], { expectedToolKeys: ['regions'] });
    const values = Array.from({ length: 9 }, (_, index) => `地域${index + 1}`);
    const profile = profileOf({
      dataSourceId: 'ds-regions', name: '地域別', rowCount: 9,
      columns: [{ name: '地域', type: 'string', nullable: false }, { name: '人数', type: 'number', nullable: true }],
      categoricalColumns: [{ column: '地域', distinctCount: values.length, values }],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    expect(block).toContain('地域 = 地域1、地域2、地域3、地域4、地域5、地域6、地域7、地域8、ほか 1 種類');
    expect(block).not.toContain('地域9');
  });

  it('境界: データソースは先頭3件までで、超えた分は「ほか N 件のデータ」にまとめる', () => {
    const tools = ['a', 'b', 'c', 'd'].map((key) => toolOf(key));
    const plan = planOf(tools, { expectedToolKeys: ['a', 'b', 'c', 'd'] });
    const profiles = ['a', 'b', 'c', 'd'].map((key) => profileOf({ dataSourceId: `ds-${key}`, name: `表${key}`, rowCount: 1 }));

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles, language: 'ja' });

    expect(block).toContain('  - 表c（1 行）');
    expect(block).not.toContain('表d（1 行）');
    expect(block).toContain('  - ほか 1 件のデータ');
  });

  it('境界: コードらしいカテゴリ列は飛ばし、期間列・カテゴリ列が無い表はその要素ごと省く', () => {
    const plan = planOf([toolOf('codes')], { expectedToolKeys: ['codes'] });
    const withCodes = profileOf({
      dataSourceId: 'ds-codes', name: 'コード表', rowCount: 5,
      columns: [{ name: '地域コード', type: 'string', nullable: false }, { name: '金額', type: 'number', nullable: true }],
      categoricalColumns: [{ column: '地域コード', distinctCount: 2, values: ['00000', '01000'] }],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [withCodes], language: 'ja' });

    expect(block).toContain('  - コード表（5 行）: 値の列 = 金額\n');
    expect(block).not.toContain('地域コード');
    expect(block).not.toContain('期間の列');
  });

  it('境界: 数値の列が1つも無い表も行は残し、「（数値の列なし）」と書く', () => {
    const plan = planOf([toolOf('text')], { expectedToolKeys: ['text'] });
    const profile = profileOf({
      dataSourceId: 'ds-text', name: '注記だけの表', rowCount: 2,
      columns: [{ name: '注記', type: 'string', nullable: true }],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    expect(block).toContain('  - 注記だけの表（2 行）: 値の列 = （数値の列なし）');
  });

  it('境界: 1,800文字を超えたら、カテゴリの値の例の上限を半分にして作り直す', () => {
    // カテゴリの値はちょうど30文字（§5b.3の上限に収まる長さ）にし、データソース3件（上限いっぱい）で
    // 総量を1,800文字超まで積む。1データソースだけでは「先頭8件」止まりで積み上がらない。
    const makeValues = (prefix: string) => Array.from({ length: 20 }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`.padEnd(30, 'あ').slice(0, 30));
    const tools = ['x', 'y', 'z'].map((key) => toolOf(key));
    const plan = planOf(tools, { expectedToolKeys: ['x', 'y', 'z'] });
    const profiles = ['x', 'y', 'z'].map((key) => profileOf({
      dataSourceId: `ds-${key}`, name: `長い表${key}`, rowCount: 100,
      columns: [{ name: '区分1', type: 'string', nullable: false }, { name: '区分2', type: 'string', nullable: false }, { name: '金額', type: 'number', nullable: true }],
      categoricalColumns: [
        { column: '区分1', distinctCount: 20, values: makeValues(`区1${key}`) },
        { column: '区分2', distinctCount: 20, values: makeValues(`区2${key}`) },
      ],
    }));

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles, language: 'ja' });

    if (block === undefined) throw new Error('expected a grounding block');
    expect(block.length).toBeLessThanOrEqual(1800);
    // 8件では収まらず、半分の4件で収まる（残りは件数だけ伝える）。
    expect(block).toContain('ほか 16 種類');
    expect(block).not.toContain('区1x05');
  });

  it('境界: 最小の上限でも1,800文字を超えるデータは、文を壊さないようそのまま返す', () => {
    // 値の列の「名前」自体が極端に長いケース（カテゴリの値の例と違い§5b.3の30文字上限の対象外）。
    // 列数の上限を6→3へ絞っても、1列の名前だけで1,800文字を超える。
    const plan = planOf([toolOf('huge')], { expectedToolKeys: ['huge'] });
    const profile = profileOf({
      dataSourceId: 'ds-huge', name: '極端な表', rowCount: 1,
      columns: [{ name: `金額${'あ'.repeat(2000)}`, type: 'number', nullable: true }],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    if (block === undefined) throw new Error('expected a grounding block');
    expect(block.length).toBeGreaterThan(1800);
    expect(block.endsWith('を求めて会話を延ばさない。')).toBe(true);
  });

  it('境界: カテゴリの値の最大長が31文字の列は例から飛ばし、ちょうど30文字の列は載る', () => {
    const plan = planOf([toolOf('notes')], { expectedToolKeys: ['notes'] });
    const shortValue = 'あ'.repeat(30);
    const longValue = 'い'.repeat(31);
    const profile = profileOf({
      dataSourceId: 'ds-notes', name: '注記あり', rowCount: 2,
      columns: [{ name: '短い区分', type: 'string', nullable: false }, { name: '長い区分', type: 'string', nullable: false }, { name: '金額', type: 'number', nullable: true }],
      categoricalColumns: [
        { column: '短い区分', distinctCount: 1, values: [shortValue] },
        { column: '長い区分', distinctCount: 1, values: [longValue] },
      ],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    expect(block).toContain(`短い区分 = ${shortValue}`);
    expect(block).not.toContain('長い区分');
  });

  it('境界: 長文の列（値の最大長31文字超）を飛ばすと、その次の短い列が繰り上がって載る', () => {
    const plan = planOf([toolOf('promote')], { expectedToolKeys: ['promote'] });
    const longValue = 'う'.repeat(31);
    const profile = profileOf({
      dataSourceId: 'ds-promote', name: '繰り上がり', rowCount: 3,
      columns: [
        { name: '注記', type: 'string', nullable: true },
        { name: '区分A', type: 'string', nullable: false },
        { name: '区分B', type: 'string', nullable: false },
        { name: '金額', type: 'number', nullable: true },
      ],
      categoricalColumns: [
        { column: '注記', distinctCount: 1, values: [longValue] },
        { column: '区分A', distinctCount: 1, values: ['A'] },
        { column: '区分B', distinctCount: 1, values: ['B'] },
      ],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    // カテゴリ列は先頭2列までだが、「注記」が飛ばされるので「区分B」まで繰り上がって両方載る。
    expect(block).toContain('区分A = A');
    expect(block).toContain('区分B = B');
    expect(block).not.toContain('注記');
  });

  it('境界: 改行を含む列名・値は1行に畳み、見出しを名乗る値からは # を外す', () => {
    const plan = planOf([toolOf('dirty')], { expectedToolKeys: ['dirty'] });
    const profile = profileOf({
      dataSourceId: 'ds-dirty', name: '汚れた\n表', rowCount: 1,
      columns: [{ name: '金額\n（円）', type: 'number', nullable: true }, { name: '区分', type: 'string', nullable: false }],
      // 値は30文字以内（§5b.3の上限に収まる長さ）にしつつ、改行の畳みと # 除去の両方を試す。
      categoricalColumns: [{ column: '区分', distinctCount: 1, values: ['#Validation premises\n注記'] }],
    });

    const block = describeScenarioGrounding({ plan, scenario: plan.scenarios[0]!, profiles: [profile], language: 'ja' });

    if (block === undefined) throw new Error('expected a grounding block');
    // 見出し行は先頭の1回だけ（値が2つ目の見出しを名乗れない）。
    expect(block.split('\n').filter((line) => line === SCENARIO_GROUNDING_HEADING)).toHaveLength(1);
    expect(block).toContain('  - 汚れた 表（1 行）: 値の列 = 金額 （円） / 区分 = Validation premises 注記');
  });
});

describe('composeScenarioContext（計画の context と前提ブロックの連結）', () => {
  const grounding = '# Validation premises / 検証の前提 (factory-managed)\n- 前提';

  it('正常: 計画の context を先、前提ブロックを後に、空行で区切って連結する', () => {
    expect(composeScenarioContext('月次の締め作業の途中で質問する。', grounding)).toBe('月次の締め作業の途中で質問する。\n\n# Validation premises / 検証の前提 (factory-managed)\n- 前提');
  });

  it('正常: 既に見出しを含む context には二重に付けない（再開・再試行で同じ計画を通しても冪等）', () => {
    const already = composeScenarioContext('月次の締め作業の途中で質問する。', grounding);

    expect(composeScenarioContext(already, grounding)).toBe(already);
  });

  it('境界: 計画の context が無い / 空白だけなら前提ブロックだけを返し、前提が無ければ計画の context をそのまま返す', () => {
    expect(composeScenarioContext(undefined, grounding)).toBe(grounding);
    expect(composeScenarioContext('   ', grounding)).toBe(grounding);
    expect(composeScenarioContext('月次の締め作業の途中で質問する。', undefined)).toBe('月次の締め作業の途中で質問する。');
  });

  it('異常: 計画の context も前提ブロックも無ければ undefined（context 項目そのものを付けない）', () => {
    expect(composeScenarioContext(undefined, undefined)).toBeUndefined();
  });
});
