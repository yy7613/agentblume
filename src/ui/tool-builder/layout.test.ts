import { describe, expect, it } from 'vitest';
import { BAND_GAP, columnsForWidth, designChatPositions, layoutByDepth, layoutWrapped, ORIGIN, PLACEMENT_STEP_X, PLACEMENT_STEP_Y, type CanvasPosition } from './layout';

/** id だけのノード列（配置はノードの種類を見ない）。 */
function ids(...names: string[]): { id: string }[] {
  return names.map((id) => ({ id }));
}
/** n0 → n1 → … の直線。 */
function chain(count: number): { nodes: { id: string }[]; edges: { from: string; to: string }[] } {
  const nodes = Array.from({ length: count }, (_value, index) => ({ id: `n${index}` }));
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ from: `n${index}`, to: node.id })) };
}
function positionOf(nodes: readonly { id: string }[], positions: readonly CanvasPosition[]): (id: string) => CanvasPosition {
  return (id) => positions[nodes.findIndex((node) => node.id === id)] as CanvasPosition;
}
const column = (index: number): number => ORIGIN.x + index * PLACEMENT_STEP_X;
/** 1 行だけの帯の間隔（行 140 + 帯の余白 60）。 */
const SINGLE_BAND = PLACEMENT_STEP_Y + BAND_GAP;

/**
 * 折り返さない段組み（v43 / ADR-0049 から。自動生成の経路は v51 で layoutWrapped へ移った）。
 * 列はトポロジカルな深さに沿って左→右へ並べる。
 */
describe('layoutByDepth', () => {
  it('正常: 直列のグラフは 1 行で左から右へ並ぶ', () => {
    const nodes = [{ id: 'a', type: 'csv-source', config: {} }, { id: 'b', type: 'filter', config: {} }, { id: 'c', type: 'agent-output', config: {} }];
    const positions = layoutByDepth(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(positions[0]!.x).toBeLessThan(positions[1]!.x);
    expect(positions[1]!.x).toBeLessThan(positions[2]!.x);
    expect(new Set(positions.map((position) => position.y)).size).toBe(1);
  });

  it('境界: 合流（join）は両方の枝より右へ置き、同じ列の枝は縦にずらす', () => {
    const nodes = [
      { id: 'left', type: 'csv-source', config: {} },
      { id: 'right', type: 'csv-source', config: {} },
      { id: 'select', type: 'select', config: {} },
      { id: 'join', type: 'join', config: {} },
    ];
    const positions = layoutByDepth(nodes, [
      { from: 'left', to: 'join', toInput: 0 },
      { from: 'right', to: 'select' },
      { from: 'select', to: 'join', toInput: 1 },
    ]);
    const at = (id: string) => positions[nodes.findIndex((node) => node.id === id)]!;
    expect(at('left').y).not.toBe(at('right').y);
    expect(at('join').x).toBeGreaterThan(at('select').x);
    expect(at('join').x).toBeGreaterThan(at('left').x);
  });

  it('異常: 繋がっていないノードも重ならずに置かれる（先頭列の別の行）', () => {
    const nodes = [{ id: 'a', type: 'csv-source', config: {} }, { id: 'args', type: 'agent-input', config: {} }];
    const positions = layoutByDepth(nodes, []);
    expect(positions[0]!.x).toBe(positions[1]!.x);
    expect(positions[0]!.y).not.toBe(positions[1]!.y);
  });
});

/**
 * 段組み＋折り返し（v51）。実機で生成した 10 ノードのツールが幅 2,740px × 高さ 80px の横一列になった問題の修正。
 */
describe('layoutWrapped', () => {
  it('正常: 直線 10 ノードは 4 列 × 3 帯に折り返し、幅は 4 列ぶんに収まる', () => {
    const { nodes, edges } = chain(10);
    const positions = layoutWrapped(nodes, edges);
    expect(positions).toEqual([
      { x: column(0), y: 120 }, { x: column(1), y: 120 }, { x: column(2), y: 120 }, { x: column(3), y: 120 },
      { x: column(0), y: 120 + SINGLE_BAND }, { x: column(1), y: 120 + SINGLE_BAND }, { x: column(2), y: 120 + SINGLE_BAND }, { x: column(3), y: 120 + SINGLE_BAND },
      { x: column(0), y: 120 + 2 * SINGLE_BAND }, { x: column(1), y: 120 + 2 * SINGLE_BAND },
    ]);
    const xs = positions.map((position) => position.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(3 * PLACEMENT_STEP_X);
  });

  it('正常: 結合（2 入力）の合流先は両方の入力より右で、入力は同じ列に縦に並ぶ', () => {
    const nodes = ids('left', 'right', 'join', 'sort');
    const positions = layoutWrapped(nodes, [
      { from: 'left', to: 'join' }, { from: 'right', to: 'join' }, { from: 'join', to: 'sort' },
    ]);
    const at = positionOf(nodes, positions);
    expect(at('left').x).toBe(at('right').x);
    expect(at('right').y - at('left').y).toBe(PLACEMENT_STEP_Y);
    expect(at('join').x).toBeGreaterThan(at('left').x);
    expect(at('sort').x).toBeGreaterThan(at('join').x);
  });

  it('正常: 段の中の順は上流の行の平均で決め、出現順より線の交差を減らす', () => {
    // s0 → late, s1 → early。出現順（early が先）に積むと 2 本の線が交差する。
    const nodes = ids('s0', 's1', 'early', 'late');
    const positions = layoutWrapped(nodes, [{ from: 's1', to: 'early' }, { from: 's0', to: 'late' }]);
    const at = positionOf(nodes, positions);
    expect(at('s0').y).toBeLessThan(at('s1').y);
    expect(at('late').y).toBeLessThan(at('early').y);
  });

  it('正常: 未接続のノードは最上段の引数の帯に左から並び、処理の列を奪わない', () => {
    const nodes = [{ id: 'args' }, ...chain(3).nodes, { id: 'note' }];
    const positions = layoutWrapped(nodes, chain(3).edges);
    const at = positionOf(nodes, positions);
    expect(at('args')).toEqual({ x: column(0), y: 120 });
    expect(at('note')).toEqual({ x: column(1), y: 120 });
    // 処理の流れは引数の帯の下から始まり、先頭列から左→右へ。
    expect([at('n0'), at('n1'), at('n2')]).toEqual([
      { x: column(0), y: 120 + SINGLE_BAND }, { x: column(1), y: 120 + SINGLE_BAND }, { x: column(2), y: 120 + SINGLE_BAND },
    ]);
  });

  it('境界: 未接続のノードが列数より多ければ、引数の帯の中で折り返す', () => {
    const nodes = ids('a', 'b', 'c', 'd', 'e');
    const positions = layoutWrapped(nodes, []);
    expect(positions.map((position) => position.x)).toEqual([column(0), column(1), column(2), column(3), column(0)]);
    expect(positions[4]?.y).toBe(120 + PLACEMENT_STEP_Y);
  });

  it('境界: 帯の高さは、その帯で最も縦に積まれた列に合わせる', () => {
    // 列 1 に 3 つ積まれる。帯 2 の上端は 3 行ぶん + 帯の余白だけ下がる。
    const nodes = ids('a', 'b1', 'b2', 'b3', 'm', 'x', 'y');
    const positions = layoutWrapped(nodes, [
      { from: 'a', to: 'b1' }, { from: 'a', to: 'b2' }, { from: 'a', to: 'b3' },
      { from: 'b1', to: 'm' }, { from: 'b2', to: 'm' }, { from: 'b3', to: 'm' },
      { from: 'm', to: 'x' }, { from: 'x', to: 'y' },
    ], { maxColumns: 3 });
    const at = positionOf(nodes, positions);
    expect(at('b3')).toEqual({ x: column(1), y: 120 + 2 * PLACEMENT_STEP_Y });
    expect(at('x')).toEqual({ x: column(0), y: 120 + 3 * PLACEMENT_STEP_Y + BAND_GAP });
    expect(at('y')).toEqual({ x: column(1), y: 120 + 3 * PLACEMENT_STEP_Y + BAND_GAP });
  });

  it('正常: どの帯でも左から右へ流れる（折り返しは次の帯の左端から）', () => {
    const { nodes, edges } = chain(12);
    const positions = layoutWrapped(nodes, edges, { maxColumns: 3 });
    const at = positionOf(nodes, positions);
    for (const edge of edges) {
      const from = at(edge.from);
      const to = at(edge.to);
      // 同じ帯なら右へ、帯をまたぐなら下の帯の左端へ。右から左へ戻る線は作らない。
      if (to.y === from.y) expect(to.x).toBeGreaterThan(from.x);
      else expect(to).toEqual({ x: ORIGIN.x, y: from.y + SINGLE_BAND });
    }
    const bands = [...new Set(positions.map((position) => position.y))];
    expect(bands).toEqual([120, 120 + SINGLE_BAND, 120 + 2 * SINGLE_BAND, 120 + 3 * SINGLE_BAND]);
  });

  it('境界: maxColumns 3 では 3 列、6 では 6 列で折り返す', () => {
    const { nodes, edges } = chain(10);
    const three = layoutWrapped(nodes, edges, { maxColumns: 3 });
    expect(new Set(three.map((position) => position.x))).toEqual(new Set([column(0), column(1), column(2)]));
    expect(new Set(three.map((position) => position.y)).size).toBe(4);
    const six = layoutWrapped(nodes, edges, { maxColumns: 6 });
    expect(Math.max(...six.map((position) => position.x))).toBe(column(5));
    expect(six[6]).toEqual({ x: column(0), y: 120 + SINGLE_BAND });
  });

  it('境界: 3 未満の列数は 3 に上げ、数でない列数は既定の 4 にする', () => {
    const { nodes, edges } = chain(5);
    expect(Math.max(...layoutWrapped(nodes, edges, { maxColumns: 1 }).map((position) => position.x))).toBe(column(2));
    expect(Math.max(...layoutWrapped(nodes, edges, { maxColumns: Number.NaN }).map((position) => position.x))).toBe(column(3));
    expect(Math.max(...layoutWrapped(nodes, edges, { maxColumns: 4.9 }).map((position) => position.x))).toBe(column(3));
  });

  it('境界: 空グラフは空の配置を返す', () => {
    expect(layoutWrapped([], [])).toEqual([]);
  });

  it('異常: グラフに無いノードを指すエッジは無視し、そのノードは未接続として扱う', () => {
    const nodes = ids('a', 'b');
    const positions = layoutWrapped(nodes, [{ from: 'a', to: 'ghost' }, { from: 'ghost', to: 'b' }]);
    expect(positions).toEqual([{ x: column(0), y: 120 }, { x: column(1), y: 120 }]);
  });

  it('例外: 循環していても最後の列へ置いて必ず終わり、重ならない', () => {
    const nodes = ids('a', 'b', 'c', 'self');
    const positions = layoutWrapped(nodes, [
      { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }, { from: 'self', to: 'self' },
    ]);
    const at = positionOf(nodes, positions);
    expect(at('b').x).toBeGreaterThan(at('a').x);
    expect(at('c').x).toBe(at('b').x);
    expect(new Set(positions.map((position) => `${position.x},${position.y}`)).size).toBe(4);
  });

  it('正常: 同じ入力には同じ出力を返し、入力を書き換えない', () => {
    const { nodes, edges } = chain(7);
    const snapshot = JSON.stringify({ nodes, edges });
    expect(layoutWrapped(nodes, edges, { maxColumns: 3 })).toEqual(layoutWrapped(nodes, edges, { maxColumns: 3 }));
    expect(JSON.stringify({ nodes, edges })).toBe(snapshot);
  });
});

describe('columnsForWidth', () => {
  it('正常: 表示幅を列の間隔で割った列数を返す', () => {
    expect(columnsForWidth(1280)).toBe(4);
    expect(columnsForWidth(1700)).toBe(6);
  });

  it('境界: 測れない幅（0・NaN）でも下限の 3 列か既定の 4 列で並べられる', () => {
    expect(columnsForWidth(0)).toBe(3);
    expect(columnsForWidth(839)).toBe(3);
    expect(columnsForWidth(Number.NaN)).toBe(4);
  });
});

describe('designChatPositions', () => {
  const placed = [
    { id: 'a', type: 'tool' as const, position: { x: 80, y: 120 }, data: { nodeType: 'json-source' as const, label: 'a', config: {} } },
  ];

  it('正常: 既に画面にあるノードは、返答に position が無くても前の配置を保つ', () => {
    const positions = designChatPositions({ nodes: [{ id: 'a', type: 'json-source', config: {} }], edges: [] }, placed);
    expect(positions.get('a')).toEqual({ x: 80, y: 120 });
  });

  it('境界: 新しいノードが連なるときも、上流から順に右へ置く', () => {
    const positions = designChatPositions({
      nodes: [{ id: 'a', type: 'json-source', config: {} }, { id: 'b', type: 'filter', config: {} }, { id: 'c', type: 'sort', config: {} }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    }, placed);
    expect(positions.get('b')).toEqual({ x: 300, y: 120 });
    expect(positions.get('c')).toEqual({ x: 520, y: 120 });
  });

  it('境界: 下流から順に並んだ鎖でも、上流から辿って全部を右へ置く', () => {
    // nodes の並びは保証されないので、c（下流）が先に来ても b を待って正しく決める。
    const positions = designChatPositions({
      nodes: [{ id: 'c', type: 'sort', config: {} }, { id: 'b', type: 'filter', config: {} }, { id: 'a', type: 'json-source', config: {} }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    }, placed);
    expect(positions.get('b')).toEqual({ x: 300, y: 120 });
    expect(positions.get('c')).toEqual({ x: 520, y: 120 });
  });

  it('境界: 2 入力（join）は両方の枝より右へ置く', () => {
    const positions = designChatPositions({
      nodes: [
        { id: 'a', type: 'json-source', config: {} },
        { id: 'far', type: 'csv-source', config: {}, position: { x: 600, y: 300 } },
        { id: 'j', type: 'join', config: {} },
      ],
      edges: [{ from: 'a', to: 'j', toInput: 0 }, { from: 'far', to: 'j', toInput: 1 }],
    }, placed);
    expect(positions.get('j')?.x).toBeGreaterThan(600);
  });

  it('例外: 循環していて上流を辿れないノードも、最右列の右へ置いて必ず終わる', () => {
    const positions = designChatPositions({
      nodes: [{ id: 'a', type: 'json-source', config: {} }, { id: 'x', type: 'filter', config: {} }, { id: 'y', type: 'sort', config: {} }],
      edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }],
    }, placed);
    expect(positions.get('x')).toBeDefined();
    expect(positions.get('y')).toBeDefined();
    expect(positions.get('x')?.x).toBeGreaterThan(80);
  });

  it('正常: 右端の上限を越える追加は、今あるノードの最下端の下の新しい帯の左端へ送る', () => {
    const wide = [
      { id: 'a', position: { x: 80, y: 120 } },
      { id: 'z', position: { x: 1120, y: 260 } },
    ];
    const positions = designChatPositions({
      nodes: [{ id: 'a' }, { id: 'z' }, { id: 'next' }, { id: 'after' }],
      edges: [{ from: 'a', to: 'z' }, { from: 'z', to: 'next' }, { from: 'next', to: 'after' }],
    }, wide);
    // z の右（1340）は上限 80 + 4 × 280 = 1200 を越える。最下端 260 の下の帯（260 + 200）の左端へ。
    expect(positions.get('next')).toEqual({ x: ORIGIN.x, y: 260 + SINGLE_BAND });
    // 送った先からは、また上流の右へ流れる。
    expect(positions.get('after')).toEqual({ x: ORIGIN.x + 220, y: 260 + SINGLE_BAND });
    expect(positions.get('a')).toEqual({ x: 80, y: 120 });
    expect(positions.get('z')).toEqual({ x: 1120, y: 260 });
  });

  it('境界: 上流が無い追加も右端の上限を越えるなら新しい帯へ、列数を増やせば右に置く', () => {
    const wide = [{ id: 'z', position: { x: 1120, y: 120 } }];
    const graph = { nodes: [{ id: 'z' }, { id: 'csv' }], edges: [] };
    expect(designChatPositions(graph, wide).get('csv')).toEqual({ x: ORIGIN.x, y: 120 + SINGLE_BAND });
    expect(designChatPositions(graph, wide, { maxColumns: 6 }).get('csv')).toEqual({ x: 1400, y: 120 });
  });
});
