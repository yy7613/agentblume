import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_SPEC_CATEGORY_FILTERS,
  MAX_TOOL_SPEC_COMPUTATIONS,
  MAX_TOOL_SPEC_JOIN_KEYS,
  MAX_TOOL_SPEC_LIMIT,
  PERIOD_GRANULARITY_COLUMN,
  PERIOD_START_COLUMN,
  RESERVED_TOOL_SPEC_ARGUMENTS,
  TOOL_SPEC_VERSION,
  joinedColumnsOf,
  joinedValueColumnsOf,
  noteColumnOf,
  toolSpecColumns,
  validateToolSpec,
  valueColumnsOf,
  type ToolSpec,
  type ToolSpecContext,
  type ToolSpecSourceContext,
} from './tool-spec';

/** 単一ソース（全国の人口。時点は月次と年次が混ざる）。 */
const nationalSource: ToolSpecSourceContext = {
  dataSourceId: 'ds-national',
  name: '全国人口',
  columns: [
    { name: '時点', type: 'string' },
    { name: '地域', type: 'string' },
    { name: '人口', type: 'number' },
    { name: '注記', type: 'string' },
  ],
  periodColumns: [{ column: '時点', granularities: ['month', 'year'] }],
  categoricalColumns: [{ column: '地域', values: ['全国'] }],
};

function joinSource(id: string, name: string): ToolSpecSourceContext {
  return {
    dataSourceId: id,
    name,
    columns: [
      { name: '時点', type: 'string' },
      { name: '地域コード', type: 'string' },
      { name: '地域', type: 'string' },
      { name: '値', type: 'number' },
      { name: '注記', type: 'string' },
    ],
    periodColumns: [{ column: '時点', granularities: ['year'] }],
    categoricalColumns: [{ column: '地域', values: ['北海道', '東京都'] }],
  };
}

const singleContext: ToolSpecContext = { sources: [nationalSource], joinKeyCandidates: [], hasAdditionalSources: false };

const joinContext: ToolSpecContext = {
  sources: [joinSource('ds-1', '賃金'), joinSource('ds-2', '労働時間'), joinSource('ds-3', '物価')],
  joinKeyCandidates: ['時点', '地域コード', '地域'],
  hasAdditionalSources: true,
};

function spec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    version: TOOL_SPEC_VERSION as 1,
    period: { column: '時点', granularity: 'argument', defaultGranularity: 'month', range: true },
    categoryFilters: [{ column: '地域', argument: 'region', multi: true }],
    computations: [],
    output: { columns: [], sort: 'latest-first', limit: 20 },
    ...overrides,
  };
}

function messagesFor(issues: readonly { task: string; message: string }[], task: string): string[] {
  return issues.filter((issue) => issue.task === task).map((issue) => issue.message);
}

describe('validateToolSpec — 全体', () => {
  it('正常: 単一ソースの spec は違反を返さない', () => {
    expect(validateToolSpec(spec(), singleContext)).toEqual([]);
  });

  it('正常: 結合する spec は違反を返さない', () => {
    const joined = spec({
      join: { keys: ['時点', '地域コード'], mode: 'inner' },
      period: { column: '時点', granularity: 'year', range: true },
      categoryFilters: [{ column: '地域', argument: 'region', multi: true }],
    });
    expect(validateToolSpec(joined, joinContext)).toEqual([]);
  });

  it('異常: 未対応の version は decide-filters の issue になる', () => {
    const issues = validateToolSpec({ ...spec(), version: 2 as unknown as 1 }, singleContext);
    expect(messagesFor(issues, 'decide-filters').some((message) => message.includes('version 2'))).toBe(true);
  });

  it('例外: プロファイルが1件も無いときは decide-join の issue だけを返す', () => {
    const issues = validateToolSpec(spec(), { sources: [], joinKeyCandidates: [], hasAdditionalSources: false });
    expect(issues).toEqual([{ task: 'decide-join', message: 'no data source profile was given for this tool plan' }]);
  });
});

describe('validateToolSpec — decide-join', () => {
  it('異常: 追加データソースがあるのに join が無い', () => {
    const issues = validateToolSpec(spec({ period: { column: '時点', granularity: 'year', range: false } }), joinContext);
    expect(messagesFor(issues, 'decide-join')).toHaveLength(1);
    expect(messagesFor(issues, 'decide-join')[0]).toContain('needs a join');
  });

  it('異常: 単一ソースなのに join を宣言している', () => {
    const issues = validateToolSpec(spec({ join: { keys: ['時点'], mode: 'inner' } }), singleContext);
    expect(messagesFor(issues, 'decide-join')[0]).toContain('single data source');
  });

  it('異常: 候補に無い列を結合キーにしている', () => {
    const issues = validateToolSpec(spec({ join: { keys: ['注記'], mode: 'inner' }, period: { column: '時点', granularity: 'year', range: false } }), joinContext);
    expect(messagesFor(issues, 'decide-join')[0]).toContain("join key '注記' is not one of the shared key columns");
  });

  it('異常: 片方のソースに存在しない結合キー', () => {
    const missing: ToolSpecContext = {
      ...joinContext,
      sources: [joinContext.sources[0]!, { ...joinContext.sources[1]!, columns: joinContext.sources[1]!.columns.filter((column) => column.name !== '地域コード') }, joinContext.sources[2]!],
    };
    const issues = validateToolSpec(spec({ join: { keys: ['時点', '地域コード'], mode: 'inner' }, period: { column: '時点', granularity: 'year', range: false } }), missing);
    expect(messagesFor(issues, 'decide-join')[0]).toContain('does not exist in data source "ds-2"');
  });

  it('異常: 結合キーの型がソース間で食い違う', () => {
    const mixed: ToolSpecContext = {
      ...joinContext,
      sources: [joinContext.sources[0]!, { ...joinContext.sources[1]!, columns: joinContext.sources[1]!.columns.map((column) => column.name === '地域コード' ? { ...column, type: 'number' } : column) }, joinContext.sources[2]!],
    };
    const issues = validateToolSpec(spec({ join: { keys: ['地域コード'], mode: 'inner' }, period: { column: '時点', granularity: 'year', range: false } }), mixed);
    expect(messagesFor(issues, 'decide-join').some((message) => message.includes('different types'))).toBe(true);
  });

  it('異常: 同じ結合キーを2回書いている', () => {
    const issues = validateToolSpec(spec({ join: { keys: ['時点', '時点'], mode: 'inner' }, period: { column: '時点', granularity: 'year', range: false } }), joinContext);
    expect(messagesFor(issues, 'decide-join')[0]).toContain("repeats the column '時点'");
  });

  it('異常: mode が inner / left 以外', () => {
    const issues = validateToolSpec(spec({ join: { keys: ['時点'], mode: 'full' as unknown as 'inner' }, period: { column: '時点', granularity: 'year', range: false } }), joinContext);
    expect(messagesFor(issues, 'decide-join')[0]).toContain("join.mode must be 'inner' or 'left'");
  });

  it('境界: 結合キーは0件で違反、上限ちょうどは通り、1件超で違反', () => {
    const period = { column: '時点', granularity: 'year' as const, range: false };
    const wide: ToolSpecContext = {
      ...joinContext,
      joinKeyCandidates: ['時点', '地域コード', '地域', '値', '注記'],
    };
    expect(messagesFor(validateToolSpec(spec({ join: { keys: [], mode: 'inner' }, period }), wide), 'decide-join')[0]).toContain('join.keys is empty');
    const exact = ['時点', '地域コード', '地域', '値'].slice(0, MAX_TOOL_SPEC_JOIN_KEYS);
    expect(messagesFor(validateToolSpec(spec({ join: { keys: exact, mode: 'inner' }, period }), wide), 'decide-join')).toEqual([]);
    const tooMany = [...exact, '注記'];
    expect(messagesFor(validateToolSpec(spec({ join: { keys: tooMany, mode: 'inner' }, period }), wide), 'decide-join')[0]).toContain(`at most ${MAX_TOOL_SPEC_JOIN_KEYS}`);
  });
});

describe('validateToolSpec — decide-filters（期間）', () => {
  it('異常: period.column が期間ラベル列でない', () => {
    const issues = validateToolSpec(spec({ period: { column: '地域', granularity: 'month', range: false } }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain("period.column '地域' is not a period label column");
  });

  it('異常: データに存在しない粒度を固定で指定している', () => {
    const issues = validateToolSpec(spec({ period: { column: '時点', granularity: 'quarter', range: false } }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain("period.granularity 'quarter' does not occur in '時点'");
  });

  it('異常: granularity が argument なのに defaultGranularity が無い', () => {
    const issues = validateToolSpec(spec({ period: { column: '時点', granularity: 'argument', range: false } }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain('defaultGranularity is required');
  });

  it('異常: defaultGranularity がデータに存在しない粒度', () => {
    const issues = validateToolSpec(spec({ period: { column: '時点', granularity: 'argument', defaultGranularity: 'day', range: false } }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain("defaultGranularity 'day' does not occur");
  });

  it('異常: 粒度が混在しているのに period を決めていない', () => {
    const issues = validateToolSpec(spec({ period: undefined, output: { columns: [], sort: 'none', limit: 20 } }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain('mixes month / year rows');
  });

  it('異常: 期間ラベル列を持たないソースに period を指定している', () => {
    const noPeriod: ToolSpecContext = { sources: [{ ...nationalSource, periodColumns: [] }], joinKeyCandidates: [], hasAdditionalSources: false };
    const issues = validateToolSpec(spec(), noPeriod);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain('has no period label column');
  });

  it('異常: parse-period が足す列名が既にデータにある', () => {
    const clashing: ToolSpecContext = {
      sources: [{ ...nationalSource, columns: [...nationalSource.columns, { name: PERIOD_START_COLUMN, type: 'date' }] }],
      joinKeyCandidates: [],
      hasAdditionalSources: false,
    };
    const issues = validateToolSpec(spec(), clashing);
    expect(messagesFor(issues, 'decide-filters').some((message) => message.includes(`already has a column named '${PERIOD_START_COLUMN}'`))).toBe(true);
  });

  it('境界: 粒度が1種類だけなら period を省略してもよい', () => {
    const single: ToolSpecContext = {
      sources: [{ ...nationalSource, periodColumns: [{ column: '時点', granularities: ['year'] }] }],
      joinKeyCandidates: [],
      hasAdditionalSources: false,
    };
    expect(validateToolSpec(spec({ period: undefined, output: { columns: [], sort: 'none', limit: 20 } }), single)).toEqual([]);
  });
});

describe('validateToolSpec — decide-filters（カテゴリ引数）', () => {
  it('異常: 値を列挙できない列でカテゴリ絞り込みをしている', () => {
    const issues = validateToolSpec(spec({ categoryFilters: [{ column: '人口', argument: 'population', multi: true }] }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain("category filter column '人口' is not a column whose values can be listed");
  });

  it('異常: 予約された引数名（granularity / period_from / period_to）は使えない', () => {
    for (const reserved of RESERVED_TOOL_SPEC_ARGUMENTS) {
      const issues = validateToolSpec(spec({ categoryFilters: [{ column: '地域', argument: reserved, multi: true }] }), singleContext);
      expect(messagesFor(issues, 'decide-filters')[0]).toContain(`argument name '${reserved}' is reserved`);
    }
  });

  it('異常: snake_case でない引数名', () => {
    const issues = validateToolSpec(spec({ categoryFilters: [{ column: '地域', argument: 'Region Name', multi: true }] }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain('is not snake_case');
  });

  it('異常: 同じ引数名・同じ列を2回使っている', () => {
    const twoCategories: ToolSpecContext = {
      sources: [{ ...nationalSource, categoricalColumns: [{ column: '地域', values: ['全国'] }, { column: '注記', values: ['暫定値'] }] }],
      joinKeyCandidates: [],
      hasAdditionalSources: false,
    };
    const duplicateArgument = validateToolSpec(spec({ categoryFilters: [{ column: '地域', argument: 'x', multi: true }, { column: '注記', argument: 'x', multi: true }] }), twoCategories);
    expect(messagesFor(duplicateArgument, 'decide-filters')[0]).toContain("argument name 'x' is declared twice");
    const duplicateColumn = validateToolSpec(spec({ categoryFilters: [{ column: '地域', argument: 'a', multi: true }, { column: '地域', argument: 'b', multi: true }] }), twoCategories);
    expect(messagesFor(duplicateColumn, 'decide-filters')[0]).toContain("category filter column '地域' is used twice");
  });

  it('異常: multi: false は1回の呼び出しで1値しか頼めないので弾く', () => {
    const issues = validateToolSpec(spec({ categoryFilters: [{ column: '地域', argument: 'region', multi: false }] }), singleContext);
    expect(messagesFor(issues, 'decide-filters')[0]).toContain('multi: false');
  });

  it('境界: カテゴリ絞り込みは上限ちょうどまで通り、1件超で違反', () => {
    const many: ToolSpecContext = {
      sources: [{
        ...nationalSource,
        columns: [...nationalSource.columns, { name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'c', type: 'string' }],
        categoricalColumns: [
          { column: '地域', values: ['全国'] },
          { column: 'a', values: ['1'] },
          { column: 'b', values: ['2'] },
          { column: 'c', values: ['3'] },
        ],
      }],
      joinKeyCandidates: [],
      hasAdditionalSources: false,
    };
    const filters = [
      { column: '地域', argument: 'f1', multi: true },
      { column: 'a', argument: 'f2', multi: true },
      { column: 'b', argument: 'f3', multi: true },
    ];
    expect(messagesFor(validateToolSpec(spec({ categoryFilters: filters }), many), 'decide-filters')).toEqual([]);
    expect(filters).toHaveLength(MAX_TOOL_SPEC_CATEGORY_FILTERS);
    const tooMany = [...filters, { column: 'c', argument: 'f4', multi: true }];
    expect(messagesFor(validateToolSpec(spec({ categoryFilters: tooMany }), many), 'decide-filters')[0]).toContain(`at most ${MAX_TOOL_SPEC_CATEGORY_FILTERS}`);
  });

  it('異常: プロファイルに実在値が1つも無い列は設計時サンプルが作れない', () => {
    const empty: ToolSpecContext = {
      sources: [{ ...nationalSource, categoricalColumns: [{ column: '地域', values: [] }] }],
      joinKeyCandidates: [],
      hasAdditionalSources: false,
    };
    expect(messagesFor(validateToolSpec(spec(), empty), 'decide-filters')[0]).toContain('has no sample value');
  });
});

describe('validateToolSpec — decide-computations', () => {
  it('正常: 新しい列名の計算列は通る', () => {
    expect(validateToolSpec(spec({ computations: [{ outputColumn: '一人当たり', intent: '人口を世帯数で割る' }] }), singleContext)).toEqual([]);
  });

  it('異常: 既存の列名と衝突する計算列', () => {
    const issues = validateToolSpec(spec({ computations: [{ outputColumn: '人口', intent: '人口を2倍する' }] }), singleContext);
    expect(messagesFor(issues, 'decide-computations')[0]).toContain("collides with a column the table already has");
  });

  it('異常: parse-period が足す列名と衝突する計算列', () => {
    const issues = validateToolSpec(spec({ computations: [{ outputColumn: PERIOD_GRANULARITY_COLUMN, intent: '粒度を作る' }] }), singleContext);
    expect(messagesFor(issues, 'decide-computations')[0]).toContain('collides');
  });

  it('異常: 同じ計算列名を2回宣言している', () => {
    const issues = validateToolSpec(spec({ computations: [{ outputColumn: 'x', intent: 'a' }, { outputColumn: 'x', intent: 'b' }] }), singleContext);
    expect(messagesFor(issues, 'decide-computations')[0]).toContain("'x' is declared twice");
  });

  it('異常: outputColumn / intent が空', () => {
    const noName = validateToolSpec(spec({ computations: [{ outputColumn: '  ', intent: 'a' }] }), singleContext);
    expect(messagesFor(noName, 'decide-computations')[0]).toContain('non-empty outputColumn');
    const noIntent = validateToolSpec(spec({ computations: [{ outputColumn: 'x', intent: '' }] }), singleContext);
    expect(messagesFor(noIntent, 'decide-computations')[0]).toContain('needs an intent');
  });

  it('境界: 計算列は上限ちょうどまで通り、1件超で違反', () => {
    const exact = [
      { outputColumn: 'a', intent: '1' },
      { outputColumn: 'b', intent: '2' },
      { outputColumn: 'c', intent: '3' },
    ];
    expect(exact).toHaveLength(MAX_TOOL_SPEC_COMPUTATIONS);
    expect(messagesFor(validateToolSpec(spec({ computations: exact }), singleContext), 'decide-computations')).toEqual([]);
    const tooMany = [...exact, { outputColumn: 'd', intent: '4' }];
    expect(messagesFor(validateToolSpec(spec({ computations: tooMany }), singleContext), 'decide-computations')[0]).toContain(`at most ${MAX_TOOL_SPEC_COMPUTATIONS}`);
  });
});

describe('validateToolSpec — decide-output', () => {
  it('異常: 存在しない列を返そうとしている', () => {
    const issues = validateToolSpec(spec({ output: { columns: ['人口', '世帯数'], sort: 'latest-first', limit: 10 } }), singleContext);
    expect(messagesFor(issues, 'decide-output')[0]).toContain("output column '世帯数' does not exist");
  });

  it('正常: 計算列は「返す列」に選べる', () => {
    const issues = validateToolSpec(spec({
      computations: [{ outputColumn: '前年比', intent: '前年との比を出す' }],
      output: { columns: ['時点', '人口', '前年比'], sort: 'latest-first', limit: 10 },
    }), singleContext);
    expect(issues).toEqual([]);
  });

  it('異常: 期間を読まないのに latest-first で並べようとしている', () => {
    const noPeriod: ToolSpecContext = {
      sources: [{ ...nationalSource, periodColumns: [] }],
      joinKeyCandidates: [],
      hasAdditionalSources: false,
    };
    const issues = validateToolSpec(spec({ period: undefined, output: { columns: [], sort: 'latest-first', limit: 10 } }), noPeriod);
    expect(messagesFor(issues, 'decide-output')[0]).toContain('does not parse periods');
  });

  it('異常: sort が語彙の外', () => {
    const issues = validateToolSpec(spec({ output: { columns: [], sort: 'random' as unknown as 'none', limit: 10 } }), singleContext);
    expect(messagesFor(issues, 'decide-output')[0]).toContain('output.sort must be');
  });

  it('境界: limit は 1 と上限ちょうどで通り、0 と 上限+1 と小数で違反', () => {
    expect(messagesFor(validateToolSpec(spec({ output: { columns: [], sort: 'none', limit: 1 } }), singleContext), 'decide-output')).toEqual([]);
    expect(messagesFor(validateToolSpec(spec({ output: { columns: [], sort: 'none', limit: MAX_TOOL_SPEC_LIMIT } }), singleContext), 'decide-output')).toEqual([]);
    for (const limit of [0, MAX_TOOL_SPEC_LIMIT + 1, 10.5]) {
      expect(messagesFor(validateToolSpec(spec({ output: { columns: [], sort: 'none', limit } }), singleContext), 'decide-output')[0]).toContain('output.limit must be an integer');
    }
  });

  it('例外: output そのものが欠けていても投げずに decide-output の issue にする', () => {
    const issues = validateToolSpec({ ...spec(), output: undefined as unknown as ToolSpec['output'] }, singleContext);
    expect(messagesFor(issues, 'decide-output')[0]).toContain('output is missing');
  });
});

describe('列の導出', () => {
  it('正常: 単一ソースでは主ソースの全列 + 期間2列 + 計算列', () => {
    const columns = toolSpecColumns(spec({ computations: [{ outputColumn: '前年比', intent: 'x' }] }), singleContext);
    expect(columns).toEqual(['時点', '地域', '人口', '注記', PERIOD_START_COLUMN, PERIOD_GRANULARITY_COLUMN, '前年比']);
  });

  it('正常: 注記列と値の列を決定的に見つける', () => {
    expect(noteColumnOf(nationalSource)).toBe('注記');
    expect(valueColumnsOf(nationalSource, [])).toEqual(['人口']);
    expect(valueColumnsOf(joinSource('ds-1', 'x'), ['時点', '地域コード'])).toEqual(['値']);
  });

  it('境界: 同名の値の列は右側から順に _2 / _3 が付く', () => {
    const joined = spec({ join: { keys: ['時点', '地域コード'], mode: 'inner' }, period: { column: '時点', granularity: 'year', range: false } });
    expect(joinedColumnsOf(joined, joinContext)).toEqual(['時点', '地域コード', '地域', '値', '注記', '値_2', '値_3']);
    expect(joinedValueColumnsOf(joined, joinContext)).toEqual(['値', '値_2', '値_3']);
  });

  it('境界: 結合キーに使った右側の列は出力から落ちる', () => {
    const joined = spec({ join: { keys: ['時点', '地域コード', '地域'], mode: 'inner' }, period: { column: '時点', granularity: 'year', range: false }, categoryFilters: [] });
    expect(joinedColumnsOf(joined, joinContext).filter((column) => column === '地域')).toEqual(['地域']);
  });
});
