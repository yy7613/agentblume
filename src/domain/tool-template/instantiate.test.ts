import { describe, expect, it } from 'vitest';
import {
  applicableTemplates,
  argumentNullabilityViolations,
  instantiateTemplate,
  slotCandidates,
  templateArgumentViews,
  validateSlotValues,
  withPendingExpression,
  withSlotDefaults,
  type TemplateSlotValues,
} from './instantiate';
import { ToolTemplateError, parseToolTemplate, type TemplateContext, type ToolTemplate } from './template';

// ── 文脈（e-Stat 風の 2 ソース） ──────────────────────────────────────────────────

const CONTEXT: TemplateContext = {
  sources: [
    {
      dataSourceId: 'ds-wage',
      name: '賃金',
      format: 'csv',
      columns: [
        { name: '時点', type: 'string' },
        { name: '地域コード', type: 'string' },
        { name: '地域', type: 'string' },
        { name: '値', type: 'number' },
        { name: '注記', type: 'string' },
      ],
      periodColumns: [{ column: '時点', granularities: ['year', 'month'], minStart: '2022-01-01', maxStart: '2023-05-01' }],
      categoricalColumns: [
        { column: '地域', values: ['北海道', '東京都', '大阪府'] },
        { column: '時点', values: ['2023年', '2022年'] },
      ],
    },
    {
      dataSourceId: 'ds-hours',
      name: '労働時間',
      format: 'json',
      columns: [
        { name: '時点', type: 'string' },
        { name: '地域コード', type: 'string' },
        { name: '地域', type: 'string' },
        { name: '値', type: 'number' },
      ],
      periodColumns: [{ column: '時点', granularities: ['year'], minStart: '2022-01-01', maxStart: '2023-01-01' }],
      categoricalColumns: [{ column: '地域', values: ['北海道', '東京都'] }],
    },
  ],
  joinCandidates: [{ leftDataSourceId: 'ds-wage', rightDataSourceId: 'ds-hours', keys: ['時点', '地域コード', '地域'] }],
};

function templateOf(json: Record<string, unknown>): ToolTemplate {
  const parsed = parseToolTemplate(json);
  if (!parsed.ok) throw new Error(`fixture template is invalid: ${parsed.problems.join(' / ')}`);
  return parsed.template;
}

/** 1 ソース・任意カテゴリつきのテンプレート（置換と `when` を一通り含む）。 */
const SINGLE = templateOf({
  formatVersion: 1,
  id: 'series',
  version: '1.0.0',
  title: { ja: '推移', en: 'Series' },
  summary: { ja: '推移。', en: 'Series.' },
  whenToUse: { ja: ['推移'], en: ['Series'] },
  tags: [],
  sources: { min: 1, max: 1 },
  slots: [
    { name: 'source', kind: 'dataSource', label: { ja: 'ソース', en: 'Source' } },
    { name: 'periodColumn', kind: 'column', source: 'source', role: 'period', label: { ja: '期間', en: 'Period' } },
    { name: 'valueColumns', kind: 'column', source: 'source', role: 'value', multiple: { min: 1, max: 3 }, label: { ja: '値', en: 'Values' } },
    { name: 'categoryColumn', kind: 'column', source: 'source', role: 'category', optional: true, label: { ja: 'カテゴリ', en: 'Category' } },
    { name: 'granularity', kind: 'choice', optionsFrom: 'granularities:periodColumn', label: { ja: '粒度', en: 'Granularity' } },
    { name: 'limit', kind: 'number', min: 1, max: 100, integer: true, default: 20, label: { ja: '件数', en: 'Rows' } },
  ],
  arguments: [
    { name: 'period_from', type: 'date', nullable: true, description: { ja: '開始', en: 'From' }, sample: { $profile: 'periodMin:periodColumn' } },
    {
      name: 'categories', type: 'string', nullable: true, when: 'categoryColumn',
      description: { ja: '{{categoryColumn}} の値', en: 'values of {{categoryColumn}}' },
      sample: { $profile: 'firstValuesCsv:categoryColumn:2' },
    },
  ],
  nodes: [
    { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
    { id: 'period', type: 'parse-period', config: { column: { $slot: 'periodColumn' }, startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4 } },
    { id: 'f_granularity', type: 'filter', config: { column: 'periodGranularity', op: 'eq', value: { $slot: 'granularity' } } },
    {
      id: 'f_category', type: 'filter', when: 'categoryColumn',
      config: { column: { $slot: 'categoryColumn' }, op: 'in', values: { $profile: 'firstValues:categoryColumn:2' }, valueBinding: { $argument: 'categories' } },
    },
    { id: 'f_range', type: 'filter', config: { column: 'periodStart', op: 'gte', value: { $profile: 'periodMin:periodColumn' }, valueBinding: { $argument: 'period_from' } } },
    { id: 'select', type: 'select', config: { columns: { $concat: [[{ $slot: 'periodColumn' }], { $slot: 'valueColumns' }, [{ $slot: 'periodColumn' }]] } } },
    { id: 'limit', type: 'limit', config: { count: { $slot: 'limit' } } },
    { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: { $slot: 'limit' }, maxBytes: 65536, overflow: 'error' } },
  ],
  edges: [
    { from: 'src', to: 'period' },
    { from: 'period', to: 'f_granularity' },
    { from: 'f_granularity', to: 'f_category' },
    { from: 'f_category', to: 'f_range' },
    { from: 'f_range', to: 'select' },
    { from: 'select', to: 'limit' },
    { from: 'limit', to: 'out' },
  ],
  description: {
    ja: '{{valueColumns}} を最大 {{limit}} 行返します（粒度 {{granularity}}）。',
    en: 'Returns {{valueColumns}}, up to {{limit}} rows ({{granularity}}).',
  },
});

/** 2 ソース結合（右側の同名列の読み替えを確かめる）。 */
const JOINED = templateOf({
  formatVersion: 1,
  id: 'ratio',
  version: '1.0.0',
  title: { ja: '比', en: 'Ratio' },
  summary: { ja: '比。', en: 'Ratio.' },
  whenToUse: { ja: ['比'], en: ['Ratio'] },
  tags: [],
  sources: { min: 2, max: 2 },
  slots: [
    { name: 'left', kind: 'dataSource', label: { ja: '左', en: 'Left' } },
    { name: 'right', kind: 'dataSource', label: { ja: '右', en: 'Right' } },
    { name: 'joinKeys', kind: 'joinKeys', left: 'left', right: 'right', multiple: { min: 1, max: 3 }, label: { ja: 'キー', en: 'Keys' } },
    { name: 'numerator', kind: 'column', source: 'left', role: 'value', label: { ja: '分子', en: 'Numerator' } },
    { name: 'denominator', kind: 'column', source: 'right', role: 'value', label: { ja: '分母', en: 'Denominator' } },
  ],
  arguments: [],
  nodes: [
    { id: 'src_l', type: { $sourceType: 'left' }, config: { dataSourceId: { $slot: 'left' } } },
    { id: 'src_r', type: { $sourceType: 'right' }, config: { dataSourceId: { $slot: 'right' } } },
    { id: 'sel_r', type: 'select', config: { columns: { $concat: [{ $slot: 'joinKeys' }, [{ $slot: 'denominator' }]] } } },
    { id: 'join', type: 'join', config: { mode: 'inner', keys: { $each: 'joinKeys', as: 'k', item: { left: '{{k}}', right: '{{k}}' } }, rightSuffix: '_2' } },
    { id: 'calc', type: 'calculate', config: { outputColumn: '比率', expression: '[{{numerator}}] / [{{denominator}}]', onError: 'null' } },
    { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 10, maxBytes: 65536, overflow: 'error' } },
  ],
  edges: [
    { from: 'src_l', to: 'join', toInput: 0 },
    { from: 'src_r', to: 'sel_r' },
    { from: 'sel_r', to: 'join', toInput: 1 },
    { from: 'join', to: 'calc' },
    { from: 'calc', to: 'out' },
  ],
  description: { ja: '{{numerator}} ÷ {{denominator}}', en: '{{numerator}} / {{denominator}}' },
});

const FULL: TemplateSlotValues = {
  source: 'ds-wage',
  periodColumn: '時点',
  valueColumns: ['値'],
  categoryColumn: '地域',
  granularity: 'year',
};

const JOIN_VALUES: TemplateSlotValues = {
  left: 'ds-wage',
  right: 'ds-hours',
  joinKeys: ['時点', '地域コード'],
  numerator: '値',
  denominator: '値',
};

function nodeById(nodes: readonly { readonly id: string; readonly type: string; readonly config: unknown }[], id: string): { readonly type: string; readonly config: Record<string, unknown> } {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`node '${id}' is missing from the instantiated graph`);
  return { type: node.type, config: node.config as Record<string, unknown> };
}

// ── 候補 ─────────────────────────────────────────────────────────────────────────

describe('slotCandidates', () => {
  it('正常: role ごとに候補を絞る（期間列・カテゴリ列・値の列）', () => {
    const candidates = slotCandidates(SINGLE, CONTEXT, { source: 'ds-wage' });
    expect(candidates['periodColumn']).toEqual(['時点']);
    expect(candidates['categoryColumn']).toEqual(['地域', '時点']);
    expect(candidates['valueColumns']).toEqual(['値']);
  });

  it('正常: `granularities:` はその期間列に実在する粒度だけを出す', () => {
    expect(slotCandidates(SINGLE, CONTEXT, { source: 'ds-wage', periodColumn: '時点' })['granularity']).toEqual(['year', 'month']);
    expect(slotCandidates(SINGLE, CONTEXT, { source: 'ds-hours', periodColumn: '時点' })['granularity']).toEqual(['year']);
  });

  it('正常: number は範囲、text / intent は自由記述を返す', () => {
    expect(slotCandidates(SINGLE, CONTEXT)['limit']).toEqual({ min: 1, max: 100 });
  });

  it('正常: joinKeys はその 2 ソースの組で共有しているキーだけを出す', () => {
    expect(slotCandidates(JOINED, CONTEXT, JOIN_VALUES)['joinKeys']).toEqual(['時点', '地域コード', '地域']);
  });

  it('境界: 値のまだ無い dataSource スロットは宣言順で文脈のソースに対応づける', () => {
    expect(slotCandidates(JOINED, CONTEXT)['numerator']).toEqual(['値']);
    expect(slotCandidates(JOINED, CONTEXT)['denominator']).toEqual(['値']);
  });

  it('異常: 値の列が 1 つも無いソースでは候補が空になる（= 適用不可の材料）', () => {
    const textOnly: TemplateContext = {
      sources: [{ ...CONTEXT.sources[0]!, columns: [{ name: '時点', type: 'string' }] }],
      joinCandidates: [],
    };
    expect(slotCandidates(SINGLE, textOnly)['valueColumns']).toEqual([]);
  });
});

describe('applicableTemplates', () => {
  it('正常: ソース数が合い、必須スロットに候補があるテンプレートだけを残す', () => {
    const one: TemplateContext = { sources: [CONTEXT.sources[0]!], joinCandidates: [] };
    expect(applicableTemplates([SINGLE, JOINED], one).map((template) => template.id)).toEqual(['series']);
    expect(applicableTemplates([SINGLE, JOINED], CONTEXT).map((template) => template.id)).toEqual(['ratio']);
  });

  it('異常: ソース数が範囲外のテンプレートは出さない（2 ソースの計画に 1 ソース用は出さない）', () => {
    expect(applicableTemplates([SINGLE], CONTEXT)).toEqual([]);
  });

  it('異常: 必須スロットの候補が 0 件なら適用不可（選択肢に出さない）', () => {
    const noPeriod: TemplateContext = { sources: [{ ...CONTEXT.sources[0]!, periodColumns: [] }], joinCandidates: [] };
    expect(applicableTemplates([SINGLE], { sources: [CONTEXT.sources[0]!], joinCandidates: [] })).toHaveLength(1);
    expect(applicableTemplates([SINGLE], noPeriod)).toEqual([]);
  });
});

// ── スロット検証 ─────────────────────────────────────────────────────────────────

describe('validateSlotValues', () => {
  it('正常: 妥当な値の組み合わせは違反 0 件', () => {
    expect(validateSlotValues(SINGLE, FULL, CONTEXT)).toEqual([]);
  });

  it('正常: 任意スロットを空にしても違反にならない', () => {
    expect(validateSlotValues(SINGLE, { ...FULL, categoryColumn: undefined }, CONTEXT)).toEqual([]);
  });

  it('異常: 必須スロットが空なら、選べる候補を挙げて差し戻す', () => {
    const violations = validateSlotValues(SINGLE, { ...FULL, periodColumn: undefined }, CONTEXT);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.slot).toBe('periodColumn');
    expect(violations[0]?.message).toContain('choose one of 時点');
  });

  it('異常: 役割に合わない列を選んだら、そのスロットで候補を挙げる', () => {
    const violations = validateSlotValues(SINGLE, { ...FULL, valueColumns: ['注記'] }, CONTEXT);
    expect(violations[0]).toEqual({ slot: 'valueColumns', message: expect.stringContaining("'注記'") });
  });

  it('境界: multiple の件数が上限を超えたら、範囲を示して差し戻す', () => {
    const violations = validateSlotValues(SINGLE, { ...FULL, valueColumns: [] }, CONTEXT);
    expect(violations[0]?.slot).toBe('valueColumns');
  });

  it('異常: 結合キーにプロファイルが挙げていない列を選んだら、候補を挙げる', () => {
    const violations = validateSlotValues(JOINED, { ...JOIN_VALUES, joinKeys: ['注記'] }, CONTEXT);
    expect(violations[0]?.slot).toBe('joinKeys');
    expect(violations[0]?.message).toContain('時点, 地域コード, 地域');
  });

  it('異常: 列名に `]` を含む列を式に使うと、上流で列名を変えるよう言う', () => {
    const bracket: TemplateContext = {
      ...CONTEXT,
      sources: CONTEXT.sources.map((source) => ({ ...source, columns: [...source.columns, { name: '値[確報]', type: 'number' }] })),
    };
    const violations = validateSlotValues(JOINED, { ...JOIN_VALUES, numerator: '値[確報]' }, bracket);
    expect(violations.some((violation) => violation.slot === 'numerator' && violation.message.includes('rename the column upstream'))).toBe(true);
  });

  it('境界: number スロットの範囲外は、範囲を示して差し戻す', () => {
    const violations = validateSlotValues(SINGLE, { ...FULL, limit: 101 }, CONTEXT);
    expect(violations[0]?.message).toContain('outside 1..100');
  });

  it('異常: 知らないスロット名を渡したら、消すよう言って宣言済みの名前を挙げる', () => {
    const violations = validateSlotValues(SINGLE, { ...FULL, nope: 'x' }, CONTEXT);
    expect(violations[0]?.slot).toBe('nope');
    expect(violations[0]?.message).toContain('has no slot named');
  });

  it('異常: distinctFrom が同じ列を指したら、片方を変えるよう言う', () => {
    const distinct = templateOf({
      ...JSON.parse(JSON.stringify({
        formatVersion: 1, id: 'two-values', version: '1.0.0',
        title: { ja: 'a', en: 'a' }, summary: { ja: 'a', en: 'a' }, whenToUse: { ja: ['a'], en: ['a'] }, tags: [],
        sources: { min: 1, max: 1 },
        slots: [
          { name: 'source', kind: 'dataSource', label: { ja: 'a', en: 'a' } },
          { name: 'a', kind: 'column', source: 'source', role: 'any', label: { ja: 'a', en: 'a' } },
          { name: 'b', kind: 'column', source: 'source', role: 'any', distinctFrom: ['a'], label: { ja: 'b', en: 'b' } },
        ],
        arguments: [],
        nodes: [
          { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
          { id: 'sel', type: 'select', config: { columns: [{ $slot: 'a' }, { $slot: 'b' }] } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
        description: { ja: '{{a}} {{b}}', en: '{{a}} {{b}}' },
      })),
    });
    const violations = validateSlotValues(distinct, { source: 'ds-wage', a: '地域', b: '地域' }, CONTEXT);
    expect(violations[0]?.slot).toBe('b');
    expect(violations[0]?.message).toContain("slot 'a'");
  });
});

// ── 実体化 ───────────────────────────────────────────────────────────────────────

describe('instantiateTemplate', () => {
  const options = { toolName: 'wage_series', language: 'ja' as const };

  it('正常: 置換が型を保つ（配列は配列・数値は数値・文字列は文字列）', () => {
    const instantiated = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    expect(nodeById(instantiated.graph.nodes, 'limit').config['count']).toBe(20);
    expect(nodeById(instantiated.graph.nodes, 'period').config['column']).toBe('時点');
    expect(nodeById(instantiated.graph.nodes, 'select').config['columns']).toEqual(['時点', '値']);
  });

  it('正常: $sourceType がプロファイルの形式から source ノードの種別を決める', () => {
    expect(nodeById(instantiateTemplate(SINGLE, FULL, CONTEXT, options).graph.nodes, 'src').type).toBe('csv-source');
    const json = instantiateTemplate(SINGLE, { ...FULL, source: 'ds-hours', granularity: 'year' }, CONTEXT, options);
    expect(nodeById(json.graph.nodes, 'src').type).toBe('json-source');
  });

  it('正常: $concat は配列を連結して重複を除く', () => {
    const instantiated = instantiateTemplate(SINGLE, { ...FULL, valueColumns: ['値'] }, CONTEXT, options);
    expect(nodeById(instantiated.graph.nodes, 'select').config['columns']).toEqual(['時点', '値']);
  });

  it('正常: $profile が期間の実測範囲とカテゴリの実在値を入れる', () => {
    const instantiated = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    expect(nodeById(instantiated.graph.nodes, 'f_range').config['value']).toBe('2022-01-01');
    expect(nodeById(instantiated.graph.nodes, 'f_category').config['values']).toEqual(['北海道', '東京都']);
  });

  it('正常: $argument が filter の valueBinding へ展開される', () => {
    const instantiated = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    expect(nodeById(instantiated.graph.nodes, 'f_range').config['valueBinding']).toEqual({ source: 'agent-input', field: 'period_from' });
  });

  it('正常: 説明文は言語ごとに、配列スロットを `, ` で連結して埋め込む', () => {
    const ja = instantiateTemplate(SINGLE, { ...FULL, valueColumns: ['値', '注記'] }, { ...CONTEXT, sources: CONTEXT.sources }, options);
    expect(ja.agentTool.description.split('\n')[0]).toBe('値, 注記 を最大 20 行返します（粒度 year）。');
    const en = instantiateTemplate(SINGLE, FULL, CONTEXT, { ...options, language: 'en' });
    expect(en.agentTool.description.split('\n')[0]).toBe('Returns 値, up to 20 rows (year).');
  });

  it('正常: 引数の説明を Tool の説明文へ連結する（モデルへ届く文章は説明文だけ。実測: 届かず granularity に "monthly" を渡した）', () => {
    const ja = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    expect(ja.agentTool.description.split('\n').slice(1)).toEqual(['引数:', '- period_from (省略可): 開始', '- categories (省略可): 地域 の値']);
    const en = instantiateTemplate(SINGLE, FULL, CONTEXT, { ...options, language: 'en' });
    expect(en.agentTool.description.split('\n').slice(1)).toEqual(['Arguments:', '- period_from (optional): From', '- categories (optional): values of 地域']);
  });

  it('境界: when で落ちた引数の説明は載せない。必須の引数は「必須」と書く。引数が無ければ見出しごと出さない', () => {
    const withoutCategory = instantiateTemplate(SINGLE, { ...FULL, categoryColumn: undefined }, CONTEXT, options);
    expect(withoutCategory.agentTool.description.split('\n').slice(1)).toEqual(['引数:', '- period_from (省略可): 開始']);

    const required = instantiateTemplate({ ...SINGLE, arguments: SINGLE.arguments.map((argument) => (argument.name === 'period_from' ? { ...argument, nullable: false } : argument)) }, FULL, CONTEXT, options);
    expect(required.agentTool.description).toContain('- period_from (必須): 開始');

    const bare = instantiateTemplate(JOINED, JOIN_VALUES, CONTEXT, { toolName: 'ratio', language: 'ja' });
    expect(bare.agentTool.description).not.toContain('引数:');
    expect(bare.agentTool.description).toBe('値 ÷ 値');
  });

  it('正常: 残った引数から agent-input ノードと inputSchema が生成される', () => {
    const instantiated = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    expect(instantiated.inputSchema?.columns).toEqual([
      { name: 'period_from', type: 'date', nullable: true },
      { name: 'categories', type: 'string', nullable: true },
    ]);
    expect(nodeById(instantiated.graph.nodes, 'args').config['sample']).toEqual({ period_from: '2022-01-01', categories: '北海道,東京都' });
  });

  it('正常: 任意スロットが空ならノードも引数も消え、前後のノードが繋がる', () => {
    const instantiated = instantiateTemplate(SINGLE, { ...FULL, categoryColumn: undefined }, CONTEXT, options);
    expect(instantiated.graph.nodes.map((node) => node.id)).not.toContain('f_category');
    expect(instantiated.graph.edges).toContainEqual({ from: 'f_granularity', to: 'f_range' });
    expect(instantiated.inputSchema?.columns.map((column) => column.name)).toEqual(['period_from']);
  });

  it('境界: 引数が 1 つも残らなければ inputSchema も agent-input ノードも作らない', () => {
    const instantiated = instantiateTemplate(JOINED, JOIN_VALUES, CONTEXT, { toolName: 'ratio', language: 'ja' });
    expect(instantiated.inputSchema).toBeUndefined();
    expect(instantiated.graph.nodes.map((node) => node.id)).not.toContain('args');
  });

  it('正常: 結合の右側から来た同名列は、join より下流でだけ suffix 付きへ読み替える', () => {
    const instantiated = instantiateTemplate(JOINED, JOIN_VALUES, CONTEXT, { toolName: 'ratio', language: 'ja' });
    expect(nodeById(instantiated.graph.nodes, 'sel_r').config['columns']).toEqual(['時点', '地域コード', '値']);
    expect(nodeById(instantiated.graph.nodes, 'calc').config['expression']).toBe('[値] / [値_2]');
    expect(instantiated.columnSlots['値_2']).toBe('denominator');
  });

  it('正常: $each が配列スロットを要素ごとに展開する（join の keys）', () => {
    const instantiated = instantiateTemplate(JOINED, JOIN_VALUES, CONTEXT, { toolName: 'ratio', language: 'ja' });
    expect(nodeById(instantiated.graph.nodes, 'join').config['keys']).toEqual([
      { left: '時点', right: '時点' },
      { left: '地域コード', right: '地域コード' },
    ]);
  });

  it('境界: $each は配列でないスロットでも使える（空なら 0 件、埋まっていれば 1 件）', () => {
    const grouped = templateOf({
      formatVersion: 1, id: 'grouped', version: '1.0.0',
      title: { ja: 'a', en: 'a' }, summary: { ja: 'a', en: 'a' }, whenToUse: { ja: ['a'], en: ['a'] }, tags: [],
      sources: { min: 1, max: 1 },
      slots: [
        { name: 'source', kind: 'dataSource', label: { ja: 'a', en: 'a' } },
        { name: 'group', kind: 'column', source: 'source', role: 'category', optional: true, label: { ja: 'a', en: 'a' } },
      ],
      arguments: [],
      nodes: [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'g', type: 'group-by', config: { groupBy: { $each: 'group', as: 'c', item: '{{c}}' }, aggregates: [{ op: 'count', as: '件数' }] } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'g' }, { from: 'g', to: 'out' }],
      description: { ja: 'a', en: 'a' },
    });
    expect(nodeById(instantiateTemplate(grouped, { source: 'ds-wage', group: '地域' }, CONTEXT, { toolName: 'g', language: 'ja' }).graph.nodes, 'g').config['groupBy']).toEqual(['地域']);
    expect(nodeById(instantiateTemplate(grouped, { source: 'ds-wage' }, CONTEXT, { toolName: 'g', language: 'ja' }).graph.nodes, 'g').config['groupBy']).toEqual([]);
  });

  it('正常: 決定的（同じ入力からは完全に同じグラフ・説明文が出る）', () => {
    const first = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    const second = instantiateTemplate(SINGLE, FULL, CONTEXT, options);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('異常: $number が数値にできないスロット値を受けたら、直し方つきで止まる', () => {
    const bad = templateOf({
      formatVersion: 1, id: 'lagged', version: '1.0.0',
      title: { ja: 'a', en: 'a' }, summary: { ja: 'a', en: 'a' }, whenToUse: { ja: ['a'], en: ['a'] }, tags: [],
      sources: { min: 1, max: 1 },
      slots: [
        { name: 'source', kind: 'dataSource', label: { ja: 'a', en: 'a' } },
        { name: 'lag', kind: 'text', maxLength: 10, default: 'まいつき', label: { ja: 'a', en: 'a' } },
      ],
      arguments: [],
      nodes: [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'limit', type: 'limit', config: { count: { $number: 'lag' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'limit' }, { from: 'limit', to: 'out' }],
      description: { ja: '{{lag}}', en: '{{lag}}' },
    });
    expect(() => instantiateTemplate(bad, { source: 'ds-wage' }, CONTEXT, { toolName: 't', language: 'ja' }))
      .toThrow(/\$number cannot turn the value of slot 'lag'/);
  });

  it('例外: function 名にできない toolName は、使える文字を示して止める', () => {
    expect(() => instantiateTemplate(SINGLE, FULL, CONTEXT, { toolName: '賃金の推移', language: 'ja' }))
      .toThrow(ToolTemplateError);
  });

  it('例外: 知らないデータソース id を渡したら、プロファイル済みの id を挙げて止める', () => {
    expect(() => instantiateTemplate(SINGLE, { ...FULL, source: 'ds-none' }, CONTEXT, options))
      .toThrow(/not among the profiled sources/);
  });
});

// ── 引数の必須 / 任意の上書き（v46 §B） ─────────────────────────────────────────────

/**
 * SINGLE に「固定された粒度の引数」と「見本の無い任意の引数」を足したもの。
 * 粒度は granularity の filter に束縛する（省略されると条件ごと外れ、月次と年次が混ざる型）。
 */
const LOCKED: ToolTemplate = {
  ...SINGLE,
  arguments: [
    {
      name: 'granularity', type: 'string', nullable: false,
      lock: { ja: '省略できると月次と年次が混ざるため、必須に固定しています', en: 'Required: omitting it would mix monthly and annual rows' },
      description: { ja: '粒度', en: 'Granularity' }, sample: { $slot: 'granularity' },
    },
    ...SINGLE.arguments,
    { name: 'note', type: 'string', nullable: true, description: { ja: '注記', en: 'Note' }, sample: null },
  ],
  nodes: SINGLE.nodes.map((node) => (node.id === 'f_granularity'
    ? { ...node, config: { ...(node.config as Record<string, unknown>), valueBinding: { $argument: 'granularity' } } }
    : node)),
};

describe('instantiateTemplate: 引数の必須 / 任意の上書き', () => {
  const options = { toolName: 'wage_series', language: 'ja' as const };
  const columnOf = (instantiated: ReturnType<typeof instantiateTemplate>, name: string) =>
    instantiated.inputSchema?.columns.find((column) => column.name === name);

  it('従来どおり: 上書きを渡さない・空で渡すなら、テンプレートの既定のまま（Factory の呼び方）', () => {
    const plain = instantiateTemplate(LOCKED, FULL, CONTEXT, options);
    expect(JSON.stringify(instantiateTemplate(LOCKED, FULL, CONTEXT, { ...options, argumentNullability: {} }))).toBe(JSON.stringify(plain));
    expect(columnOf(plain, 'period_from')?.nullable).toBe(true);
    expect(columnOf(plain, 'granularity')?.nullable).toBe(false);
  });

  it('正常: 任意 → 必須にすると、入力スキーマの列・説明文の「必須」・設計時の見本がそろって必須になる', () => {
    const instantiated = instantiateTemplate(LOCKED, FULL, CONTEXT, { ...options, argumentNullability: { period_from: false } });
    expect(columnOf(instantiated, 'period_from')).toEqual({ name: 'period_from', type: 'date', nullable: false });
    expect(instantiated.agentTool.description).toContain('- period_from (必須): 開始');
    expect(instantiated.agentTool.description).not.toContain('- period_from (省略可)');
    expect(nodeById(instantiated.graph.nodes, 'args').config['sample']).toMatchObject({ period_from: '2022-01-01' });
    // 他の引数は既定のまま。
    expect(columnOf(instantiated, 'categories')?.nullable).toBe(true);
  });

  it('正常: 必須 → 任意にすると、入力スキーマの列と説明文が「省略可」になる（英語でも）', () => {
    const required = { ...LOCKED, arguments: LOCKED.arguments.map((argument) => (argument.name === 'period_from' ? { ...argument, nullable: false } : argument)) };
    const ja = instantiateTemplate(required, FULL, CONTEXT, { ...options, argumentNullability: { period_from: true } });
    expect(columnOf(ja, 'period_from')?.nullable).toBe(true);
    expect(ja.agentTool.description).toContain('- period_from (省略可): 開始');
    const en = instantiateTemplate(required, FULL, CONTEXT, { ...options, language: 'en', argumentNullability: { period_from: true } });
    expect(en.agentTool.description).toContain('- period_from (optional): From');
  });

  it('境界: lock のある引数を既定と同じ値で送るのは可（変えていないので止めない）', () => {
    expect(argumentNullabilityViolations(LOCKED, FULL, { granularity: false })).toEqual([]);
    const instantiated = instantiateTemplate(LOCKED, FULL, CONTEXT, { ...options, argumentNullability: { granularity: false } });
    expect(columnOf(instantiated, 'granularity')?.nullable).toBe(false);
  });

  it('境界: when で落ちた引数への指定は無視する（その引数は作られない）', () => {
    const withoutCategory = { ...FULL, categoryColumn: undefined };
    const instantiated = instantiateTemplate(LOCKED, withoutCategory, CONTEXT, { ...options, argumentNullability: { categories: false } });
    expect(instantiated.inputSchema?.columns.map((column) => column.name)).not.toContain('categories');
    expect(argumentNullabilityViolations(LOCKED, withoutCategory, { categories: false })).toEqual([]);
  });

  it('異常: テンプレートに無い引数名は、使える名前を挙げて argument:<name> の違反にする', () => {
    const violations = argumentNullabilityViolations(LOCKED, FULL, { period_form: false });
    expect(violations).toEqual([{ slot: 'argument:period_form', message: expect.stringContaining("argument 'period_form' is not in this template") }]);
    expect(violations[0]?.message).toContain('choose one of granularity, period_from, categories, note');
  });

  it('異常: lock のある引数を既定と違う値にすると、lock の理由つきで止める', () => {
    const violations = argumentNullabilityViolations(LOCKED, FULL, { granularity: true });
    expect(violations).toEqual([{
      slot: 'argument:granularity',
      message: "argument 'granularity' cannot be changed: Required: omitting it would mix monthly and annual rows; leave it required",
    }]);
  });

  it('異常: 設計時の見本が無い引数は必須にできない（テンプレートに sample を書くよう言う）', () => {
    const violations = argumentNullabilityViolations(LOCKED, FULL, { note: false });
    expect(violations).toEqual([{ slot: 'argument:note', message: expect.stringContaining("argument 'note' has no design-time sample, so it cannot be made required") }]);
    expect(violations[0]?.message).toContain('write a "sample" for it in the template');
  });

  it('異常: 違反は 1 度に全部返す', () => {
    const violations = argumentNullabilityViolations(LOCKED, FULL, { nope: true, granularity: true, note: false });
    expect(violations.map((violation) => violation.slot)).toEqual(['argument:nope', 'argument:granularity', 'argument:note']);
  });

  it('例外: 検査を通らない上書きを instantiateTemplate へ直に渡すと、黙って効かせずに止める', () => {
    expect(() => instantiateTemplate(LOCKED, FULL, CONTEXT, { ...options, argumentNullability: { granularity: true } }))
      .toThrow(ToolTemplateError);
    expect(() => instantiateTemplate(LOCKED, FULL, CONTEXT, { ...options, argumentNullability: { note: false } }))
      .toThrow(/no design-time sample/);
  });
});

describe('templateArgumentViews', () => {
  it('正常: 今のスロット値で残る引数を、表示言語の説明と lock の理由つきで返す（既定の nullable のまま）', () => {
    const views = templateArgumentViews(LOCKED, FULL, 'ja');
    expect(views.map((view) => view.name)).toEqual(['granularity', 'period_from', 'categories', 'note']);
    expect(views[0]).toEqual({ name: 'granularity', type: 'string', nullable: false, lock: '省略できると月次と年次が混ざるため、必須に固定しています', description: '粒度' });
    expect(views.find((view) => view.name === 'categories')).toEqual({ name: 'categories', type: 'string', nullable: true, description: '地域 の値' });
    expect(templateArgumentViews(LOCKED, FULL, 'en')[0]?.lock).toBe('Required: omitting it would mix monthly and annual rows');
  });

  it('境界: when で落ちる引数は返さない（カテゴリ列を選ぶと categories が現れる）', () => {
    expect(templateArgumentViews(LOCKED, { source: 'ds-wage' }, 'ja').map((view) => view.name)).not.toContain('categories');
    expect(templateArgumentViews(LOCKED, { source: 'ds-wage', categoryColumn: '地域' }, 'ja').map((view) => view.name)).toContain('categories');
  });

  it('境界: 説明文が参照するスロットがまだ選ばれていなければ、例外にせずスロットの表示名で埋める', () => {
    const pending = { ...LOCKED, arguments: [{ ...LOCKED.arguments[1]!, description: { ja: '{{periodColumn}} の開始', en: 'start of {{periodColumn}}' } }] };
    expect(templateArgumentViews(pending, { source: 'ds-wage' }, 'ja')[0]?.description).toBe('期間 の開始');
    expect(templateArgumentViews(pending, { source: 'ds-wage', periodColumn: '時点' }, 'en')[0]?.description).toBe('start of 時点');
  });
});

describe('withSlotDefaults / withPendingExpression', () => {
  it('正常: 既定を持つスロット（choice / number / text）は埋めなくても値が入る', () => {
    expect(withSlotDefaults(SINGLE, { source: 'ds-wage' })['limit']).toBe(20);
  });

  it('正常: 空文字・空配列は「未設定」として既定へ倒す', () => {
    expect(withSlotDefaults(SINGLE, { limit: undefined, valueColumns: [] })['valueColumns']).toBeUndefined();
  });

  it('正常: withPendingExpression が該当ノードの式だけを差し替え、pending から外す', () => {
    const intent = templateOf({
      formatVersion: 1, id: 'custom', version: '1.0.0',
      title: { ja: 'a', en: 'a' }, summary: { ja: 'a', en: 'a' }, whenToUse: { ja: ['a'], en: ['a'] }, tags: [],
      sources: { min: 1, max: 1 },
      slots: [
        { name: 'source', kind: 'dataSource', label: { ja: 'a', en: 'a' } },
        { name: 'intent', kind: 'intent', maxLength: 100, label: { ja: 'a', en: 'a' } },
      ],
      arguments: [],
      nodes: [
        { id: 'src', type: { $sourceType: 'source' }, config: { dataSourceId: { $slot: 'source' } } },
        { id: 'calc', type: 'calculate', config: { outputColumn: '計算値', expression: { $intent: 'intent' }, onError: 'null' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 5, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'calc' }, { from: 'calc', to: 'out' }],
      description: { ja: '{{intent}}', en: '{{intent}}' },
    });
    const instantiated = instantiateTemplate(intent, { source: 'ds-wage', intent: '値を 2 倍にする' }, CONTEXT, { toolName: 'c', language: 'ja' });
    expect(instantiated.pendingExpressions).toEqual([{ nodeId: 'calc', intent: '値を 2 倍にする' }]);
    expect(nodeById(instantiated.graph.nodes, 'calc').config['expression']).toBe('');

    const filled = withPendingExpression(instantiated, 'calc', '[値] * 2');
    expect(filled.pendingExpressions).toEqual([]);
    expect(nodeById(filled.graph.nodes, 'calc').config['expression']).toBe('[値] * 2');
    expect(nodeById(instantiated.graph.nodes, 'calc').config['expression']).toBe('');
  });
});
