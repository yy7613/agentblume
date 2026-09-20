/**
 * 期間の解釈ノードをエンジンで一本通す（既定の登録簿 + 実 EtlEngine）。
 *
 * 政府統計（e-Stat）の CSV そのままの形—1 つの `時点` 列に月・四半期・暦年・年度が混ざる—から、
 * 「月の行だけを 2008〜2010 年で取り出して古い順に並べる」という実務の一本道を固定する:
 * `csv-source` → `parse-period` → `filter periodGranularity eq month`
 * → `filter periodStart gte/lte` → `sort periodStart` → `agent-output`。
 *
 * ここで一緒に固定する大事な点: **日付の範囲指定は `Date` でも ISO 文字列でも同じ結果になる**。
 * 保存済み Tool の config は JSON なので `Date` リテラルを持てず、Agent Tool の引数も文字列で届く。
 * `filter` は日付列に来た `'2008-01-01'` のような ISO 文字列を Date へ寄せてから比べる
 * （かつてはここが NaN 比較になり、エラーも出さずに 0 行だった）。読めない文字列は SchemaError。
 * 領域層のテスト（domain/etl/nodes/parse-period.test.ts）からは応用層の Engine を読み込めないため、
 * 一本通す確認は calculate.e2e.test.ts と同じくここに置く。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import type { ToolGraph } from '../../domain/etl/graph';
import { EtlEngine } from './engine';

/** e-Stat の「時点」列を模した CSV（粒度が 1 列に混ざる。順序もばらばら）。 */
const CSV = [
  '時点,値',
  '2009年,4000',           // 暦年（月ではないので落ちる）
  '2010年3月,310',
  '2008年1-3月期,800',      // 四半期（落ちる）
  '2009年12月,212',
  '2007年12月,112',        // 期間外（落ちる）
  '平成20年4月,104',        // 和暦の月 = 2008年4月（残る）
  '2010年度,5000',          // 年度（落ちる）
  '2011年1月,301',         // 期間外（落ちる）
  '2010年12月,312',
  '全国,0',                // 読めないラベル（落ちる）
].join('\n');

function buildGraph(): ToolGraph {
  return {
    nodes: [
      { id: 'csv', type: 'csv-source', config: { text: CSV, delimiter: ',', header: true, inferTypes: true } },
      { id: 'period', type: 'parse-period', config: { column: '時点' } },
      { id: 'monthly', type: 'filter', config: { column: 'periodGranularity', op: 'eq', value: 'month' } },
      {
        id: 'range', type: 'filter',
        config: {
          combine: 'and',
          conditions: [
            // 設計時に Date で書いた場合（UI から保存すると ISO 文字列になる。下のテストで同値を固定する）。
            { column: 'periodStart', op: 'gte', value: new Date('2008-01-01T00:00:00.000Z') },
            { column: 'periodStart', op: 'lte', value: new Date('2010-12-31T00:00:00.000Z') },
          ],
        },
      },
      { id: 'sorted', type: 'sort', config: { keys: [{ column: 'periodStart', direction: 'asc' }] } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [
      { from: 'csv', to: 'period' },
      { from: 'period', to: 'monthly' },
      { from: 'monthly', to: 'range' },
      { from: 'range', to: 'sorted' },
      { from: 'sorted', to: 'out' },
    ],
  };
}

describe('parse-period: エンジンで一本通す', () => {
  it('正常: スキーマ伝播で開始日(date)と粒度(string)の列が増え、エラーは出ない', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const propagation = engine.propagateSchemas(buildGraph());

    expect(propagation.hasErrors).toBe(false);
    expect(propagation.nodes['period']?.schema.columns).toEqual([
      { name: '時点', type: 'string', nullable: false },
      { name: '値', type: 'number', nullable: false },
      { name: 'periodStart', type: 'date', nullable: true },
      { name: 'periodGranularity', type: 'string', nullable: false },
    ]);
    // 日付列になったからこそ、下流の gte/lte（number|date 必須）が通る。
    expect(propagation.nodes['range']?.issues).toEqual([]);
  });

  it('正常: 月の行だけを 2008〜2010 年で取り出し、開始日の古い順に並べる（和暦の行も混ざる）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { fullOutput } = engine.preview(buildGraph());

    expect(fullOutput.rows.map((row) => row['時点'])).toEqual(['平成20年4月', '2009年12月', '2010年3月', '2010年12月']);
    expect(fullOutput.rows.map((row) => (row['periodStart'] as Date).toISOString())).toEqual([
      '2008-04-01T00:00:00.000Z',
      '2009-12-01T00:00:00.000Z',
      '2010-03-01T00:00:00.000Z',
      '2010-12-01T00:00:00.000Z',
    ]);
    expect(fullOutput.rows.map((row) => row['値'])).toEqual([104, 212, 310, 312]);
  });

  it('境界: 粒度で絞らないと、暦年・年度・四半期の行が月の行に混ざったまま残る（この節の存在理由）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const graph = buildGraph();
    // `monthly` を素通し（常に真の条件）にして、粒度の選別だけを外す。
    const withoutGranularity: ToolGraph = {
      nodes: graph.nodes.map((node) => node.id === 'monthly' ? { ...node, config: { column: 'periodGranularity', op: 'notNull' } } : node),
      edges: graph.edges,
    };
    const { fullOutput } = new EtlEngine(createDefaultRegistry()).preview(withoutGranularity);

    // 四半期・暦年・年度の行が月の行と同じ表に並んでしまう（合計すれば二重計上になる）。
    expect(fullOutput.rows.map((row) => row['時点'])).toEqual([
      '2008年1-3月期', '平成20年4月', '2009年', '2009年12月', '2010年3月', '2010年度', '2010年12月',
    ]);
    // 粒度で絞れば月の 4 行だけになる。
    expect(engine.preview(graph).fullOutput.rows).toHaveLength(4);
  });

  /** `range` の2条件を差し替えたグラフ（JSON で保存される形＝文字列の値を試すため）。 */
  function withRangeValues(low: unknown, high: unknown): ToolGraph {
    const graph = buildGraph();
    return {
      nodes: graph.nodes.map((node) => node.id === 'range'
        ? {
            ...node,
            config: {
              combine: 'and',
              conditions: [
                { column: 'periodStart', op: 'gte', value: low },
                { column: 'periodStart', op: 'lte', value: high },
              ],
            },
          }
        : node),
      edges: graph.edges,
    };
  }

  it('正常: 日付の範囲指定を ISO 文字列で書いても Date と同じ 4 行が残る（保存済み config は JSON）', () => {
    const engine = new EtlEngine(createDefaultRegistry());

    const { fullOutput } = engine.preview(withRangeValues('2008-01-01', '2010-12-31'));

    // 修正前はここが NaN 比較になり、エラーも出さずに 0 行だった。
    expect(fullOutput.rows.map((row) => row['時点'])).toEqual(['平成20年4月', '2009年12月', '2010年3月', '2010年12月']);
    expect(engine.propagateSchemas(withRangeValues('2008-01-01', '2010-12-31')).hasErrors).toBe(false);
  });

  it('異常: 日付として読めない文字列は 0 行ではなく ETL_SCHEMA エラーになる（直し方が分かる）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const broken = withRangeValues('2008/01/01', '2010-12-31');

    expect(() => engine.preview(broken)).toThrowError(/^filter: value for date column 'periodStart' must be an ISO date \(YYYY-MM-DD\): 2008\/01\/01$/);
    // 実行前にスキーマ伝播でも同じ理由が分かる。
    const propagation = engine.propagateSchemas(broken);
    expect(propagation.hasErrors).toBe(true);
    expect(propagation.nodes['range']?.issues.map((issue) => issue.message)).toContain("filter: value for date column 'periodStart' must be an ISO date (YYYY-MM-DD): 2008/01/01");
  });

  it('異常: 上流に無い列を指定すると、スキーマ伝播の段階で error になる（実行前に分かる）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const graph = buildGraph();
    const broken: ToolGraph = {
      nodes: graph.nodes.map((node) => node.id === 'period' ? { ...node, config: { column: '年月' } } : node),
      edges: graph.edges,
    };
    const propagation = engine.propagateSchemas(broken);

    expect(propagation.hasErrors).toBe(true);
    expect(propagation.nodes['period']?.issues.map((issue) => issue.message)).toContain('parse-period: column not found: 年月');
  });
});
