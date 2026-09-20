/**
 * 複数値フィルタ（`in` / `notIn`）の E2E テスト。
 *
 * 実ノード（createDefaultRegistry）と実 EtlEngine で、実測の事故そのものを流す:
 * 都道府県 × 年の統計表から「東京都・大阪府・北海道」を**1つの filter ノードで**取り出し、
 * 集計まで通す。単値演算子しか無かった頃は、この絞り込みが県ごとの複数ノード（または
 * 複数のツール呼び出し）に分かれていた。
 *
 * 検証観点:
 * - propagateSchemas: `in` はスキーマを変えない（列も nullable も素通し）。設計時の型検証は
 *   値の並びの要素にも効く（日付・数値として読めない要素は error issue）。
 * - preview: CSV から読んだ実データに対して行が正しく残る。日付列・数値列の並びも効く。
 * - 実行時に引数から届いた形（値の並びが差し替わった config）でも同じ結果になる。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import type { ToolGraph } from '../../domain/etl/graph';
import { EtlEngine } from './engine';

/** 地域(string) / 年(date) / 人口(number) の統計表。CSV から読むので型は推論させる。 */
const CSV = [
  '地域,年,人口',
  '東京都,2015-01-01,1400',
  '大阪府,2015-01-01,880',
  '北海道,2015-01-01,520',
  '沖縄県,2015-01-01,150',
  '東京都,2016-01-01,1410',
  '大阪府,2016-01-01,875',
  '北海道,2016-01-01,515',
  '沖縄県,2016-01-01,152',
].join('\n');

function buildGraph(filterConfig: unknown): ToolGraph {
  return {
    nodes: [
      { id: 'csv', type: 'csv-source', config: { text: `${CSV}\n`, delimiter: ',', header: true, inferTypes: true } },
      { id: 'narrow', type: 'filter', config: filterConfig },
      { id: 'total', type: 'group-by', config: { groupBy: ['地域'], aggregates: [{ op: 'sum', column: '人口', as: '合計' }] } },
    ],
    edges: [{ from: 'csv', to: 'narrow' }, { from: 'narrow', to: 'total' }],
  };
}

const engine = (): EtlEngine => new EtlEngine(createDefaultRegistry());

describe('複数値フィルタ E2E — in で3県を1ノードで取り出す', () => {
  const graph = buildGraph({ column: '地域', op: 'in', values: ['東京都', '大阪府', '北海道'] });

  it('正常: スキーマはそのまま伝播し、issue も出ない', () => {
    const result = engine().propagateSchemas(graph);
    expect(result.hasErrors).toBe(false);
    expect(result.nodes['narrow']?.issues).toEqual([]);
    expect(result.nodes['narrow']?.schema.columns.map((column) => column.name)).toEqual(['地域', '年', '人口']);
  });

  it('正常: 3県 × 2年 = 6行に絞り込み、県ごとの合計まで通る', () => {
    const { nodes, output, terminalId } = engine().preview(graph);
    expect(terminalId).toBe('total');
    expect(nodes['narrow']?.table.rows).toHaveLength(6);
    expect(output.rows).toEqual([
      { 地域: '東京都', 合計: 2810 },
      { 地域: '大阪府', 合計: 1755 },
      { 地域: '北海道', 合計: 1035 },
    ]);
  });

  it('正常: notIn は列挙した県だけを落とす（in の補集合）', () => {
    const { output } = engine().preview(buildGraph({ column: '地域', op: 'notIn', values: ['東京都', '大阪府', '北海道'] }));
    expect(output.rows).toEqual([{ 地域: '沖縄県', 合計: 302 }]);
  });

  it('正常: 日付列・数値列の並びも ISO 文字列 / 数値文字列のまま効く', () => {
    const byYear = engine().preview(buildGraph({ column: '年', op: 'in', values: ['2016-01-01'] }));
    expect(byYear.output.rows).toHaveLength(4);
    const byPopulation = engine().preview(buildGraph({ column: '人口', op: 'in', values: ['1400', '150'] }));
    expect(byPopulation.output.rows).toEqual([{ 地域: '東京都', 合計: 1400 }, { 地域: '沖縄県', 合計: 150 }]);
  });

  it('正常: 実行時に引数から値の並びが差し替わった形でも同じ行になる', () => {
    // graphWithArguments が作るのと同じ形（設計時サンプルが実引数由来の並びへ置き換わり、binding は残る）。
    const bound = buildGraph({
      column: '地域', op: 'in', values: ['東京都', '大阪府', '北海道'],
      valueBinding: { source: 'agent-input', field: 'regions' },
    });
    expect(engine().preview(bound).output.rows).toEqual(engine().preview(graph).output.rows);
  });

  it('境界: 他の条件と AND で組める（3県かつ2016年）', () => {
    const { output } = engine().preview(buildGraph({
      conditions: [
        { column: '地域', op: 'in', values: ['東京都', '大阪府', '北海道'] },
        { column: '年', op: 'gte', value: '2016-01-01' },
      ],
      combine: 'and',
    }));
    expect(output.rows).toEqual([
      { 地域: '東京都', 合計: 1410 },
      { 地域: '大阪府', 合計: 875 },
      { 地域: '北海道', 合計: 515 },
    ]);
  });

  it('異常: 日付列の並びに読めない要素があれば、伝播が error issue で止まる（黙って0行にしない）', () => {
    const result = engine().propagateSchemas(buildGraph({ column: '年', op: 'in', values: ['2016/01/01'] }));
    expect(result.hasErrors).toBe(true);
    expect(result.nodes['narrow']?.issues).toEqual([
      { severity: 'error', message: "filter: values for date column '年' must be ISO dates (YYYY-MM-DD): 2016/01/01", column: '年' },
    ]);
  });

  it('異常: 値が空の in は伝播が error issue にし、実行すれば例外で止まる', () => {
    const empty = buildGraph({ column: '地域', op: 'in', values: [] });
    expect(engine().propagateSchemas(empty).hasErrors).toBe(true);
    expect(() => engine().preview(empty)).toThrowError(/requires a non-empty 'values' list for column '地域'/);
  });
});
