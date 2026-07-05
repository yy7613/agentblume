/**
 * v15 変換ノード E2E テスト（実装契約 §4）。
 *
 * 実ノード（createDefaultRegistry）と実 EtlEngine で、v15 の 6 ノードを通す:
 * - フロー1: A join B（left） → sort → distinct → fill-null → replace → 出力検証
 * - フロー2: A union B → 出力検証
 *
 * 2入力ノード（join / union）へのエッジは `toInput: 0`（左/上）と
 * `toInput: 1`（右/下）を明示する。
 *
 * 検証観点:
 * - propagateSchemas: join での列合成（右キー列の除外・nullable 規則）、
 *   fill-null での nullable:false 化、union での列和集合。source 起点のため
 *   final state は全ノード 'inferred'。
 * - preview: null キーの不マッチ、安定ソート順、重複排除（最初行保持）、
 *   null 埋め、厳密等価置換が最終出力に反映されること。
 */
import { describe, expect, it } from 'vitest';
import type { Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { EtlEngine } from './engine';
import type { ToolGraph } from '../../domain/etl/graph';

/** 列名の配列（宣言順）。 */
function namesOf(schema: Schema): string[] {
  return schema.columns.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// フロー1: A join B → sort → distinct → fill-null → replace
// ---------------------------------------------------------------------------

/**
 * 社員（A・左） × 部署（B・右）の left join を起点に、v15 の 1入力ノード4種を
 * 直列に通すグラフ。
 * - Bob は dept:null（null キー → マッチせず left join で残る）。
 * - id:1 の Alice は完全重複行を持つ（distinct で1行に）。
 */
function buildJoinFlow(): ToolGraph {
  return {
    nodes: [
      {
        id: 'a',
        type: 'json-source',
        config: {
          rows: [
            { id: 3, name: 'Carol', dept: 'eng' },
            { id: 1, name: 'Alice', dept: 'eng' },
            { id: 2, name: 'Bob', dept: null },
            { id: 1, name: 'Alice', dept: 'eng' }, // 完全重複（distinct で除去）
            { id: 5, name: 'Alice', dept: 'hr' },
          ],
        },
      },
      {
        id: 'b',
        type: 'json-source',
        config: {
          rows: [
            { dept: 'eng', deptName: 'Engineering' },
            { dept: 'hr', deptName: 'HR' },
          ],
        },
      },
      {
        id: 'join',
        type: 'join',
        config: { mode: 'left', keys: [{ left: 'dept', right: 'dept' }] },
      },
      { id: 'sort', type: 'sort', config: { keys: [{ column: 'name' }] } },
      { id: 'distinct', type: 'distinct', config: {} },
      {
        id: 'fill',
        type: 'fill-null',
        config: { rules: [{ column: 'deptName', strategy: 'constant', value: 'Unassigned' }] },
      },
      {
        id: 'replace',
        type: 'replace',
        config: { rules: [{ column: 'deptName', from: 'Engineering', to: 'ENG' }] },
      },
    ],
    edges: [
      { from: 'a', to: 'join', toInput: 0 },
      { from: 'b', to: 'join', toInput: 1 },
      { from: 'join', to: 'sort' },
      { from: 'sort', to: 'distinct' },
      { from: 'distinct', to: 'fill' },
      { from: 'fill', to: 'replace' },
    ],
  };
}

describe('v15 変換 E2E — join フロー propagateSchemas', () => {
  it('エラーなく全ノードのスキーマが伝播する', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const result = engine.propagateSchemas(buildJoinFlow());
    expect(result.hasErrors).toBe(false);
    expect(result.order).toEqual(['a', 'b', 'join', 'sort', 'distinct', 'fill', 'replace']);
  });

  it('join が右キー列を除いた列合成をし、left join で右由来列を nullable にする', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJoinFlow());
    const join = nodes['join'];
    expect(join).toBeDefined();
    // 右のキー列 dept は出力から除かれ、deptName だけが付く。
    expect(namesOf(join!.schema)).toEqual(['id', 'name', 'dept', 'deptName']);
    // left join: 右由来の deptName は nullable:true、左由来はそのまま。
    expect(join!.schema.columns.find((c) => c.name === 'deptName')?.nullable).toBe(true);
    expect(join!.schema.columns.find((c) => c.name === 'id')?.nullable).toBe(false);
  });

  it('sort / distinct はスキーマ不変、fill-null が deptName を nullable:false にする', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJoinFlow());
    expect(namesOf(nodes['sort']!.schema)).toEqual(['id', 'name', 'dept', 'deptName']);
    expect(namesOf(nodes['distinct']!.schema)).toEqual(['id', 'name', 'dept', 'deptName']);

    const fill = nodes['fill'];
    expect(fill!.schema.columns.find((c) => c.name === 'deptName')).toEqual({
      name: 'deptName',
      type: 'string',
      nullable: false,
    });
    // 同型置換なので replace で warning は出ない。
    expect(nodes['replace']!.issues).toEqual([]);
  });

  it('source 起点のため final state は全ノード inferred', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes, order } = engine.propagateSchemas(buildJoinFlow());
    for (const id of order) {
      expect(nodes[id]?.state).toBe('inferred');
    }
  });
});

describe('v15 変換 E2E — join フロー preview', () => {
  it('最終出力が join → sort → distinct → fill-null → replace の全変換を反映する', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { output, terminalId } = engine.preview(buildJoinFlow());
    expect(terminalId).toBe('replace');
    expect(output.rows).toEqual([
      { id: 1, name: 'Alice', dept: 'eng', deptName: 'ENG' },
      { id: 5, name: 'Alice', dept: 'hr', deptName: 'HR' },
      { id: 2, name: 'Bob', dept: null, deptName: 'Unassigned' },
      { id: 3, name: 'Carol', dept: 'eng', deptName: 'ENG' },
    ]);
  });

  it('中間ノードの出力も各段の変換を反映する', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.preview(buildJoinFlow());

    // join: 左5行がそのまま残る（null キーの Bob は無マッチだが left join で保持）。
    const joinRows = nodes['join']?.table.rows;
    expect(joinRows).toHaveLength(5);
    expect(joinRows?.find((r) => r['name'] === 'Bob')?.['deptName']).toBeNull();
    expect(joinRows?.find((r) => r['id'] === 5)?.['deptName']).toBe('HR');

    // sort: name 昇順（安定: 同名 Alice は元の相対順 id 1 → 1 → 5）。
    expect(nodes['sort']?.table.rows.map((r) => r['name'])).toEqual([
      'Alice',
      'Alice',
      'Alice',
      'Bob',
      'Carol',
    ]);
    expect(nodes['sort']?.table.rows.map((r) => r['id'])).toEqual([1, 1, 5, 2, 3]);

    // distinct: 完全重複の Alice(id:1) が1行になる。
    expect(nodes['distinct']?.table.rows).toHaveLength(4);

    // fill-null: Bob の deptName が埋まる。
    expect(
      nodes['fill']?.table.rows.find((r) => r['name'] === 'Bob')?.['deptName'],
    ).toBe('Unassigned');
  });
});

// ---------------------------------------------------------------------------
// フロー2: A union B
// ---------------------------------------------------------------------------

/** 列が部分的に重なる2ソースの非 strict union。 */
function buildUnionFlow(): ToolGraph {
  return {
    nodes: [
      {
        id: 'a',
        type: 'json-source',
        config: {
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        },
      },
      {
        id: 'b',
        type: 'json-source',
        config: {
          rows: [{ name: 'Carol', score: 80 }],
        },
      },
      { id: 'union', type: 'union', config: { strict: false } },
    ],
    edges: [
      { from: 'a', to: 'union', toInput: 0 },
      { from: 'b', to: 'union', toInput: 1 },
    ],
  };
}

describe('v15 変換 E2E — union フロー', () => {
  it('propagateSchemas: 列和集合（左列順 → 右専用列）と nullable 規則', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const result = engine.propagateSchemas(buildUnionFlow());
    expect(result.hasErrors).toBe(false);

    const union = result.nodes['union'];
    expect(union).toBeDefined();
    expect(namesOf(union!.schema)).toEqual(['id', 'name', 'score']);
    // 片側にしかない列は nullable:true、共通列 name は両側非nullなのでそのまま。
    const byName = new Map(union!.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(true);
    expect(byName.get('score')?.nullable).toBe(true);
    expect(byName.get('name')?.nullable).toBe(false);
    expect(union!.state).toBe('inferred');
  });

  it('preview: input0 の行 → input1 の行の順で、欠損列は null', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { output, terminalId } = engine.preview(buildUnionFlow());
    expect(terminalId).toBe('union');
    expect(output.rows).toEqual([
      { id: 1, name: 'Alice', score: null },
      { id: 2, name: 'Bob', score: null },
      { id: null, name: 'Carol', score: 80 },
    ]);
  });
});
