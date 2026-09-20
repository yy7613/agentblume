import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { diagnoseEmptyResult, MAX_AVAILABLE_VALUES, MAX_DIAGNOSIS_BYTES, MAX_VALUE_CHARS, noMatchText } from './empty-result-diagnosis';

/** 実測の再現: 都道府県 × 年次の統計表（時点は「2015年」までの粒度しか無い）。 */
const statsSchema: Schema = {
  columns: [
    { name: '地域', type: 'string', nullable: false },
    { name: '時点', type: 'string', nullable: false },
    { name: '人口', type: 'number', nullable: false },
  ],
};
const regions = ['東京都', '大阪府', '愛知県'];
const years = ['2014年', '2015年', '2016年'];
const statsTable: Table = {
  schema: statsSchema,
  rows: regions.flatMap((region) => years.map((year) => ({ 地域: region, 時点: year, 人口: 100 }))),
};

/** `csv → filter → out` の3ノード。filter の config と入出力テーブルだけを差し替えて使う。 */
function graphOf(filterConfig: unknown): ToolGraph {
  return {
    nodes: [
      { id: 'csv', type: 'csv-source', config: { text: '' } },
      { id: 'narrow', type: 'filter', config: filterConfig },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65_536, overflow: 'error' } },
    ],
    edges: [{ from: 'csv', to: 'narrow' }, { from: 'narrow', to: 'out' }],
  };
}

const EMPTY: Table = { schema: statsSchema, rows: [] };

function tablesOf(input: Table, output: Table = EMPTY): ReadonlyMap<string, Table> {
  return new Map([['csv', input], ['narrow', output], ['out', output]]);
}

describe('diagnoseEmptyResult: 0行の理由', () => {
  it('正常: 単独で0件の条件だけに実在値を添え、当たっている条件は件数だけを返す', () => {
    const graph = graphOf({
      conditions: [
        { column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent-input', field: 'region_name' } },
        { column: '時点', op: 'eq', value: '2015年12月31日', valueBinding: { source: 'agent-input', field: 'time_point' } },
      ],
      combine: 'and',
    });

    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.nodeId).toBe('narrow');
    expect(diagnosis?.combine).toBe('and');
    expect(diagnosis?.message).toContain('Do not answer from memory');
    expect(diagnosis?.conditions[0]).toEqual({ column: '地域', op: 'eq', argument: 'region_name', value: '東京都', matchingRows: 3 });
    expect(diagnosis?.conditions[1]).toEqual({
      column: '時点', op: 'eq', argument: 'time_point', value: '2015年12月31日', matchingRows: 0,
      // 要求値「2015年12月31日」に含まれる「2015年」が先頭に来る（残りは出現順）。
      availableValues: ['2015年', '2014年', '2016年'],
      distinctValues: 3,
    });
  });

  it('正常: 束縛されていない固定値の条件には argument を付けない', () => {
    const diagnosis = diagnoseEmptyResult({ graph: graphOf({ column: '時点', op: 'eq', value: '2015年12月31日' }), tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions).toHaveLength(1);
    expect(diagnosis?.conditions[0]?.argument).toBeUndefined();
    expect(diagnosis?.conditions[0]?.matchingRows).toBe(0);
  });

  it('境界: どの条件も単独では当たるのにANDで0件なら、組み合わせを咎めて全条件に実在値を添える', () => {
    const graph = graphOf({
      conditions: [
        { column: '地域', op: 'eq', value: '東京都' },
        { column: '時点', op: 'eq', value: '2014年' },
        { column: '人口', op: 'gt', value: 500 },
      ],
      combine: 'and',
    });
    // 「東京都 × 2014年」は在るが人口が 500 を超える行だけが無い、という組み合わせの失敗。
    const rows = statsTable.rows.map((row) => ({ ...row, 人口: row['地域'] === '東京都' ? 100 : 900 }));

    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf({ schema: statsSchema, rows }) });

    expect(diagnosis?.message).toContain('Each condition matches rows on its own');
    expect(diagnosis?.conditions.map((condition) => condition.matchingRows)).toEqual([3, 3, 6]);
    expect(diagnosis?.conditions[0]?.availableValues).toEqual(['東京都', '大阪府', '愛知県']);
    // 数値列は値の列挙ではなく最小・最大で示す。
    expect(diagnosis?.conditions[2]).toMatchObject({ min: 100, max: 900, distinctValues: 2 });
  });

  it('正常: OR結合でも各条件を単独で数え、combine をそのまま返す', () => {
    const graph = graphOf({
      conditions: [
        { column: '地域', op: 'eq', value: '北海道' },
        { column: '地域', op: 'eq', value: '沖縄県' },
      ],
      combine: 'or',
    });

    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.combine).toBe('or');
    expect(diagnosis?.conditions.map((condition) => condition.matchingRows)).toEqual([0, 0]);
    expect(diagnosis?.conditions[0]?.availableValues).toEqual(['東京都', '大阪府', '愛知県']);
  });

  it('境界: disabled の条件（nullable引数の省略）は診断からも外れる', () => {
    const graph = graphOf({
      conditions: [
        { column: '地域', op: 'eq', value: '東京都', disabled: true },
        { column: '時点', op: 'eq', value: '2015年12月31日' },
      ],
      combine: 'and',
    });

    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions.map((condition) => condition.column)).toEqual(['時点']);
  });

  it('境界: 日付列は最小・最大をISO文字列で返す（値の列挙はしない）', () => {
    const schema: Schema = { columns: [{ name: 'periodStart', type: 'date', nullable: false }] };
    const input: Table = { schema, rows: [
      { periodStart: new Date('2009-12-01T00:00:00.000Z') },
      { periodStart: new Date('2008-04-01T00:00:00.000Z') },
      { periodStart: new Date('2010-12-01T00:00:00.000Z') },
    ] };

    const diagnosis = diagnoseEmptyResult({ graph: graphOf({ column: 'periodStart', op: 'gte', value: '2011-01-01' }), tables: tablesOf(input) });

    expect(diagnosis?.conditions[0]).toEqual({
      column: 'periodStart', op: 'gte', value: '2011-01-01T00:00:00.000Z', matchingRows: 0,
      min: '2008-04-01T00:00:00.000Z', max: '2010-12-01T00:00:00.000Z', distinctValues: 3,
    });
  });

  it('境界: 値の例は8個・各80文字までに切り詰め、全体は1.5KB以内に収める', () => {
    const schema: Schema = { columns: [{ name: 'note', type: 'string', nullable: false }] };
    const input: Table = { schema, rows: Array.from({ length: 40 }, (_v, index) => ({ note: `${index}-${'あ'.repeat(200)}` })) };

    const diagnosis = diagnoseEmptyResult({ graph: graphOf({ column: 'note', op: 'eq', value: 'x' }), tables: tablesOf(input) });

    const values = diagnosis?.conditions[0]?.availableValues ?? [];
    expect(values.length).toBeLessThanOrEqual(MAX_AVAILABLE_VALUES);
    expect(values.every((value) => value.length <= MAX_VALUE_CHARS)).toBe(true);
    expect(diagnosis?.conditions[0]?.distinctValues).toBe(40);
    expect(new TextEncoder().encode(JSON.stringify(diagnosis)).byteLength).toBeLessThanOrEqual(MAX_DIAGNOSIS_BYTES);
  });

  it('境界: 条件が多すぎて上限に収まらないときは後ろの条件を落として返す', () => {
    const schema: Schema = { columns: [{ name: 'note', type: 'string', nullable: false }] };
    const column = 'note'.padEnd(120, '_');
    const wide: Schema = { columns: [{ name: column, type: 'string', nullable: false }] };
    const input: Table = { schema: wide, rows: [{ [column]: 'a' }] };
    const conditions = Array.from({ length: 40 }, () => ({ column, op: 'eq', value: 'x'.repeat(100) }));

    const diagnosis = diagnoseEmptyResult({ graph: graphOf({ conditions, combine: 'and' }), tables: tablesOf(input) });

    expect(diagnosis?.conditions.length).toBeLessThan(conditions.length);
    expect(diagnosis?.conditions.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(diagnosis)).byteLength).toBeLessThanOrEqual(MAX_DIAGNOSIS_BYTES);
    expect(schema.columns).toHaveLength(1); // 参照だけのスキーマは壊さない。
  });

  it('異常: 0行の原因が filter でなければ（上流がそもそも空）診断しない', () => {
    const diagnosis = diagnoseEmptyResult({ graph: graphOf({ column: '地域', op: 'eq', value: '東京都' }), tables: tablesOf(EMPTY) });

    expect(diagnosis).toBeUndefined();
  });

  it('異常: filter ノードが無いグラフでは診断しない', () => {
    const graph: ToolGraph = {
      nodes: [
        { id: 'csv', type: 'csv-source', config: { text: '' } },
        { id: 'top', type: 'limit', config: { count: 0 } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65_536, overflow: 'error' } },
      ],
      edges: [{ from: 'csv', to: 'top' }, { from: 'top', to: 'out' }],
    };

    expect(diagnoseEmptyResult({ graph, tables: new Map([['csv', statsTable], ['top', EMPTY], ['out', EMPTY]]) })).toBeUndefined();
  });

  it('例外: config が壊れていても投げずに undefined を返す（診断のために実行結果を落とさない）', () => {
    const diagnosis = diagnoseEmptyResult({ graph: graphOf({ column: '地域', op: 'between' }), tables: tablesOf(statsTable) });

    expect(diagnosis).toBeUndefined();
  });

  it('正常: 文章版は理由の1行目に続けて条件ごとの内訳を並べる（json以外の出力形式用）', () => {
    const diagnosis = diagnoseEmptyResult({
      graph: graphOf({ column: '時点', op: 'eq', value: '2015年12月31日', valueBinding: { source: 'agent-input', field: 'time_point' } }),
      tables: tablesOf(statsTable),
    });

    const rendered = noMatchText(diagnosis as NonNullable<typeof diagnosis>);

    expect(rendered.split('\n')[0]).toContain('No rows matched');
    expect(rendered).toContain('- 時点 eq "2015年12月31日" (argument time_point) matched 0 rows');
    expect(rendered).toContain('2015年');
  });
});

describe('diagnoseEmptyResult: 複数値条件（in）', () => {
  it('正常: 要求した値の並びと、そのうち1行も当たらなかった値を返す', () => {
    const graph = graphOf({
      column: '地域', op: 'in', values: ['東京都', '存在しない県'],
      valueBinding: { source: 'agent-input', field: 'regions' },
    });
    // 東京都は当たるが、条件を通った行が下流で消えた想定（この条件は単独で 3 行に当たる）。
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions[0]).toMatchObject({
      column: '地域', op: 'in', argument: 'regions',
      values: ['東京都', '存在しない県'],
      matchingRows: 3,
      unmatchedValues: ['存在しない県'],
    });
  });

  it('正常: どれも当たらないときは全要求値を unmatchedValues に並べ、近い実在値を先に薦める', () => {
    const graph = graphOf({ column: '地域', op: 'in', values: ['東京市', '大阪市'] });
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    const condition = diagnosis?.conditions[0];
    expect(condition?.matchingRows).toBe(0);
    expect(condition?.unmatchedValues).toEqual(['東京市', '大阪市']);
    expect(condition?.availableValues?.slice(0, 2)).toEqual(['東京都', '大阪府']);
    expect(condition?.distinctValues).toBe(3);
  });

  it('境界: notIn には unmatchedValues を付けない（除外した値に「空振り」は無い）', () => {
    const graph = graphOf({ column: '地域', op: 'notIn', values: ['東京都', '大阪府', '愛知県'] });
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions[0]).toMatchObject({ op: 'notIn', matchingRows: 0, values: ['東京都', '大阪府', '愛知県'] });
    expect(diagnosis?.conditions[0]?.unmatchedValues).toBeUndefined();
    expect(diagnosis?.conditions[0]?.availableValues).toBeDefined();
  });

  it('境界: 要求値・空振りした値も8件までに切り詰める', () => {
    const many = Array.from({ length: 20 }, (_, index) => `県${index}`);
    const graph = graphOf({ column: '地域', op: 'in', values: many });
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions[0]?.values).toHaveLength(MAX_AVAILABLE_VALUES);
    expect(diagnosis?.conditions[0]?.unmatchedValues).toHaveLength(MAX_AVAILABLE_VALUES);
    expect(new TextEncoder().encode(JSON.stringify(diagnosis)).byteLength).toBeLessThanOrEqual(MAX_DIAGNOSIS_BYTES);
  });

  it('境界: 長い値は実在値と同じく80文字までに切り詰める', () => {
    const long = 'あ'.repeat(200);
    const graph = graphOf({ column: '地域', op: 'in', values: [long] });
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions[0]?.unmatchedValues?.[0]).toHaveLength(MAX_VALUE_CHARS);
  });

  it('正常: 文章版は要求した並びと「どの値が空振りしたか」を1行に書く', () => {
    const graph = graphOf({ column: '地域', op: 'in', values: ['東京市'], valueBinding: { source: 'agent-input', field: 'regions' } });
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });
    const rendered = noMatchText(diagnosis as NonNullable<typeof diagnosis>);

    expect(rendered).toContain('地域 in ["東京市"] (argument regions) matched 0 rows');
    expect(rendered).toContain('no rows for: 東京市');
    expect(rendered).toContain('values in this column include: 東京都');
  });

  it('境界: 従来どおり — 単値条件の行には値の並びを足さない', () => {
    const graph = graphOf({ column: '地域', op: 'eq', value: '東京市' });
    const diagnosis = diagnoseEmptyResult({ graph, tables: tablesOf(statsTable) });

    expect(diagnosis?.conditions[0]?.values).toBeUndefined();
    expect(diagnosis?.conditions[0]?.unmatchedValues).toBeUndefined();
    expect(noMatchText(diagnosis as NonNullable<typeof diagnosis>)).toContain('地域 eq "東京市"');
  });
});
