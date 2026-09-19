/**
 * 関数電卓ノードをエンジンで一本通す（既定の登録簿 + 実 EtlEngine）。
 *
 * ノード単体のテストは `execute` を直接呼ぶので、登録簿とエンジンを経由したときに
 * 「スキーマ伝播で列が増える」「0 除算の行が落ちずに null になる」「上流に無い列の参照が
 * 実行前に error になる」ことは別に固定する必要がある。journey.e2e.test.ts と同じ置き場。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import type { ToolGraph } from '../../domain/etl/graph';
import { EtlEngine } from './engine';

const source = {
  id: 'rows', type: 'json-source',
  config: {
    rows: [{ amount: 1000, qty: 4 }, { amount: 250, qty: 0 }],
    schema: { columns: [{ name: 'amount', type: 'number', nullable: false }, { name: 'qty', type: 'number', nullable: false }] },
  },
} as const;

describe('calculate: エンジンで一本通す', () => {
  it('正常: json-source → calculate で式の結果が列として出て、0 除算の行は null で残る', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const graph: ToolGraph = {
      nodes: [
        source,
        { id: 'calc', type: 'calculate', config: { outputColumn: 'unit', expression: '[amount] / [qty]', precision: 2 } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 10, maxBytes: 4096, overflow: 'error' } },
      ],
      edges: [{ from: 'rows', to: 'calc' }, { from: 'calc', to: 'out' }],
    };
    const propagation = engine.propagateSchemas(graph);
    expect(propagation.hasErrors).toBe(false);
    expect(propagation.nodes['calc']?.schema.columns.map((column) => column.name)).toEqual(['amount', 'qty', 'unit']);

    const preview = engine.preview(graph);
    // 既定の onError は null: 0 除算の行を落とさない（cast の「変換不能 → null」と同じ規律）。
    expect(preview.fullOutput.rows.map((row) => row['unit'])).toEqual([250, null]);
  });

  it('異常: 上流に無い列を参照する式は、スキーマ伝播の段階で error になる（実行前に分かる）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const graph: ToolGraph = {
      nodes: [
        source,
        { id: 'calc', type: 'calculate', config: { outputColumn: 'x', expression: '[amount] * [rate]' } },
      ],
      edges: [{ from: 'rows', to: 'calc' }],
    };
    const propagation = engine.propagateSchemas(graph);
    expect(propagation.hasErrors).toBe(true);
    expect(propagation.nodes['calc']?.issues.some((issue) => issue.severity === 'error' && issue.message.includes('rate'))).toBe(true);
  });

  it('例外: onError を fail にすると、評価できない行で実行が止まり、行番号と式が理由に出る', () => {
    // 既定（null）との違いを実際のエンジン経由で固定する。1 行の 0 除算で止めたい利用者のための設定なので、
    // 「どの行のどの式か」が無いと直せない。
    const engine = new EtlEngine(createDefaultRegistry());
    const graph: ToolGraph = {
      nodes: [
        source,
        { id: 'calc', type: 'calculate', config: { outputColumn: 'unit', expression: '[amount] / [qty]', onError: 'fail' } },
      ],
      edges: [{ from: 'rows', to: 'calc' }],
    };
    // 2 行目が 0 除算。1 行目は通るので、止まる位置が行番号で分かることまで見る。
    expect(() => engine.preview(graph)).toThrow(/2/);
    expect(() => engine.preview(graph)).toThrow(/\[amount\] \/ \[qty\]/);
  });

  it('境界: 同名の出力列は末尾に足さず、その位置で number に置き換わる', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const graph: ToolGraph = {
      nodes: [
        source,
        { id: 'calc', type: 'calculate', config: { outputColumn: 'qty', expression: '[qty] * 2' } },
      ],
      edges: [{ from: 'rows', to: 'calc' }],
    };
    const propagation = engine.propagateSchemas(graph);
    expect(propagation.hasErrors).toBe(false);
    expect(propagation.nodes['calc']?.schema.columns.map((column) => column.name)).toEqual(['amount', 'qty']);
    expect(engine.preview(graph).fullOutput.rows.map((row) => row['qty'])).toEqual([8, 0]);
  });
});
