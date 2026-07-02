/**
 * v1 ジャーニー E2E テスト（実装契約 §12 / README §7）。
 *
 * 実ノード（createDefaultRegistry の 6 ノード）と実 EtlEngine を用いて、
 * README §7 の代表ジャーニーを一本通す:
 *   csv-source → select → filter(age gte 18) → rename(name→displayName) → cast(age→string)
 *
 * 検証観点:
 * - propagateSchemas: 各ノードのスキーマ変化（列の増減・改名・型変化）と最終 state。
 *   source 起点のため上流合成後は全ノードが 'inferred'（csv-source が inferred で
 *   最悪 rank を支配するため）。
 * - preview: 最終 output の行数・値・型（filter で除外される行 / rename された列名 /
 *   cast された型）。
 * - negative: 存在しない列を select → hasErrors=true かつ当該ノード state='mismatch'。
 * - rowLimit: 超過時に truncated=true。
 */
import { describe, expect, it } from 'vitest';
import type { DataType, Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { EtlEngine } from './engine';
import type { ToolGraph } from '../../domain/etl/graph';

// ---------------------------------------------------------------------------
// 共通のサンプル / ヘルパ
// ---------------------------------------------------------------------------

/**
 * README §7 相当のサンプル CSV。
 * 複数型（number / string / boolean / date）を含む 4 行。
 * age gte 18 のフィルタで Alice(30), Carol(25) が残り、Bob(17), Dave(15) が除外される。
 */
const SAMPLE_CSV = [
  'id,name,age,active,joined',
  '1,Alice,30,true,2020-01-15',
  '2,Bob,17,false,2021-06-01',
  '3,Carol,25,true,2019-11-30',
  '4,Dave,15,true,2022-03-22',
].join('\n');

/** スキーマを {列名: 型} のマップに畳む（アサートしやすくするため）。 */
function typesOf(schema: Schema): Record<string, DataType> {
  const out: Record<string, DataType> = {};
  for (const c of schema.columns) out[c.name] = c.type;
  return out;
}

/** 列名の配列（宣言順）。 */
function namesOf(schema: Schema): string[] {
  return schema.columns.map((c) => c.name);
}

/** README §7 のジャーニーを表す ToolGraph を組む。 */
function buildJourney(): ToolGraph {
  return {
    nodes: [
      { id: 'src', type: 'csv-source', config: { text: SAMPLE_CSV } },
      { id: 'sel', type: 'select', config: { columns: ['id', 'name', 'age', 'active'] } },
      { id: 'flt', type: 'filter', config: { column: 'age', op: 'gte', value: 18 } },
      { id: 'ren', type: 'rename', config: { renames: [{ from: 'name', to: 'displayName' }] } },
      { id: 'cst', type: 'cast', config: { casts: [{ column: 'age', to: 'string' }] } },
    ],
    edges: [
      { from: 'src', to: 'sel' },
      { from: 'sel', to: 'flt' },
      { from: 'flt', to: 'ren' },
      { from: 'ren', to: 'cst' },
    ],
  };
}

// ---------------------------------------------------------------------------
// propagateSchemas: スキーマ変化と最終 state
// ---------------------------------------------------------------------------

describe('v1 ジャーニー E2E — propagateSchemas', () => {
  it('トポロジカル順が csv-source → select → filter → rename → cast になる', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const result = engine.propagateSchemas(buildJourney());
    expect(result.order).toEqual(['src', 'sel', 'flt', 'ren', 'cst']);
    expect(result.hasErrors).toBe(false);
  });

  it('csv-source が全 5 列を推論し、型と state=inferred を確定する', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJourney());
    const src = nodes['src'];
    expect(src).toBeDefined();
    // id/name/age/active/joined の 5 列を初出順で推論。
    expect(namesOf(src!.schema)).toEqual(['id', 'name', 'age', 'active', 'joined']);
    expect(typesOf(src!.schema)).toEqual({
      id: 'number',
      name: 'string',
      age: 'number',
      active: 'boolean',
      joined: 'date',
    });
    // source は inferred。局所 state も上流合成後も inferred。
    expect(src!.state).toBe('inferred');
    expect(src!.issues).toEqual([]);
  });

  it('select が列を 5→4 に減らす（joined を落とす）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJourney());
    const sel = nodes['sel'];
    expect(sel).toBeDefined();
    expect(namesOf(sel!.schema)).toEqual(['id', 'name', 'age', 'active']);
    // 局所は confirmed だが、上流 inferred と合成され最終 state は inferred。
    expect(sel!.state).toBe('inferred');
    expect(sel!.issues).toEqual([]);
  });

  it('filter は列を変えず（4 列のまま）、型もそのまま', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJourney());
    const flt = nodes['flt'];
    expect(flt).toBeDefined();
    expect(namesOf(flt!.schema)).toEqual(['id', 'name', 'age', 'active']);
    expect(typesOf(flt!.schema)).toEqual({
      id: 'number',
      name: 'string',
      age: 'number',
      active: 'boolean',
    });
    expect(flt!.state).toBe('inferred');
  });

  it('rename が name→displayName に改名する（順序保持・型保持）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJourney());
    const ren = nodes['ren'];
    expect(ren).toBeDefined();
    // name の位置に displayName が入る（順序保持）。
    expect(namesOf(ren!.schema)).toEqual(['id', 'displayName', 'age', 'active']);
    // displayName の型は改名前 name と同じ string を保持。
    expect(typesOf(ren!.schema)).toEqual({
      id: 'number',
      displayName: 'string',
      age: 'number',
      active: 'boolean',
    });
    expect(ren!.state).toBe('inferred');
  });

  it('cast が age を number→string に変化させ、nullable を立てる', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildJourney());
    const cst = nodes['cst'];
    expect(cst).toBeDefined();
    expect(namesOf(cst!.schema)).toEqual(['id', 'displayName', 'age', 'active']);
    // age だけが string に変わる。
    expect(typesOf(cst!.schema)).toEqual({
      id: 'number',
      displayName: 'string',
      age: 'string',
      active: 'boolean',
    });
    // cast 対象列は変換失敗の可能性から nullable:true。
    const ageCol = cst!.schema.columns.find((c) => c.name === 'age');
    expect(ageCol?.nullable).toBe(true);
    // number→string はサポート済みなので warning なし。
    expect(cst!.issues).toEqual([]);
    // 最終端も inferred（source 起点の伝播）。
    expect(cst!.state).toBe('inferred');
  });

  it('ジャーニー全体を通して final state はすべて inferred（source 起点）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes, order } = engine.propagateSchemas(buildJourney());
    for (const id of order) {
      expect(nodes[id]?.state).toBe('inferred');
    }
  });
});

// ---------------------------------------------------------------------------
// preview: 最終出力の行数・値・型
// ---------------------------------------------------------------------------

describe('v1 ジャーニー E2E — preview', () => {
  it('最終 output は filter で 2 行に絞られる（age>=18 の Alice/Carol）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { output, terminalId } = engine.preview(buildJourney());
    expect(terminalId).toBe('cst');
    expect(output.rows).toHaveLength(2);
    // rename 後の列名 displayName で氏名が取れる。順序は入力順（Alice, Carol）。
    const names = output.rows.map((r) => r['displayName']);
    expect(names).toEqual(['Alice', 'Carol']);
    // Bob(17)/Dave(15) は除外されている。
    expect(names).not.toContain('Bob');
    expect(names).not.toContain('Dave');
  });

  it('最終 output のスキーマは rename+cast を反映（displayName / age:string）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { output } = engine.preview(buildJourney());
    expect(namesOf(output.schema)).toEqual(['id', 'displayName', 'age', 'active']);
    expect(typesOf(output.schema)).toEqual({
      id: 'number',
      displayName: 'string',
      age: 'string',
      active: 'boolean',
    });
  });

  it('cast により age セルの実値が文字列になる', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { output } = engine.preview(buildJourney());
    const first = output.rows[0];
    expect(first).toBeDefined();
    // Alice の age=30 が "30"（string）に。
    expect(first!['age']).toBe('30');
    expect(typeof first!['age']).toBe('string');
    // 改名されていない列は型が保たれる。
    expect(typeof first!['id']).toBe('number');
    expect(typeof first!['active']).toBe('boolean');
    // 元の列名 name / joined は最終出力に存在しない。
    expect(Object.prototype.hasOwnProperty.call(first!, 'name')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(first!, 'joined')).toBe(false);
  });

  it('中間ノードの出力も各段の変換を反映する', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.preview(buildJourney());
    // source は 4 行すべて。
    expect(nodes['src']?.table.rows).toHaveLength(4);
    // select 後も 4 行（列だけ 4 に減る）。
    expect(nodes['sel']?.table.rows).toHaveLength(4);
    expect(namesOf(nodes['sel']!.table.schema)).toEqual(['id', 'name', 'age', 'active']);
    // filter 後は 2 行。
    expect(nodes['flt']?.table.rows).toHaveLength(2);
    // 各段で truncated は立たない（rowLimit 既定 100）。
    expect(nodes['src']?.truncated).toBe(false);
    expect(nodes['flt']?.truncated).toBe(false);
  });

  it('rowLimit を超過した出力に truncated を立てる', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    // source は 4 行なので rowLimit=1 で 1 行に切られ truncated。
    // rowLimit は各ノード出力に独立適用されるため、truncation は下流にも波及する
    // （src が 1 行になると select/filter/cast も高々 1 行 = 超過しないので truncated=false）。
    const { nodes, output } = engine.preview(buildJourney(), { rowLimit: 1 });
    expect(nodes['src']?.truncated).toBe(true);
    expect(nodes['src']?.table.rows).toHaveLength(1);
    // 終端は src が既に 1 行なので出力は 1 行、上限内なので truncated=false。
    expect(output.rows).toHaveLength(1);
    expect(nodes['cst']?.truncated).toBe(false);
  });

  it('rowLimit=3 で source は 4→3 に切られ truncated、後段は上限内', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.preview(buildJourney(), { rowLimit: 3 });
    // source(4 行) は 3 行に切られ truncated。
    expect(nodes['src']?.truncated).toBe(true);
    expect(nodes['src']?.table.rows).toHaveLength(3);
    // filter は 3 行のうち age>=18 を残す（Alice/Bob/Carol → Alice, Carol の 2 行）。上限内。
    expect(nodes['flt']?.table.rows).toHaveLength(2);
    expect(nodes['flt']?.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// negative: 存在しない列を select
// ---------------------------------------------------------------------------

describe('v1 ジャーニー E2E — negative（存在しない列を select）', () => {
  /** src → sel(存在しない列 nope を要求) の最小グラフ。 */
  function buildBadSelectGraph(): ToolGraph {
    return {
      nodes: [
        { id: 'src', type: 'csv-source', config: { text: SAMPLE_CSV } },
        { id: 'sel', type: 'select', config: { columns: ['id', 'nope'] } },
      ],
      edges: [{ from: 'src', to: 'sel' }],
    };
  }

  it('hasErrors=true かつ当該ノード state=mismatch、error issue に column が付く', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const result = engine.propagateSchemas(buildBadSelectGraph());

    expect(result.hasErrors).toBe(true);

    const sel = result.nodes['sel'];
    expect(sel).toBeDefined();
    expect(sel!.state).toBe('mismatch');

    // error issue がちょうど欠損列 'nope' を指す。
    const errors = sel!.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('nope');

    // 存在する列 'id' はスキーマに残る（欠損列だけ落ちる）。
    expect(namesOf(sel!.schema)).toEqual(['id']);
  });

  it('source 自体はエラーにならない（mismatch は select のみ）', () => {
    const engine = new EtlEngine(createDefaultRegistry());
    const { nodes } = engine.propagateSchemas(buildBadSelectGraph());
    expect(nodes['src']?.state).toBe('inferred');
    expect(nodes['src']?.issues).toEqual([]);
  });
});
