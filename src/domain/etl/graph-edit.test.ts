import { describe, expect, it } from 'vitest';
import { GraphEditError, NODE_ID_PATTERN, applyGraphOperations, canonicalizeOperationIds, summarizeConfig, type GraphOperation } from './graph-edit';
import type { ToolGraph } from './graph';

/** source → filter → out の素直な鎖（配置つき: 人が並べたキャンバスを模す）。 */
function chain(): ToolGraph {
  return {
    nodes: [
      { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' }, position: { x: 0, y: 0 } },
      { id: 'flt', type: 'filter', config: { column: 'age', op: 'gte', value: 18 }, position: { x: 220, y: 0 } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' }, position: { x: 440, y: 0 } },
    ],
    edges: [{ from: 'src', to: 'flt' }, { from: 'flt', to: 'out' }],
  };
}

describe('applyGraphOperations', () => {
  describe('add-node', () => {
    it('正常: after を指定すると鎖の途中へ挿入され、after の既存の出力エッジが新ノード始点へ付け替わる', () => {
      const result = applyGraphOperations(chain(), [
        { op: 'add-node', id: 'srt', type: 'sort', config: { keys: [{ column: 'age', direction: 'desc' }] }, after: 'flt' },
      ]);
      expect(result.graph.nodes.map((node) => node.id)).toEqual(['src', 'flt', 'out', 'srt']);
      // flt → out は残らず、flt → srt → out になる（モデルはエッジを 1 本も書いていない）。
      expect(result.graph.edges).toEqual([{ from: 'src', to: 'flt' }, { from: 'srt', to: 'out' }, { from: 'flt', to: 'srt' }]);
      expect(result.applied).toEqual([
        { op: 'add-node', nodeId: 'srt', summary: 'added sort \'srt\' after \'flt\', before \'out\' with keys=[{"column":"age","direction":"desc"}]' },
      ]);
    });

    it('正常: after の出力エッジが 0 本（終端の後ろ）なら after → id を張るだけ', () => {
      const result = applyGraphOperations(chain(), [{ op: 'add-node', id: 'wsp', type: 'workspace-output', config: {}, after: 'out' }]);
      expect(result.graph.edges).toEqual([{ from: 'src', to: 'flt' }, { from: 'flt', to: 'out' }, { from: 'out', to: 'wsp' }]);
      expect(result.applied[0]?.summary).toBe("added workspace-output 'wsp' after 'out'");
    });

    it('境界: after の出力エッジが 2 本以上なら付け替えず after → id だけを張る（どの枝の手前かが決まらない）', () => {
      const forked: ToolGraph = {
        nodes: [{ id: 'src', type: 'csv-source', config: {} }, { id: 'a', type: 'select', config: {} }, { id: 'b', type: 'select', config: {} }],
        edges: [{ from: 'src', to: 'a' }, { from: 'src', to: 'b' }],
      };
      const result = applyGraphOperations(forked, [{ op: 'add-node', id: 'c', type: 'select', config: {}, after: 'src' }]);
      expect(result.graph.edges).toEqual([{ from: 'src', to: 'a' }, { from: 'src', to: 'b' }, { from: 'src', to: 'c' }]);
    });

    it('正常: after を省略すると孤立ノードになる（source を足す経路。エッジは増えない）', () => {
      const result = applyGraphOperations(chain(), [{ op: 'add-node', id: 'csv-2', type: 'csv-source', config: { dataSourceId: 'ds-2' } }]);
      expect(result.graph.edges).toEqual(chain().edges);
      expect(result.graph.nodes.at(-1)).toEqual({ id: 'csv-2', type: 'csv-source', config: { dataSourceId: 'ds-2' } });
    });

    it('正常: 付け替えるエッジの toInput は保たれる（join の左右が入れ替わらない）', () => {
      const joined: ToolGraph = {
        nodes: [{ id: 'l', type: 'csv-source', config: {} }, { id: 'r', type: 'csv-source', config: {} }, { id: 'j', type: 'join', config: {} }],
        edges: [{ from: 'l', to: 'j', toInput: 0 }, { from: 'r', to: 'j', toInput: 1 }],
      };
      const result = applyGraphOperations(joined, [{ op: 'add-node', id: 'sel', type: 'select', config: { columns: ['a'] }, after: 'r' }]);
      expect(result.graph.edges).toEqual([{ from: 'l', to: 'j', toInput: 0 }, { from: 'sel', to: 'j', toInput: 1 }, { from: 'r', to: 'sel' }]);
    });

    it('正常: config を省略すると空オブジェクトになる（config 無しのノードを作れる）', () => {
      const result = applyGraphOperations(chain(), [{ op: 'add-node', id: 'now', type: 'current-datetime' }]);
      expect(result.graph.nodes.at(-1)?.config).toEqual({});
    });

    it('異常: 既存と重複する id は GraphEditError（何番目の操作かと直し方を言う）', () => {
      expect(() => applyGraphOperations(chain(), [
        { op: 'set-config', id: 'flt', config: { column: 'age', op: 'gt', value: 20 } },
        { op: 'add-node', id: 'flt', type: 'filter', config: {} },
      ])).toThrow(/operation 2 \('add-node'\): a node with the id 'flt' already exists\. Pick a new id, or use 'set-config'/);
    });

    it('異常: 存在しない after への挿入は GraphEditError（既存の id を挙げて直し方を言う）', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'add-node', id: 'srt', type: 'sort', config: {}, after: 'nope' }]))
        .toThrow(/operation 1 \('add-node'\): after 'nope' is not a node in the current graph\. Use one of the existing node ids \('src', 'flt', 'out'\)/);
    });

    it.each([['Sort1'], ['1st'], ['sort_1'], ['並べ替え'], ['']])('異常: id %s は ^[a-z][a-z0-9-]{0,39}$ に合わず違反', (id) => {
      expect(() => applyGraphOperations(chain(), [{ op: 'add-node', id, type: 'sort', config: {} }])).toThrow(GraphEditError);
    });

    it('境界: id は 40 文字まで通り、41 文字は違反', () => {
      const ok = `a${'b'.repeat(39)}`;
      expect(NODE_ID_PATTERN.test(ok)).toBe(true);
      expect(applyGraphOperations(chain(), [{ op: 'add-node', id: ok, type: 'sort', config: {} }]).graph.nodes).toHaveLength(4);
      expect(() => applyGraphOperations(chain(), [{ op: 'add-node', id: `${ok}c`, type: 'sort', config: {} }])).toThrow(GraphEditError);
    });

    it('異常: type が無い add-node は違反（カタログの種別を選ばせる）', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'add-node', id: 'srt', type: '', config: {} }]))
        .toThrow(/the node type of 'srt' is missing/);
    });
  });

  describe('remove-node', () => {
    it('正常: 入力 1・出力 1 なら上流と下流を直結し、下流の toInput を保つ', () => {
      const result = applyGraphOperations(chain(), [{ op: 'remove-node', id: 'flt' }]);
      expect(result.graph.nodes.map((node) => node.id)).toEqual(['src', 'out']);
      expect(result.graph.edges).toEqual([{ from: 'src', to: 'out' }]);
      expect(result.applied).toEqual([{ op: 'remove-node', nodeId: 'flt', summary: "removed filter 'flt', connecting 'src' to 'out'" }]);
    });

    it('境界: 入力が 2 本（join）なら繋がずに外す（どの枝を残すかを勝手に決めない）', () => {
      const joined: ToolGraph = {
        nodes: [{ id: 'l', type: 'csv-source', config: {} }, { id: 'r', type: 'csv-source', config: {} }, { id: 'j', type: 'join', config: {} }, { id: 'out', type: 'agent-output', config: {} }],
        edges: [{ from: 'l', to: 'j', toInput: 0 }, { from: 'r', to: 'j', toInput: 1 }, { from: 'j', to: 'out' }],
      };
      const result = applyGraphOperations(joined, [{ op: 'remove-node', id: 'j' }]);
      expect(result.graph.edges).toEqual([]);
      expect(result.applied[0]?.summary).toBe("removed join 'j'");
    });

    it('境界: 出力が 0 本（終端）なら繋ぎ直さずに外す', () => {
      const result = applyGraphOperations(chain(), [{ op: 'remove-node', id: 'out' }]);
      expect(result.graph.edges).toEqual([{ from: 'src', to: 'flt' }]);
    });

    it('異常: 存在しない id の除去は違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'remove-node', id: 'nope' }]))
        .toThrow(/operation 1 \('remove-node'\): id 'nope' is not a node in the current graph/);
    });
  });

  describe('set-config', () => {
    it('正常: config を丸ごと置き換え、position は保つ（人が並べたキャンバスを崩さない）', () => {
      const result = applyGraphOperations(chain(), [{ op: 'set-config', id: 'flt', config: { column: 'age', op: 'gte', value: 20, caseInsensitive: true } }]);
      expect(result.graph.nodes[1]).toEqual({
        id: 'flt', type: 'filter', position: { x: 220, y: 0 },
        config: { column: 'age', op: 'gte', value: 20, caseInsensitive: true },
      });
      expect(result.applied[0]?.summary).toBe('set config of filter \'flt\': column="age", op="gte", value=20, caseInsensitive=true');
    });

    it('異常: config がオブジェクトでない set-config は違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'set-config', id: 'flt', config: 'age >= 20' }]))
        .toThrow(/the config of 'flt' is not an object\. Send the complete config object/);
    });
  });

  describe('connect / disconnect', () => {
    const twoInputs: ToolGraph = {
      nodes: [{ id: 'l', type: 'csv-source', config: {} }, { id: 'r', type: 'csv-source', config: {} }, { id: 'j', type: 'join', config: {} }],
      edges: [{ from: 'l', to: 'j', toInput: 0 }],
    };

    it('正常: 2 入力ノードへ toInput つきで繋げる（強調するのは入力を得た側）', () => {
      const result = applyGraphOperations(twoInputs, [{ op: 'connect', from: 'r', to: 'j', toInput: 1 }]);
      expect(result.graph.edges).toEqual([{ from: 'l', to: 'j', toInput: 0 }, { from: 'r', to: 'j', toInput: 1 }]);
      expect(result.applied).toEqual([{ op: 'connect', nodeId: 'j', summary: "connected 'r' to join 'j' on input 1" }]);
    });

    it('正常: toInput を省いた connect は入力ポートを書かない（1 入力ノードの既定）', () => {
      const result = applyGraphOperations(chain(), [{ op: 'add-node', id: 'lim', type: 'limit', config: { count: 10 } }, { op: 'connect', from: 'flt', to: 'lim' }]);
      expect(result.graph.edges.at(-1)).toEqual({ from: 'flt', to: 'lim' });
      expect(result.applied[1]?.summary).toBe("connected 'flt' to limit 'lim'");
    });

    it('正常: disconnect はその 2 点間のエッジを外す', () => {
      const result = applyGraphOperations(chain(), [{ op: 'disconnect', from: 'flt', to: 'out' }]);
      expect(result.graph.edges).toEqual([{ from: 'src', to: 'flt' }]);
      expect(result.applied).toEqual([{ op: 'disconnect', nodeId: 'out', summary: "disconnected 'flt' from agent-output 'out'" }]);
    });

    it.each([[2], [-1], [0.5]])('異常: toInput=%s は入力ポートでないので違反', (toInput) => {
      expect(() => applyGraphOperations(twoInputs, [{ op: 'connect', from: 'r', to: 'j', toInput }]))
        .toThrow(/is not an input port\. Use 0 \(left\) or 1 \(right\)/);
    });

    it('異常: 既にあるエッジをもう一度張るのは違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'connect', from: 'src', to: 'flt' }]))
        .toThrow(/'src' is already connected to 'flt'/);
    });

    it('異常: 自分自身への connect は違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'connect', from: 'flt', to: 'flt' }]))
        .toThrow(/'flt' cannot be connected to itself/);
    });

    it('異常: 存在しないエッジの disconnect は違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'disconnect', from: 'src', to: 'out' }]))
        .toThrow(/there is no edge from 'src' to 'out'/);
    });

    it('異常: 存在しないノードへの connect は違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'connect', from: 'nope', to: 'out' }]))
        .toThrow(/operation 1 \('connect'\): from 'nope' is not a node in the current graph/);
    });
  });

  describe('操作列全体', () => {
    it('正常: 複数の操作を順に当て、後の操作は前の操作の結果を見る（source 追加 → join へ接続）', () => {
      const result = applyGraphOperations(chain(), [
        { op: 'add-node', id: 'csv-2', type: 'csv-source', config: { dataSourceId: 'ds-2' } },
        { op: 'add-node', id: 'jn', type: 'join', config: { mode: 'inner', keys: ['id'] }, after: 'src' },
        { op: 'connect', from: 'csv-2', to: 'jn', toInput: 1 },
      ]);
      expect(result.graph.edges).toEqual([
        { from: 'jn', to: 'flt' }, { from: 'flt', to: 'out' }, { from: 'src', to: 'jn' }, { from: 'csv-2', to: 'jn', toInput: 1 },
      ]);
      expect(result.applied.map((change) => change.op)).toEqual(['add-node', 'add-node', 'connect']);
    });

    it('例外: 途中の操作が違反なら全体を捨てる（半分だけ当たったグラフは返さない）', () => {
      const graph = chain();
      expect(() => applyGraphOperations(graph, [
        { op: 'remove-node', id: 'flt' },
        { op: 'set-config', id: 'flt', config: {} },
      ])).toThrow(/operation 2 \('set-config'\): id 'flt' is not a node in the current graph/);
      // 入力のグラフは変異していない。
      expect(graph).toEqual(chain());
    });

    it('異常: 未知の op は語彙を挙げて違反', () => {
      expect(() => applyGraphOperations(chain(), [{ op: 'replace-node' } as unknown as GraphOperation]))
        .toThrow(/operation 1: unknown operation "replace-node"\. Use one of 'add-node', 'remove-node', 'set-config', 'connect', 'disconnect'/);
    });

    it('正常: 操作が空なら元のグラフと空の applied を返す', () => {
      const result = applyGraphOperations(chain(), []);
      expect(result.graph).toEqual(chain());
      expect(result.applied).toEqual([]);
    });

    it('正常: 入力のグラフを変異させない（返るのは新しいグラフ）', () => {
      const graph = chain();
      const result = applyGraphOperations(graph, [{ op: 'remove-node', id: 'flt' }, { op: 'add-node', id: 'lim', type: 'limit', config: { count: 10 }, after: 'src' }]);
      expect(graph).toEqual(chain());
      expect(result.graph).not.toBe(graph);
    });
  });
});

describe('summarizeConfig', () => {
  it('正常: 受け取った順のキーで key=value を並べる（同じ入力に同じ出力）', () => {
    expect(summarizeConfig({ count: 10, offset: 0 })).toBe('count=10, offset=0');
    expect(summarizeConfig({ offset: 0, count: 10 })).toBe('offset=0, count=10');
  });

  it('境界: 空の config は空文字、値は 60 文字・全体は 200 文字で切る', () => {
    expect(summarizeConfig({})).toBe('');
    expect(summarizeConfig(undefined)).toBe('');
    const long = summarizeConfig({ text: 'x'.repeat(200) });
    expect(long).toBe(`text="${'x'.repeat(59)}...`);
    const wide = summarizeConfig(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key${index}`, index])));
    expect(wide).toHaveLength(203);
    expect(wide.endsWith('...')).toBe(true);
  });
});

describe('canonicalizeOperationIds（モデルの id の書き間違いを適用前に畳む）', () => {
  const existing = ['source-e-stat', 'filter-1'];

  it('正常: 同じ応答の中で新しい id の綴りが揺れても（- と _）、宣言と参照が同じ id に揃う（実測: 差し戻しでも直らなかった）', () => {
    const operations: GraphOperation[] = [
      { op: 'add-node', id: 'source-e_stat', type: 'csv-source', config: { dataSourceId: 'ds' } },
      { op: 'add-node', id: 'period', type: 'parse-period', config: {}, after: 'source-e_stat' },
      { op: 'connect', from: 'Source-E-Stat', to: 'period' },
    ];
    const result = canonicalizeOperationIds(operations, []);
    expect(result[0]).toMatchObject({ id: 'source-e-stat' });
    expect(result[1]).toMatchObject({ after: 'source-e-stat' });
    expect(result[2]).toMatchObject({ from: 'source-e-stat', to: 'period' });
  });

  it('正常: 規則に合わない新しい id（_ 入り・大文字・空白）は規則に合う形へ寄せる', () => {
    const result = canonicalizeOperationIds([{ op: 'add-node', id: 'Region Input_Node', type: 'agent-input', config: {} }], existing);
    expect(result[0]).toMatchObject({ id: 'region-input-node' });
    expect(NODE_ID_PATTERN.test((result[0] as { id: string }).id)).toBe(true);
  });

  it('正常: 既存ノードを指す参照の揺れ（大文字・_）は、その既存 id へ寄せる', () => {
    const result = canonicalizeOperationIds([
      { op: 'set-config', id: 'FILTER_1', config: {} },
      { op: 'remove-node', id: 'source_e_stat' },
      { op: 'disconnect', from: 'Source-E-Stat', to: 'filter_1' },
    ], existing);
    expect(result[0]).toMatchObject({ id: 'filter-1' });
    expect(result[1]).toMatchObject({ id: 'source-e-stat' });
    expect(result[2]).toMatchObject({ from: 'source-e-stat', to: 'filter-1' });
  });

  it('異常: 畳んだ形が既存の複数のノードに当たる参照は触らない（applyGraphOperations が理由つきで弾く）', () => {
    const ambiguous = ['sort-1', 'sort_1'];
    const result = canonicalizeOperationIds([{ op: 'remove-node', id: 'SORT-1' }], ambiguous);
    expect(result[0]).toMatchObject({ id: 'SORT-1' });
  });

  it('異常: 畳んでも既存ノードと衝突する新しい id は触らない（重複として弾かれる）', () => {
    const result = canonicalizeOperationIds([{ op: 'add-node', id: 'Filter_1', type: 'filter', config: {} }], existing);
    expect(result[0]).toMatchObject({ id: 'Filter_1' });
  });

  it('境界: 数字や記号で始まる id は先頭を落として規則に合わせ、空になるものは触らない', () => {
    const result = canonicalizeOperationIds([
      { op: 'add-node', id: '1-sort', type: 'sort', config: {} },
      { op: 'add-node', id: '___', type: 'sort', config: {} },
    ], []);
    expect(result[0]).toMatchObject({ id: 'sort' });
    expect(result[1]).toMatchObject({ id: '___' });
  });

  it('従来どおり: 規則どおりの id は何も変わらず、操作の並びも保たれる', () => {
    const operations: GraphOperation[] = [
      { op: 'add-node', id: 'sort-1', type: 'sort', config: {}, after: 'filter-1' },
      { op: 'connect', from: 'sort-1', to: 'filter-1', toInput: 1 },
    ];
    expect(canonicalizeOperationIds(operations, existing)).toEqual(operations);
  });
});
