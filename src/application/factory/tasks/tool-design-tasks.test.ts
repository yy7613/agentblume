import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import type { FactoryToolPlan } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../../domain/factory/factory-run';
import { MAX_TOOL_CALLS } from '../../agent/run-agent-preview';
import type { DataProfile } from '../profile-data-sources';
import { supportsMultiValueFilterOps } from '../roles/tool-smith-role';
import { runRoleTask } from './role-task';
import {
  MAX_TOOL_SPEC_CATEGORY_FILTERS,
  MAX_TOOL_SPEC_COMPUTATIONS,
  MAX_TOOL_SPEC_JOIN_KEYS,
  MAX_TOOL_SPEC_LIMIT,
  MIN_TOOL_SPEC_LIMIT,
  RESERVED_TOOL_SPEC_ARGUMENTS,
  TOOL_SPEC_ARGUMENT_PATTERN,
} from '../../../domain/factory/tool-spec';
import {
  CATEGORY_VALUE_SAMPLE,
  categoricalColumnsOf,
  decideComputationsTask,
  decideFiltersTask,
  decideJoinTask,
  decideOutputTask,
  joinKeyChoices,
  periodColumnsOf,
  type DecideFiltersInput,
  type DecideJoinInput,
  type DecideOutputInput,
} from './tool-design-tasks';

// ---------------------------------------------------------------------------
// 材料（e-Stat 風の2ソース。無関係な3本目 ds-3 は「関係ない候補を混ぜない」検査に使う）
// ---------------------------------------------------------------------------

const REGIONS = ['全国', '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県'];

const wageProfile: DataProfile = {
  dataSourceId: 'ds-1',
  name: '現金給与総額',
  kind: 'file',
  format: 'csv',
  columns: [
    { name: '時点', type: 'string', nullable: false },
    { name: '地域コード', type: 'string', nullable: false },
    { name: '地域', type: 'string', nullable: false },
    { name: '現金給与総額', type: 'number', nullable: true },
    { name: '注記', type: 'string', nullable: true },
  ],
  sampleRowCount: 1,
  sampleRows: [{ 時点: '2024年1月', 地域コード: '00000', 地域: '全国', 現金給与総額: 300000, 注記: 'サンプル行の目印' }],
  rowCount: 5400,
  periodColumns: [{ column: '時点', granularities: { month: 4800, year: 600 }, minStart: '2015-01-01', maxStart: '2024-12-01', mixed: true }],
  categoricalColumns: [
    { column: '地域', distinctCount: 48, values: REGIONS },
    { column: '産業', distinctCount: 3, values: ['製造業', '建設業', '卸売業'] },
  ],
  joinCandidates: [
    { leftDataSourceId: 'ds-1', rightDataSourceId: 'ds-2', keys: ['時点', '地域コード', '地域'], overlap: { 時点: 1, 地域コード: 1, 地域: 1 }, uniqueLeft: true, uniqueRight: false },
    { leftDataSourceId: 'ds-1', rightDataSourceId: 'ds-3', keys: ['無関係キー'], overlap: { 無関係キー: 0.8 }, uniqueLeft: true, uniqueRight: true },
  ],
};

const hoursProfile: DataProfile = {
  dataSourceId: 'ds-2',
  name: '総実労働時間',
  kind: 'file',
  format: 'csv',
  columns: [
    { name: '時点', type: 'string', nullable: false },
    { name: '地域コード', type: 'string', nullable: false },
    { name: '地域', type: 'string', nullable: false },
    { name: '総実労働時間', type: 'number', nullable: true },
  ],
  sampleRowCount: 1,
  sampleRows: [{ 時点: '2024年1月', 地域コード: '00000', 地域: '全国', 総実労働時間: 140 }],
  rowCount: 5400,
  periodColumns: [{ column: '時点', granularities: { month: 4800, year: 600 }, minStart: '2015-01-01', maxStart: '2024-12-01', mixed: true }],
  categoricalColumns: [{ column: '地域', distinctCount: 48, values: REGIONS }],
  joinCandidates: wageProfile.joinCandidates,
};

const plan: FactoryToolPlan = {
  key: 'wage_hours',
  displayName: '賃金と労働時間',
  purpose: '同じ時点・同じ地域の賃金と労働時間を並べて返す。',
  dataSourceId: 'ds-1',
  sideEffect: 'read-only',
  argumentSummary: '期間の範囲と粒度、対象の絞り込み。',
  additionalDataSourceIds: ['ds-2'],
};

const goal: FactoryGoalInput = { goal: '月次と年次の推移を説明できるようにしたい。', language: 'ja' };

const profiles = [wageProfile, hoursProfile];
const joinInput: DecideJoinInput = { plan, profiles };
const filtersInput: DecideFiltersInput = { plan, goal, profiles };
const computationsInput = { plan, goal, profiles };
const outputInput: DecideOutputInput = {
  plan,
  availableColumns: ['時点', '地域', '現金給与総額', '総実労働時間', '時間あたり賃金'],
  estimatedRows: 5400,
};

/** タスクを実際にランナーへ通して、モデルが受け取るuser messageの中身を見る。 */
async function userMessageOf<I, O>(task: Parameters<typeof runRoleTask<I, O>>[1], input: I, content: string): Promise<string> {
  const model = new ScriptedModelProvider();
  model.enqueue({ message: { role: 'assistant', content }, finishReason: 'stop' });
  await runRoleTask(model, task, input);
  return String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
}

// ---------------------------------------------------------------------------
// decide-join
// ---------------------------------------------------------------------------

describe('decideJoinTask', () => {
  it('正常: keysのenumはこのツールに関係する候補のキーそのもの', () => {
    const schema = decideJoinTask.schema(joinInput);

    expect(schema.properties['keys']?.items?.enum).toEqual(['時点', '地域コード', '地域']);
    expect(schema.properties['mode']?.enum).toEqual(['inner', 'left']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['keys', 'mode']);
    expect(joinKeyChoices(joinInput)).toEqual(['時点', '地域コード', '地域']);
  });

  it('正常: 候補のキーとmodeを受け取る', () => {
    const parsed = decideJoinTask.parse(JSON.stringify({ keys: ['時点', '地域コード'], mode: 'inner' }), joinInput);

    expect(parsed).toEqual({ ok: true, value: { keys: ['時点', '地域コード'], mode: 'inner' } });
  });

  it('正常: 材料は最小（サンプル行も列定義も、無関係なソースの候補も渡さない）', async () => {
    const user = await userMessageOf(decideJoinTask, joinInput, JSON.stringify({ keys: ['時点'], mode: 'inner' }));

    expect(user).toContain('同じ時点・同じ地域の賃金と労働時間を並べて返す。');
    expect(user).toContain('ds-2');
    expect(user).not.toContain('sampleRows');
    expect(user).not.toContain('サンプル行の目印');
    // ds-3 はこのツールが束ねないソースなので、その結合候補は載せない。
    expect(user).not.toContain('無関係キー');
    expect(user).not.toContain('ds-3');
  });

  it('異常: 候補に無いキーとmodeは、選べる値を挙げて差し戻す', () => {
    const parsed = decideJoinTask.parse(JSON.stringify({ keys: ['注記'], mode: 'full' }), joinInput);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false ? parsed.issues : []).toEqual([
      'keys[0] must be one of the shared key columns: 時点, 地域コード, 地域. Received "注記".',
      'mode must be one of: inner, left. Received "full".',
    ]);
  });

  it('境界: keysは1件以上・重複なし・最大4件', () => {
    const empty = decideJoinTask.parse(JSON.stringify({ keys: [], mode: 'inner' }), joinInput);
    expect(empty.ok === false ? parsedIssue(empty.issues, 0) : '').toBe('keys must contain at least one column. Choose from: 時点, 地域コード, 地域.');

    const duplicated = decideJoinTask.parse(JSON.stringify({ keys: ['時点', '時点'], mode: 'inner' }), joinInput);
    expect(duplicated.ok === false ? parsedIssue(duplicated.issues, 0) : '').toBe('keys[1] "時点" is listed twice. List every join key exactly once.');

    const tooMany = decideJoinTask.parse(JSON.stringify({ keys: ['時点', '地域コード', '地域', '時点', '地域'], mode: 'inner' }), joinInput);
    expect(tooMany.ok === false ? parsedIssue(tooMany.issues, 0) : '').toBe(`keys must contain at most ${MAX_TOOL_SPEC_JOIN_KEYS} columns. Received 5.`);
  });

  it('例外: JSONでない応答・オブジェクトでない応答は違反として返す（例外を投げない）', () => {
    expect(decideJoinTask.parse('not json', joinInput)).toEqual({ ok: false, issues: ['The response was not valid JSON. Return only a JSON object matching the schema.'] });
    expect(decideJoinTask.parse('[]', joinInput)).toEqual({ ok: false, issues: ['The response must be a JSON object.'] });
    expect(decideJoinTask.parse(null, joinInput)).toEqual({ ok: false, issues: ['The response was empty. Return a JSON object matching the schema.'] });
  });
});

/** 違反文言の index 番目（無ければ空文字）。 */
function parsedIssue(issues: readonly string[], index: number): string {
  return issues[index] ?? '';
}

// ---------------------------------------------------------------------------
// decide-filters
// ---------------------------------------------------------------------------

describe('decideFiltersTask', () => {
  it('正常: enumは期間列名・データにある粒度 + argument・カテゴリ列名そのもの', () => {
    const schema = decideFiltersTask.schema(filtersInput);
    const period = schema.properties['period'];

    expect(period?.type).toEqual(['object', 'null']);
    expect(period?.properties?.['column']?.enum).toEqual(['時点']);
    expect(period?.properties?.['granularity']?.enum).toEqual(['month', 'year', 'argument']);
    expect(period?.properties?.['defaultGranularity']?.enum).toEqual(['month', 'year', null]);
    expect(period?.required).toEqual(['column', 'granularity', 'defaultGranularity', 'range']);
    expect(schema.properties['categoryFilters']?.items?.properties?.['column']?.enum).toEqual(['地域', '産業']);
    expect(periodColumnsOf(filtersInput).map((entry) => entry.column)).toEqual(['時点']);
    expect(categoricalColumnsOf(filtersInput).map((entry) => entry.column)).toEqual(['地域', '産業']);
  });

  it('正常: 粒度argument + 既定粒度 + 範囲 + カテゴリ引数を受け取る', () => {
    const parsed = decideFiltersTask.parse(JSON.stringify({
      period: { column: '時点', granularity: 'argument', defaultGranularity: 'month', range: true },
      categoryFilters: [{ column: '地域', argument: 'regions', multi: true }],
    }), filtersInput);

    expect(parsed).toEqual({
      ok: true,
      value: {
        period: { column: '時点', granularity: 'argument', defaultGranularity: 'month', range: true },
        categoryFilters: [{ column: '地域', argument: 'regions', multi: true }],
      },
    });
  });

  it('正常: 固定粒度ならdefaultGranularityはnull、periodもcategoryFiltersも空で通る', () => {
    const fixed = decideFiltersTask.parse(JSON.stringify({
      period: { column: '時点', granularity: 'year', defaultGranularity: null, range: false },
      categoryFilters: [],
    }), filtersInput);
    expect(fixed).toEqual({ ok: true, value: { period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] } });

    const none = decideFiltersTask.parse(JSON.stringify({ period: null, categoryFilters: [] }), filtersInput);
    expect(none).toEqual({ ok: true, value: { categoryFilters: [] } });
  });

  it('正常: 材料は最小（サンプル行・列定義・行数は渡さず、カテゴリ値は先頭8件だけ）', async () => {
    const user = await userMessageOf(decideFiltersTask, filtersInput, JSON.stringify({ period: null, categoryFilters: [] }));

    expect(user).toContain('"mixed":true');
    expect(user).toContain('"minStart":"2015-01-01"');
    expect(user).toContain(`"maxToolCalls":${MAX_TOOL_CALLS}`);
    expect(user).toContain('月次と年次の推移を説明できるようにしたい。');
    expect(user).not.toContain('sampleRows');
    expect(user).not.toContain('サンプル行の目印');
    // 値は先頭8件まで。9件目以降（茨城県・栃木県）は載せない。
    expect(REGIONS.slice(0, CATEGORY_VALUE_SAMPLE).every((value) => user.includes(value))).toBe(true);
    expect(user).not.toContain('茨城県');
    expect(user).not.toContain('栃木県');
    // 絞り込みに関係しない列（値列・注記列）は材料に入れない。
    expect(user).not.toContain('注記');
    expect(user).not.toContain('総実労働時間');
  });

  it('異常: 期間の指定が候補外なら、選べる値を挙げて差し戻す', () => {
    const parsed = decideFiltersTask.parse(JSON.stringify({
      period: { column: '年度', granularity: 'day', defaultGranularity: null, range: true },
      categoryFilters: [],
    }), filtersInput);

    expect(parsed.ok === false ? parsed.issues : []).toEqual([
      'period.column must be one of: 時点. Received "年度".',
      'period.granularity must be one of: month, year, argument. Received "day".',
    ]);
  });

  it('境界: granularityが argument のときだけ defaultGranularity が必要で、データにある粒度に限る', () => {
    const missing = decideFiltersTask.parse(JSON.stringify({
      period: { column: '時点', granularity: 'argument', defaultGranularity: null, range: true },
      categoryFilters: [],
    }), filtersInput);
    expect(missing.ok === false ? parsedIssue(missing.issues, 0) : '').toBe("period.defaultGranularity is required when period.granularity is 'argument'. Pick the granularity to fall back on, one of: month, year.");

    const absent = decideFiltersTask.parse(JSON.stringify({
      period: { column: '時点', granularity: 'argument', defaultGranularity: 'day', range: true },
      categoryFilters: [],
    }), filtersInput);
    expect(absent.ok === false ? parsedIssue(absent.issues, 0) : '').toBe('period.defaultGranularity must be a granularity present in the data: one of month, year. Received "day".');

    const superfluous = decideFiltersTask.parse(JSON.stringify({
      period: { column: '時点', granularity: 'month', defaultGranularity: 'year', range: true },
      categoryFilters: [],
    }), filtersInput);
    expect(superfluous.ok === false ? parsedIssue(superfluous.issues, 0) : '').toBe("period.defaultGranularity must be null unless period.granularity is 'argument'.");
  });

  it('異常: 引数名は snake_case・予約名不可・重複不可', () => {
    const shape = decideFiltersTask.parse(JSON.stringify({
      period: null,
      categoryFilters: [{ column: '地域', argument: 'Region', multi: false }],
    }), filtersInput);
    expect(shape.ok === false ? parsedIssue(shape.issues, 0) : '').toBe(`categoryFilters[0].argument "Region" must be snake_case matching ${TOOL_SPEC_ARGUMENT_PATTERN.source}: a lowercase letter, then lowercase letters, digits or underscores, at most 40 characters.`);

    const reserved = decideFiltersTask.parse(JSON.stringify({
      period: null,
      categoryFilters: [{ column: '地域', argument: 'granularity', multi: false }],
    }), filtersInput);
    expect(reserved.ok === false ? parsedIssue(reserved.issues, 0) : '').toBe(`categoryFilters[0].argument "granularity" is a reserved argument name. The tool declares ${RESERVED_TOOL_SPEC_ARGUMENTS.join(', ')} itself; pick another name.`);

    const duplicated = decideFiltersTask.parse(JSON.stringify({
      period: null,
      categoryFilters: [{ column: '地域', argument: 'target', multi: false }, { column: '産業', argument: 'target', multi: false }],
    }), filtersInput);
    expect(duplicated.ok === false ? parsedIssue(duplicated.issues, 0) : '').toBe('categoryFilters[1].argument "target" is already used by another filter. Every argument name must be unique.');

    const sameColumn = decideFiltersTask.parse(JSON.stringify({
      period: null,
      categoryFilters: [{ column: '地域', argument: 'a', multi: false }, { column: '地域', argument: 'b', multi: false }],
    }), filtersInput);
    expect(sameColumn.ok === false ? parsedIssue(sameColumn.issues, 0) : '').toBe('categoryFilters[1].column "地域" is already filtered by another entry. Filter each column at most once.');
  });

  it('異常: 追加ソースにしか無いカテゴリ列は選べない（validateToolSpecは主ソースの列しか受け付けない）', () => {
    const withExtra: DataProfile = { ...hoursProfile, categoricalColumns: [...hoursProfile.categoricalColumns, { column: '事業所規模', distinctCount: 2, values: ['5人以上', '30人以上'] }] };
    const input: DecideFiltersInput = { plan, goal, profiles: [wageProfile, withExtra] };

    expect(decideFiltersTask.schema(input).properties['categoryFilters']?.items?.properties?.['column']?.enum).toEqual(['地域', '産業']);
    const parsed = decideFiltersTask.parse(JSON.stringify({ period: null, categoryFilters: [{ column: '事業所規模', argument: 'size', multi: true }] }), input);
    expect(parsed.ok === false ? parsedIssue(parsed.issues, 0) : '').toBe('categoryFilters[0].column must be one of: 地域, 産業. Received "事業所規模".');
  });

  it('境界: カテゴリ絞り込みは最大3件', () => {
    const entries = ['a', 'b', 'c', 'd'].map((argument) => ({ column: '地域', argument, multi: false }));
    const parsed = decideFiltersTask.parse(JSON.stringify({ period: null, categoryFilters: entries }), filtersInput);

    expect(parsed.ok === false ? parsed.issues : []).toEqual([`categoryFilters must contain at most ${MAX_TOOL_SPEC_CATEGORY_FILTERS} entries. Received 4.`]);
  });

  it('境界: 期間列もカテゴリ列も無いデータでは、periodはnull型・カテゴリは空しか受け付けない', () => {
    const bare: DataProfile = { ...wageProfile, periodColumns: [], categoricalColumns: [] };
    const input: DecideFiltersInput = { plan, goal, profiles: [bare] };

    expect(decideFiltersTask.schema(input).properties['period']?.type).toBe('null');
    expect(decideFiltersTask.parse(JSON.stringify({ period: null, categoryFilters: [] }), input)).toEqual({ ok: true, value: { categoryFilters: [] } });

    const withPeriod = decideFiltersTask.parse(JSON.stringify({ period: { column: '時点', granularity: 'month', defaultGranularity: null, range: false }, categoryFilters: [] }), input);
    expect(withPeriod.ok === false ? parsedIssue(withPeriod.issues, 0) : '').toBe('period must be null: this tool has no period column to parse.');

    const withCategory = decideFiltersTask.parse(JSON.stringify({ period: null, categoryFilters: [{ column: '地域', argument: 'region', multi: false }] }), input);
    expect(withCategory.ok === false ? parsedIssue(withCategory.issues, 0) : '').toBe('categoryFilters[0].column cannot be set: this tool has no categorical column, so categoryFilters must be empty.');
  });

  it('正常: 規則は粒度の固定・範囲・引数名・上限3件を言う', () => {
    const rules = decideFiltersTask.rules.join('\n');

    expect(decideFiltersTask.rules.length).toBeGreaterThanOrEqual(5);
    expect(decideFiltersTask.rules.length).toBeLessThanOrEqual(8);
    expect(rules).toContain('"mixed": true');
    expect(rules).toContain("'argument'");
    expect(rules).toContain('range to true');
    expect(rules).toContain(`at most ${MAX_TOOL_SPEC_CATEGORY_FILTERS} category filters`);
    expect(rules).toContain(TOOL_SPEC_ARGUMENT_PATTERN.source);
    expect(rules).toContain(String(MAX_TOOL_CALLS));
    // multi の指示は engine の演算子語彙から導く（`validateToolSpec` は 'in' を持つビルドで multi:false を弾く）。
    expect(rules).toContain(supportsMultiValueFilterOps() ? 'always set multi to true' : 'multi must be false');
  });
});

// ---------------------------------------------------------------------------
// decide-computations
// ---------------------------------------------------------------------------

describe('decideComputationsTask', () => {
  it('正常: 計算列0件は正しい答えとして受け取る', () => {
    expect(decideComputationsTask.parse(JSON.stringify({ computations: [] }), computationsInput)).toEqual({ ok: true, value: { computations: [] } });
  });

  it('正常: 新しい列名と意図の文を受け取る（式は受け取らない）', () => {
    const parsed = decideComputationsTask.parse(JSON.stringify({
      computations: [{ outputColumn: '時間あたり賃金', intent: '現金給与総額を総実労働時間で割った1時間あたりの賃金。' }],
    }), computationsInput);

    expect(parsed).toEqual({ ok: true, value: { computations: [{ outputColumn: '時間あたり賃金', intent: '現金給与総額を総実労働時間で割った1時間あたりの賃金。' }] } });
    expect(decideComputationsTask.schema(computationsInput).properties['computations']?.items?.required).toEqual(['outputColumn', 'intent']);
  });

  it('正常: 材料は数値列名と目的・目標だけ（サンプル行も非数値列も渡さない）', async () => {
    const user = await userMessageOf(decideComputationsTask, computationsInput, JSON.stringify({ computations: [] }));

    expect(user).toContain('"numericColumns":["現金給与総額","総実労働時間"]');
    expect(user).not.toContain('sampleRows');
    expect(user).not.toContain('サンプル行の目印');
    expect(user).not.toContain('地域コード');
    expect(user).not.toContain('注記');
    expect(user).not.toContain('categoricalColumns');
    expect(user).not.toContain('periodColumns');
  });

  it('異常: 既存列と衝突する列名・重複した列名・空の意図は差し戻す', () => {
    const existing = decideComputationsTask.parse(JSON.stringify({ computations: [{ outputColumn: '現金給与総額', intent: '何か' }] }), computationsInput);
    expect(existing.ok === false ? parsedIssue(existing.issues, 0) : '').toBe('computations[0].outputColumn "現金給与総額" already exists in the table. Choose a new column name.');

    // コンパイラが parse-period で足す列も既存列として扱う。
    const compilerColumn = decideComputationsTask.parse(JSON.stringify({ computations: [{ outputColumn: 'periodStart', intent: '何か' }] }), computationsInput);
    expect(compilerColumn.ok === false ? parsedIssue(compilerColumn.issues, 0) : '').toBe('computations[0].outputColumn "periodStart" already exists in the table. Choose a new column name.');

    const duplicated = decideComputationsTask.parse(JSON.stringify({
      computations: [{ outputColumn: '比率', intent: 'a' }, { outputColumn: '比率', intent: 'b' }],
    }), computationsInput);
    expect(duplicated.ok === false ? parsedIssue(duplicated.issues, 0) : '').toBe('computations[1].outputColumn "比率" is used by another computation. Every computed column needs its own name.');

    const emptyIntent = decideComputationsTask.parse(JSON.stringify({ computations: [{ outputColumn: '比率', intent: '   ' }] }), computationsInput);
    expect(emptyIntent.ok === false ? parsedIssue(emptyIntent.issues, 0) : '').toBe('computations[0].intent must be one plain sentence saying what to compute. Received "   ".');
  });

  it('境界: 計算列は最大3件', () => {
    const entries = ['a', 'b', 'c', 'd'].map((name) => ({ outputColumn: name, intent: '差を出す。' }));
    const parsed = decideComputationsTask.parse(JSON.stringify({ computations: entries }), computationsInput);

    expect(parsed.ok === false ? parsed.issues : []).toEqual([`computations must contain at most ${MAX_TOOL_SPEC_COMPUTATIONS} entries. Received 4.`]);
  });

  it('正常: 規則は「式を書かない」「空配列が正解」「式の言語にできないこと」を言う', () => {
    const rules = decideComputationsTask.rules.join('\n');

    expect(decideComputationsTask.rules.length).toBeGreaterThanOrEqual(5);
    expect(decideComputationsTask.rules.length).toBeLessThanOrEqual(8);
    expect(rules).toContain('Do NOT write a formula');
    expect(rules).toContain('EMPTY computations array is the right answer');
    expect(rules).toContain('conditionals');
    expect(rules).toContain('text handling');
    expect(rules).toContain('aggregation over rows');
    expect(rules).toContain('previous row');
  });
});

// ---------------------------------------------------------------------------
// decide-output
// ---------------------------------------------------------------------------

describe('decideOutputTask', () => {
  it('正常: columnsのenumは渡された列一覧そのもの、sortは3択、limitは1..100', () => {
    const schema = decideOutputTask.schema(outputInput);

    expect(schema.properties['columns']?.items?.enum).toEqual(['時点', '地域', '現金給与総額', '総実労働時間', '時間あたり賃金']);
    expect(schema.properties['sort']?.enum).toEqual(['latest-first', 'oldest-first', 'none']);
    expect(schema.properties['limit']?.minimum).toBe(MIN_TOOL_SPEC_LIMIT);
    expect(schema.properties['limit']?.maximum).toBe(MAX_TOOL_SPEC_LIMIT);
    expect(schema.required).toEqual(['columns', 'sort', 'limit']);
  });

  it('正常: 列・並び・件数を受け取る（空のcolumnsは全列の意味）', () => {
    expect(decideOutputTask.parse(JSON.stringify({ columns: ['時点', '現金給与総額'], sort: 'latest-first', limit: 24 }), outputInput))
      .toEqual({ ok: true, value: { columns: ['時点', '現金給与総額'], sort: 'latest-first', limit: 24 } });
    expect(decideOutputTask.parse(JSON.stringify({ columns: [], sort: 'none', limit: 100 }), outputInput))
      .toEqual({ ok: true, value: { columns: [], sort: 'none', limit: 100 } });
  });

  it('正常: 材料は列一覧・行数の目安・目的だけ', async () => {
    const user = await userMessageOf(decideOutputTask, outputInput, JSON.stringify({ columns: [], sort: 'latest-first', limit: 50 }));

    expect(user).toContain('"estimatedRows":5400');
    expect(user).toContain('"availableColumns":["時点","地域","現金給与総額","総実労働時間","時間あたり賃金"]');
    expect(user).not.toContain('sampleRows');
    expect(user).not.toContain('サンプル行の目印');
    expect(user).not.toContain('地域コード');
    expect(user).not.toContain('categoricalColumns');
  });

  it('異常: 一覧に無い列・重複した列・未知の並びは差し戻す', () => {
    const unknown = decideOutputTask.parse(JSON.stringify({ columns: ['時点', '注記'], sort: 'asc', limit: 10 }), outputInput);
    expect(unknown.ok === false ? unknown.issues : []).toEqual([
      'columns[1] must be one of: 時点, 地域, 現金給与総額, 総実労働時間, 時間あたり賃金. Received "注記".',
      'sort must be one of: latest-first, oldest-first, none. Received "asc".',
    ]);

    const duplicated = decideOutputTask.parse(JSON.stringify({ columns: ['時点', '時点'], sort: 'none', limit: 10 }), outputInput);
    expect(duplicated.ok === false ? parsedIssue(duplicated.issues, 0) : '').toBe('columns[1] "時点" is listed twice. List every column at most once.');
  });

  it('境界: limitは1..100の整数のみ', () => {
    expect(decideOutputTask.parse(JSON.stringify({ columns: [], sort: 'none', limit: 1 }), outputInput).ok).toBe(true);
    expect(decideOutputTask.parse(JSON.stringify({ columns: [], sort: 'none', limit: MAX_TOOL_SPEC_LIMIT }), outputInput).ok).toBe(true);

    for (const [limit, received] of [[0, '0'], [101, '101'], [12.5, '12.5'], ['30', '"30"']] as const) {
      const parsed = decideOutputTask.parse(JSON.stringify({ columns: [], sort: 'none', limit }), outputInput);
      expect(parsed.ok === false ? parsedIssue(parsed.issues, 0) : '').toBe(`limit must be a whole number between ${MIN_TOOL_SPEC_LIMIT} and ${MAX_TOOL_SPEC_LIMIT}. Received ${received}.`);
    }
  });

  it('正常: 規則は期間・値・計算列を落とさないことと、引数なし呼び出しの上限を言う', () => {
    const rules = decideOutputTask.rules.join('\n');

    expect(decideOutputTask.rules.length).toBeGreaterThanOrEqual(5);
    expect(decideOutputTask.rules.length).toBeLessThanOrEqual(8);
    expect(rules).toContain('period label column');
    expect(rules).toContain('computed column');
    expect(rules).toContain('EMPTY columns array');
    expect(rules).toContain(`between ${MIN_TOOL_SPEC_LIMIT} and ${MAX_TOOL_SPEC_LIMIT}`);
    expect(rules).toContain('no arguments at all');
  });
});
