/**
 * EtlEngine 単体テスト（v1 実装契約 §11）。
 *
 * ノード実装（src/domain/etl/nodes/*）には一切依存せず、テスト内で定義した
 * インラインのスタブ EtlNode を NodeRegistry に register して検証する。
 * これによりエンジンを具体ノードから独立して確認できる。
 */
import { describe, expect, it } from 'vitest';
import type { Cell, Row, Schema, SchemaState, Table } from '../../domain/data/types';
import { ConfigError, GraphError } from '../../domain/etl/errors';
import { SchemaError } from '../../domain/etl/errors';
import type { EtlNode, SchemaInference, SchemaIssue } from '../../domain/etl/node';
import { NodeRegistry } from '../../domain/etl/registry';
import { EtlEngine } from './engine';
import type { ToolGraph } from '../../domain/etl/graph';

// ---------------------------------------------------------------------------
// スタブノード定義（EtlNode を満たす最小実装）
// ---------------------------------------------------------------------------

/** スキーマ生成ヘルパ（全列 nullable:false）。 */
function schemaOf(...names: string[]): Schema {
  return { columns: names.map((name) => ({ name, type: 'string' as const, nullable: false })) };
}

function columnNames(schema: Schema): string[] {
  return schema.columns.map((c) => c.name);
}

/**
 * source スタブ（inputArity: 0）。
 * config: { schema: Schema; state: SchemaState; rows: Row[] }
 * inferSchema は与えた schema/state をそのまま返す。execute は schema+rows を返す。
 */
interface SourceConfig {
  readonly schema: Schema;
  readonly state: SchemaState;
  readonly rows: readonly Row[];
}
const sourceNode: EtlNode<SourceConfig> = {
  type: 'stub-source',
  kind: 'source',
  inputArity: 0,
  validateConfig(config: unknown): SourceConfig {
    return config as SourceConfig;
  },
  inferSchema(_inputs: readonly Schema[], config: SourceConfig): SchemaInference {
    return { schema: config.schema, state: config.state, issues: [] };
  },
  execute(_inputs: readonly Table[], config: SourceConfig): Table {
    return { schema: config.schema, rows: config.rows };
  },
};

/**
 * select スタブ（inputArity: 1）。
 * config: { columns: string[] }
 * inferSchema: 要求列が入力に無ければ error issue + state:'mismatch'、schema は存在列のみ。
 *              全存在なら要求順の列で state:'confirmed'。
 * execute: 各行を要求列だけに射影。欠損列があれば SchemaError。
 */
interface SelectConfig {
  readonly columns: readonly string[];
}
const selectNode: EtlNode<SelectConfig> = {
  type: 'stub-select',
  kind: 'transform',
  inputArity: 1,
  validateConfig(config: unknown): SelectConfig {
    return config as SelectConfig;
  },
  inferSchema(inputs: readonly Schema[], config: SelectConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const present = new Set(columnNames(input));
    const issues: SchemaIssue[] = [];
    const kept = [];
    for (const name of config.columns) {
      if (present.has(name)) {
        const col = input.columns.find((c) => c.name === name);
        if (col !== undefined) kept.push(col);
      } else {
        issues.push({ severity: 'error', message: `column not found: ${name}`, column: name });
      }
    }
    const state: SchemaState = issues.length > 0 ? 'mismatch' : 'confirmed';
    return { schema: { columns: kept }, state, issues };
  },
  execute(inputs: readonly Table[], config: SelectConfig): Table {
    const input = inputs[0];
    if (input === undefined) throw new SchemaError('select: missing input table');
    const present = new Set(columnNames(input.schema));
    for (const name of config.columns) {
      if (!present.has(name)) throw new SchemaError(`select: column not found: ${name}`);
    }
    const rows: Row[] = input.rows.map((row) => {
      const out: Record<string, Cell> = {};
      for (const name of config.columns) {
        out[name] = row[name] as Cell;
      }
      return out;
    });
    const kept = config.columns
      .map((name) => input.schema.columns.find((c) => c.name === name))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    return { schema: { columns: kept }, rows };
  },
};

/**
 * filter スタブ（inputArity: 1）。
 * config: { column: string; op: 'gt' | 'eq'; value?: Cell }
 * inferSchema: column 欠損 → error/mismatch。op:'gt' は列型 number 必須（違反 → error/mismatch）。
 *              正常時は入力スキーマそのまま、state:'confirmed'。
 * execute: 述語で行を残す（スキーマ不変）。
 */
interface FilterConfig {
  readonly column: string;
  readonly op: 'gt' | 'eq';
  readonly value?: Cell;
}
const filterNode: EtlNode<FilterConfig> = {
  type: 'stub-filter',
  kind: 'transform',
  inputArity: 1,
  validateConfig(config: unknown): FilterConfig {
    return config as FilterConfig;
  },
  inferSchema(inputs: readonly Schema[], config: FilterConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const col = input.columns.find((c) => c.name === config.column);
    if (col === undefined) {
      return {
        schema: input,
        state: 'mismatch',
        issues: [{ severity: 'error', message: `column not found: ${config.column}`, column: config.column }],
      };
    }
    if (config.op === 'gt' && col.type !== 'number') {
      return {
        schema: input,
        state: 'mismatch',
        issues: [
          {
            severity: 'error',
            message: `op 'gt' requires numeric column but '${config.column}' is ${col.type}`,
            column: config.column,
          },
        ],
      };
    }
    return { schema: input, state: 'confirmed', issues: [] };
  },
  execute(inputs: readonly Table[], config: FilterConfig): Table {
    const input = inputs[0];
    if (input === undefined) throw new SchemaError('filter: missing input table');
    const rows = input.rows.filter((row) => {
      const cell = row[config.column];
      if (config.op === 'gt') return typeof cell === 'number' && typeof config.value === 'number' && cell > config.value;
      return cell === config.value;
    });
    return { schema: input.schema, rows };
  },
};

/**
 * passthrough スタブ（inputArity: 1）。入力をそのまま返す。
 * 配線（合流・終端数・閉路）テスト用。
 */
const passthroughNode: EtlNode<Record<string, never>> = {
  type: 'stub-pass',
  kind: 'transform',
  inputArity: 1,
  validateConfig(): Record<string, never> {
    return {};
  },
  inferSchema(inputs: readonly Schema[]): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    return { schema: input, state: 'confirmed', issues: [] };
  },
  execute(inputs: readonly Table[]): Table {
    const input = inputs[0];
    if (input === undefined) throw new SchemaError('pass: missing input table');
    return input;
  },
};

/**
 * strict スタブ（inputArity: 1）。columns が空だと validateConfig が ConfigError を
 * 投げる。Zod の `min(1)` 制約を持つ分析系ノード（設定未完了のまま追加された直後）
 * を再現し、フォルト分離の検証に使う。
 */
const strictNode: EtlNode<SelectConfig> = {
  type: 'stub-strict',
  kind: 'analyze',
  inputArity: 1,
  validateConfig(config: unknown): SelectConfig {
    const raw = config as { columns?: readonly string[] };
    if (raw.columns === undefined || raw.columns.length === 0) {
      throw new ConfigError('stub-strict: columns: Too small: expected array to have >=1 items');
    }
    return { columns: raw.columns };
  },
  inferSchema(inputs: readonly Schema[], config: SelectConfig): SchemaInference {
    return selectNode.inferSchema(inputs, config);
  },
  execute(inputs: readonly Table[], config: SelectConfig): Table {
    return selectNode.execute(inputs, config);
  },
};

/** sink スタブ（inputArity: 1）。入力をそのまま返す終端ノード。 */
const sinkNode: EtlNode<Record<string, never>> = {
  ...passthroughNode,
  type: 'stub-sink',
  kind: 'sink',
};

/**
 * 2入力の join スタブ（inputArity: 2）。
 * inferSchema: 入力スキーマの列を toInput 順に連結。
 * execute: 左右の行を toInput 順に連結（順序確認用）。
 */
interface JoinConfig {
  readonly _?: never;
}
const joinNode: EtlNode<JoinConfig> = {
  type: 'stub-join',
  kind: 'transform',
  inputArity: 2,
  validateConfig(): JoinConfig {
    return {};
  },
  inferSchema(inputs: readonly Schema[]): SchemaInference {
    const cols = inputs.flatMap((s) => s.columns);
    return { schema: { columns: cols }, state: 'confirmed', issues: [] };
  },
  execute(inputs: readonly Table[]): Table {
    const left = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const right = inputs[1] ?? { schema: { columns: [] }, rows: [] };
    const cols = [...left.schema.columns, ...right.schema.columns];
    return { schema: { columns: cols }, rows: [...left.rows, ...right.rows] };
  },
};

/** 全スタブを登録した新規レジストリ。 */
function makeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(sourceNode);
  registry.register(selectNode);
  registry.register(filterNode);
  registry.register(passthroughNode);
  registry.register(strictNode);
  registry.register(sinkNode);
  registry.register(joinNode);
  return registry;
}

function makeEngine(): EtlEngine {
  return new EtlEngine(makeRegistry());
}

// 共通のサンプル source config を作るヘルパ。
function sourceConfig(schema: Schema, state: SchemaState, rows: readonly Row[]): SourceConfig {
  return { schema, state, rows };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('EtlEngine.propagateSchemas', () => {
  it('直線グラフ（source → select）のスキーマを伝播する', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('id', 'name', 'age'), 'confirmed', []) },
        { id: 'sel', type: 'stub-select', config: { columns: ['id', 'name'] } satisfies SelectConfig },
      ],
      edges: [{ from: 's', to: 'sel' }],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.order).toEqual(['s', 'sel']);
    expect(result.hasErrors).toBe(false);
    const s = result.nodes['s'];
    const sel = result.nodes['sel'];
    expect(s).toBeDefined();
    expect(sel).toBeDefined();
    expect(columnNames(s!.schema)).toEqual(['id', 'name', 'age']);
    expect(columnNames(sel!.schema)).toEqual(['id', 'name']);
    expect(sel!.state).toBe('confirmed');
  });

  it('source が inferred のとき下流の最終 state も inferred に伝播する', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a', 'b'), 'inferred', []) },
        { id: 'sel', type: 'stub-select', config: { columns: ['a'] } satisfies SelectConfig },
      ],
      edges: [{ from: 's', to: 'sel' }],
    };

    const result = engine.propagateSchemas(graph);

    // 局所 select は confirmed だが、上流 inferred と合成され inferred。
    expect(result.nodes['s']?.state).toBe('inferred');
    expect(result.nodes['sel']?.state).toBe('inferred');
    expect(result.hasErrors).toBe(false);
  });

  it('3段直線（source → filter → select）で最悪 state に畳まれる', () => {
    const engine = makeEngine();
    const numSchema: Schema = { columns: [{ name: 'age', type: 'number', nullable: false }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(numSchema, 'inferred', []) },
        { id: 'f', type: 'stub-filter', config: { column: 'age', op: 'gt', value: 18 } satisfies FilterConfig },
        { id: 'sel', type: 'stub-select', config: { columns: ['age'] } satisfies SelectConfig },
      ],
      edges: [
        { from: 's', to: 'f' },
        { from: 'f', to: 'sel' },
      ],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.order).toEqual(['s', 'f', 'sel']);
    // filter/select は confirmed だが上流 inferred を引き継ぐ。
    expect(result.nodes['f']?.state).toBe('inferred');
    expect(result.nodes['sel']?.state).toBe('inferred');
    expect(result.hasErrors).toBe(false);
  });

  it('select の欠損列で hasErrors=true かつ当ノード state=mismatch', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('id', 'name'), 'confirmed', []) },
        { id: 'sel', type: 'stub-select', config: { columns: ['id', 'missing'] } satisfies SelectConfig },
      ],
      edges: [{ from: 's', to: 'sel' }],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.hasErrors).toBe(true);
    expect(result.nodes['sel']?.state).toBe('mismatch');
    const issues = result.nodes['sel']?.issues ?? [];
    expect(issues.some((i) => i.severity === 'error' && i.column === 'missing')).toBe(true);
    // 存在する列のみ残る。
    expect(columnNames(result.nodes['sel']!.schema)).toEqual(['id']);
  });

  it('filter の型不一致（数値以外に gt）で mismatch かつ hasErrors', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      // 'age' は string 型（schemaOf は全列 string）。gt は number を要求。
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('age'), 'confirmed', []) },
        { id: 'f', type: 'stub-filter', config: { column: 'age', op: 'gt', value: 18 } satisfies FilterConfig },
      ],
      edges: [{ from: 's', to: 'f' }],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.hasErrors).toBe(true);
    expect(result.nodes['f']?.state).toBe('mismatch');
    const issues = result.nodes['f']?.issues ?? [];
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('局所 issue のみを各ノードに帰属させる（上流 issue を重複させない）', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('id'), 'confirmed', []) },
        { id: 'sel', type: 'stub-select', config: { columns: ['nope'] } satisfies SelectConfig },
        { id: 'p', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 's', to: 'sel' },
        { from: 'sel', to: 'p' },
      ],
    };

    const result = engine.propagateSchemas(graph);

    // 下流 pass は自身の issue を持たない（上流の error は帰属しない）。
    expect(result.nodes['p']?.issues).toEqual([]);
    // ただし state は上流 mismatch を合成して mismatch。
    expect(result.nodes['p']?.state).toBe('mismatch');
    expect(result.hasErrors).toBe(true);
  });

  it('config は validateConfig を通した値で inferSchema に渡る', () => {
    // validateConfig が変換した値が使われることを、変換を仕込んだノードで確認。
    const registry = new NodeRegistry();
    registry.register(sourceNode);
    const validatingSelect: EtlNode<SelectConfig> = {
      ...selectNode,
      type: 'stub-select-validating',
      validateConfig(config: unknown): SelectConfig {
        const raw = config as { columns?: readonly string[] };
        // 明示的に columns を正規化（未指定なら空）。
        return { columns: raw.columns ?? [] };
      },
    };
    registry.register(validatingSelect);
    const engine = new EtlEngine(registry);

    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'sel', type: 'stub-select-validating', config: {} },
      ],
      edges: [{ from: 's', to: 'sel' }],
    };

    const result = engine.propagateSchemas(graph);
    // columns=[] に正規化されたので空スキーマ・confirmed。
    expect(columnNames(result.nodes['sel']!.schema)).toEqual([]);
    expect(result.nodes['sel']?.state).toBe('confirmed');
  });
});

describe('EtlEngine.propagateSchemas フォルト分離（config 不正ノード）', () => {
  it('config 不正ノードは mismatch + error issue になり、他ノードの推論は継続する', () => {
    const engine = makeEngine();
    // bad（設定未完了）と sel（正常）が join で合流する。bad が壊れていても
    // 別系統（s2 → sel）の推論は最後まで走る。
    const graph: ToolGraph = {
      nodes: [
        { id: 's1', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'bad', type: 'stub-strict', config: {} },
        { id: 's2', type: 'stub-source', config: sourceConfig(schemaOf('b', 'c'), 'confirmed', []) },
        { id: 'sel', type: 'stub-select', config: { columns: ['b'] } satisfies SelectConfig },
        { id: 'j', type: 'stub-join', config: {} },
      ],
      edges: [
        { from: 's1', to: 'bad' },
        { from: 's2', to: 'sel' },
        { from: 'bad', to: 'j', toInput: 0 },
        { from: 'sel', to: 'j', toInput: 1 },
      ],
    };

    const result = engine.propagateSchemas(graph);

    // 全ノードが推論結果を持つ（グラフ全体のアボートが起きない）。
    expect(result.order).toEqual(['s1', 'bad', 's2', 'sel', 'j']);
    expect(Object.keys(result.nodes).sort()).toEqual(['bad', 'j', 's1', 's2', 'sel']);
    expect(result.hasErrors).toBe(true);

    // 失敗ノードは mismatch + ConfigError 由来の error issue（nodeId 入り）。
    expect(result.nodes['bad']?.state).toBe('mismatch');
    expect(columnNames(result.nodes['bad']!.schema)).toEqual([]);
    const badIssues = result.nodes['bad']?.issues ?? [];
    expect(badIssues).toHaveLength(1);
    expect(badIssues[0]?.severity).toBe('error');
    expect(badIssues[0]?.message).toContain("node 'bad' has invalid config:");
    expect(badIssues[0]?.message).toContain('Too small');

    // 無関係な系統は通常どおり推論される（UI の列候補が失われない）。
    expect(columnNames(result.nodes['s2']!.schema)).toEqual(['b', 'c']);
    expect(columnNames(result.nodes['sel']!.schema)).toEqual(['b']);
    expect(result.nodes['sel']?.state).toBe('confirmed');
    expect(result.nodes['sel']?.issues).toEqual([]);
  });

  it('config 不正ノードの直下は推論をスキップし、上流原因の issue を1件だけ持つ', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'bad', type: 'stub-strict', config: { columns: [] } },
        { id: 'p1', type: 'stub-pass', config: {} },
        { id: 'p2', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 's', to: 'bad' },
        { from: 'bad', to: 'p1' },
        { from: 'p1', to: 'p2' },
      ],
    };

    const result = engine.propagateSchemas(graph);

    // 直下 p1 には原因ノードを指す issue が1件。
    expect(result.nodes['p1']?.issues).toEqual([
      { severity: 'error', message: "upstream node 'bad' has invalid config" },
    ]);
    expect(columnNames(result.nodes['p1']!.schema)).toEqual([]);
    expect(result.nodes['p1']?.state).toBe('mismatch');

    // さらに下流 p2 には同じ issue を連鎖させない（重複表示を避ける）。
    expect(result.nodes['p2']?.issues).toEqual([]);
    expect(columnNames(result.nodes['p2']!.schema)).toEqual([]);
    expect(result.nodes['p2']?.state).toBe('mismatch');
    expect(result.hasErrors).toBe(true);
  });

  it('同一の不正上流から2本入力を受ける多入力ノードでも issue は1件に畳む', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'bad', type: 'stub-strict', config: {} },
        { id: 'j', type: 'stub-join', config: {} },
      ],
      edges: [
        { from: 's', to: 'bad' },
        { from: 'bad', to: 'j', toInput: 0 },
        { from: 'bad', to: 'j', toInput: 1 },
      ],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.nodes['j']?.issues).toEqual([
      { severity: 'error', message: "upstream node 'bad' has invalid config" },
    ]);
  });

  it('複数の config 不正ノードはそれぞれ独立に記録される', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's1', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'bad1', type: 'stub-strict', config: {} },
        { id: 's2', type: 'stub-source', config: sourceConfig(schemaOf('b'), 'confirmed', []) },
        { id: 'bad2', type: 'stub-strict', config: {} },
        { id: 'j', type: 'stub-join', config: {} },
      ],
      edges: [
        { from: 's1', to: 'bad1' },
        { from: 's2', to: 'bad2' },
        { from: 'bad1', to: 'j', toInput: 0 },
        { from: 'bad2', to: 'j', toInput: 1 },
      ],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.nodes['bad1']?.state).toBe('mismatch');
    expect(result.nodes['bad2']?.state).toBe('mismatch');
    // join は両方の上流を原因として列挙する。
    expect((result.nodes['j']?.issues ?? []).map((issue) => issue.message)).toEqual([
      "upstream node 'bad1' has invalid config",
      "upstream node 'bad2' has invalid config",
    ]);
  });

  it('config 不正でも上流ノード自身の state/schema は保持される', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'inferred', []) },
        { id: 'bad', type: 'stub-strict', config: {} },
      ],
      edges: [{ from: 's', to: 'bad' }],
    };

    const result = engine.propagateSchemas(graph);

    expect(result.nodes['s']?.state).toBe('inferred');
    expect(columnNames(result.nodes['s']!.schema)).toEqual(['a']);
  });

  it('Error 以外が投げられても issue に文字列化して隔離する', () => {
    const registry = makeRegistry();
    registry.register({
      ...strictNode,
      type: 'stub-throw-string',
      validateConfig(): SelectConfig {
        // eslint 的には非推奨だが、非 Error を投げるノードでも壊れないことの確認。
        throw 'boom';
      },
    });
    const engine = new EtlEngine(registry);
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'bad', type: 'stub-throw-string', config: {} },
      ],
      edges: [{ from: 's', to: 'bad' }],
    };

    const result = engine.propagateSchemas(graph);
    expect(result.nodes['bad']?.issues[0]?.message).toBe("node 'bad' has invalid config: boom");
    expect(result.hasErrors).toBe(true);
  });

  it('preview は従来どおり ConfigError を投げる（実行系は厳格）', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'bad', type: 'stub-strict', config: {} },
      ],
      edges: [{ from: 's', to: 'bad' }],
    };
    expect(() => engine.preview(graph)).toThrow(ConfigError);
  });
});

describe('EtlEngine.preview', () => {
  const rowsOf = (...vals: number[]): Row[] => vals.map((v) => ({ age: v } as Row));

  it('直線グラフを実行して終端テーブルを output に返す', () => {
    const engine = makeEngine();
    const numSchema: Schema = { columns: [{ name: 'age', type: 'number', nullable: false }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(numSchema, 'confirmed', rowsOf(10, 20, 30)) },
        { id: 'f', type: 'stub-filter', config: { column: 'age', op: 'gt', value: 15 } satisfies FilterConfig },
      ],
      edges: [{ from: 's', to: 'f' }],
    };

    const result = engine.preview(graph);

    expect(result.terminalId).toBe('f');
    // age > 15 → 20, 30。
    expect(result.output.rows).toEqual([{ age: 20 }, { age: 30 }]);
    expect(result.nodes['s']?.table.rows.length).toBe(3);
    expect(result.nodes['f']?.truncated).toBe(false);
  });

  it('rowLimit を超える出力は各ノードで truncated=true になり切り捨てられる', () => {
    const engine = makeEngine();
    const numSchema: Schema = { columns: [{ name: 'age', type: 'number', nullable: false }] };
    const many = Array.from({ length: 5 }, (_, i) => ({ age: i } as Row));
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(numSchema, 'confirmed', many) },
        { id: 'p', type: 'stub-pass', config: {} },
      ],
      edges: [{ from: 's', to: 'p' }],
    };

    const result = engine.preview(graph, { rowLimit: 2 });

    expect(result.nodes['s']?.truncated).toBe(true);
    expect(result.nodes['s']?.table.rows.length).toBe(2);
    // pass は既に 2 行に切り詰められた入力を受け取り、上限ちょうどなので truncated=false。
    expect(result.nodes['p']?.truncated).toBe(false);
    expect(result.output.rows.length).toBe(2);
    expect(result.output.rows).toEqual([{ age: 0 }, { age: 1 }]);
  });

  it('既定 rowLimit は 100（100 行ちょうどは切り捨てない）', () => {
    const engine = makeEngine();
    const numSchema: Schema = { columns: [{ name: 'age', type: 'number', nullable: false }] };
    const exactly100 = Array.from({ length: 100 }, (_, i) => ({ age: i } as Row));
    const graph: ToolGraph = {
      nodes: [{ id: 's', type: 'stub-source', config: sourceConfig(numSchema, 'confirmed', exactly100) }],
      edges: [],
    };

    const result = engine.preview(graph);
    expect(result.nodes['s']?.truncated).toBe(false);
    expect(result.output.rows.length).toBe(100);
  });

  it('既定 rowLimit 超過（101 行）は切り捨てて truncated=true', () => {
    const engine = makeEngine();
    const numSchema: Schema = { columns: [{ name: 'age', type: 'number', nullable: false }] };
    const rows101 = Array.from({ length: 101 }, (_, i) => ({ age: i } as Row));
    const graph: ToolGraph = {
      nodes: [{ id: 's', type: 'stub-source', config: sourceConfig(numSchema, 'confirmed', rows101) }],
      edges: [],
    };

    const result = engine.preview(graph);
    expect(result.nodes['s']?.truncated).toBe(true);
    expect(result.output.rows.length).toBe(100);
  });

  it('実行時の列欠損は SchemaError として伝播する', () => {
    const engine = makeEngine();
    // inferSchema はスキップされないが、select が存在しない列を実行時に射影しようとする。
    // ここでは source スキーマに列があるが execute 用 rows とスキーマの整合を崩す代わりに、
    // select に存在しない列を要求してスキーマ検査で mismatch → execute で SchemaError。
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('id'), 'confirmed', [{ id: 'x' }]) },
        { id: 'sel', type: 'stub-select', config: { columns: ['missing'] } satisfies SelectConfig },
      ],
      edges: [{ from: 's', to: 'sel' }],
    };

    expect(() => engine.preview(graph)).toThrow(SchemaError);
  });
});

describe('EtlEngine グラフ検証（GraphError）', () => {
  it('終端が 0 個（閉路以外で全ノードに出次数あり）は… 実際は閉路になるため、独立ノード2つの終端複数を検証', () => {
    // 終端0を純粋に作るには閉路が必要なので、ここでは終端「複数」を検証する。
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 'a', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 'b', type: 'stub-source', config: sourceConfig(schemaOf('y'), 'confirmed', []) },
      ],
      edges: [],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(/exactly one terminal/);
  });

  it('終端が 0 個（閉路により出次数0が無い）は GraphError（閉路検出が先行）', () => {
    const engine = makeEngine();
    // a→b→a の閉路。全ノードに出次数があり終端0。閉路検出で GraphError。
    const graph: ToolGraph = {
      nodes: [
        { id: 'a', type: 'stub-pass', config: {} },
        { id: 'b', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(/graph has a cycle/);
  });

  it('終端が複数（分岐して合流しない）は GraphError', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 'p1', type: 'stub-pass', config: {} },
        { id: 'p2', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 's', to: 'p1' },
        { from: 's', to: 'p2' },
      ],
    };
    expect(() => engine.preview(graph)).toThrow(GraphError);
    expect(() => engine.preview(graph)).toThrow(/exactly one terminal/);
  });

  it('閉路は入次数エラーより先に「graph has a cycle」で報告する', () => {
    const engine = makeEngine();
    // 閉路 a→b→c→b を含む。b の入次数は 2（arity 1）だが、原因は閉路なので
    // 入次数の誤診断（expects 1 input but has in-degree 2）を出してはいけない。
    const graph: ToolGraph = {
      nodes: [
        { id: 'a', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 'b', type: 'stub-pass', config: {} },
        { id: 'c', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b' },
      ],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(/graph has a cycle/);
    expect(() => engine.propagateSchemas(graph)).not.toThrow(/in-degree/);
    expect(() => engine.preview(graph)).toThrow(/graph has a cycle/);
  });

  it('自己ループ（f→f）も閉路として報告する', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 'f', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 's', to: 'f' },
        { from: 'f', to: 'f' },
      ],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(/graph has a cycle/);
  });

  it('相互接続（a↔b）は入次数エラーではなく閉路として報告する', () => {
    const engine = makeEngine();
    // s→a と b→a で a の入次数は 2（arity 1）になるが、原因は a↔b の閉路。
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 'a', type: 'stub-pass', config: {} },
        { id: 'b', type: 'stub-pass', config: {} },
        { id: 't', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'b', to: 't' },
      ],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(/graph has a cycle/);
    expect(() => engine.propagateSchemas(graph)).not.toThrow(/in-degree/);
  });

  it('未知 type のノードは GraphError（registry.get 経由）', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [{ id: 'x', type: 'does-not-exist', config: {} }],
      edges: [],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.preview(graph)).toThrow(GraphError);
  });

  it('入次数が inputArity と不一致は GraphError（source に入力を接続）', () => {
    const engine = makeEngine();
    // stub-source は arity 0 だが入力エッジを1本持つ。
    const graph: ToolGraph = {
      nodes: [
        { id: 's1', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 's2', type: 'stub-source', config: sourceConfig(schemaOf('y'), 'confirmed', []) },
      ],
      edges: [{ from: 's1', to: 's2' }],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(/expects 0 input/);
  });

  it('入次数が inputArity と不一致は GraphError（transform に入力なし）', () => {
    const engine = makeEngine();
    // stub-pass は arity 1 だが入力エッジが無い（終端は pass 1つ）。
    const graph: ToolGraph = {
      nodes: [{ id: 'p', type: 'stub-pass', config: {} }],
      edges: [],
    };
    expect(() => engine.preview(graph)).toThrow(GraphError);
    expect(() => engine.preview(graph)).toThrow(/expects 1 input/);
  });

  it('重複ノードidは GraphError', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 'dup', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) },
        { id: 'dup', type: 'stub-pass', config: {} },
      ],
      edges: [],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(/duplicate node id/);
  });

  it('edge が未知ノードidを参照すると GraphError', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [{ id: 's', type: 'stub-source', config: sourceConfig(schemaOf('x'), 'confirmed', []) }],
      edges: [{ from: 's', to: 'ghost' }],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(/unknown node id/);
  });
});

describe('EtlEngine 多入力（toInput 順の入力収集）', () => {
  it('toInput でポート順が決まる（宣言順が逆でも toInput 昇順で入力を並べる）', () => {
    const engine = makeEngine();
    const leftSchema: Schema = { columns: [{ name: 'L', type: 'string', nullable: false }] };
    const rightSchema: Schema = { columns: [{ name: 'R', type: 'string', nullable: false }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 'left', type: 'stub-source', config: sourceConfig(leftSchema, 'confirmed', [{ L: 'l' }]) },
        { id: 'right', type: 'stub-source', config: sourceConfig(rightSchema, 'confirmed', [{ R: 'r' }]) },
        { id: 'j', type: 'stub-join', config: {} },
      ],
      // わざと右(toInput:1)を先に宣言し、左(toInput:0)を後に宣言。
      edges: [
        { from: 'right', to: 'j', toInput: 1 },
        { from: 'left', to: 'j', toInput: 0 },
      ],
    };

    const prop = engine.propagateSchemas(graph);
    // toInput 0 = left(L), toInput 1 = right(R) の順で連結される。
    expect(columnNames(prop.nodes['j']!.schema)).toEqual(['L', 'R']);

    const pv = engine.preview(graph);
    expect(pv.output.rows).toEqual([{ L: 'l' }, { R: 'r' }]);
  });

  it('2入力ノードは入次数2でなければ GraphError', () => {
    const engine = makeEngine();
    const leftSchema: Schema = { columns: [{ name: 'L', type: 'string', nullable: false }] };
    const graph: ToolGraph = {
      nodes: [
        { id: 'left', type: 'stub-source', config: sourceConfig(leftSchema, 'confirmed', []) },
        { id: 'j', type: 'stub-join', config: {} },
      ],
      edges: [{ from: 'left', to: 'j', toInput: 0 }], // 入力1本のみ
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(/expects 2 input/);
  });
});

describe('EtlEngine 入力ポート（toInput）検証', () => {
  /** 2ソース + join の骨組み（edges だけ差し替えて使う）。 */
  function joinGraph(edges: ToolGraph['edges']): ToolGraph {
    return {
      nodes: [
        { id: 'left', type: 'stub-source', config: sourceConfig(schemaOf('L'), 'confirmed', []) },
        { id: 'right', type: 'stub-source', config: sourceConfig(schemaOf('R'), 'confirmed', []) },
        { id: 'j', type: 'stub-join', config: {} },
      ],
      edges,
    };
  }

  it('inputArity を超える toInput は GraphError（単一入力ノードに toInput:5）', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'sel', type: 'stub-select', config: { columns: ['a'] } satisfies SelectConfig },
      ],
      edges: [{ from: 's', to: 'sel', toInput: 5 }],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(
      "edge to 'sel' uses input port 5 but node type 'stub-select' accepts 1 input(s)",
    );
    expect(() => engine.preview(graph)).toThrow(GraphError);
  });

  it('負の toInput は GraphError', () => {
    const engine = makeEngine();
    const graph = joinGraph([
      { from: 'left', to: 'j', toInput: -1 },
      { from: 'right', to: 'j', toInput: 1 },
    ]);
    expect(() => engine.propagateSchemas(graph)).toThrow(
      "edge to 'j' uses input port -1 but node type 'stub-join' accepts 2 input(s)",
    );
  });

  it('整数でない toInput は GraphError', () => {
    const engine = makeEngine();
    const graph = joinGraph([
      { from: 'left', to: 'j', toInput: 0 },
      { from: 'right', to: 'j', toInput: 1.5 },
    ]);
    expect(() => engine.propagateSchemas(graph)).toThrow(
      "edge to 'j' uses input port 1.5 but node type 'stub-join' accepts 2 input(s)",
    );
  });

  it('同一入力ポートへの複数エッジは GraphError（両エッジ toInput:0）', () => {
    const engine = makeEngine();
    const graph = joinGraph([
      { from: 'left', to: 'j', toInput: 0 },
      { from: 'right', to: 'j', toInput: 0 },
    ]);
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow("node 'j' has multiple edges on input port 0");
    expect(() => engine.preview(graph)).toThrow(GraphError);
  });

  it('多入力ノードへの toInput 未指定は GraphError（明示を要求する）', () => {
    const engine = makeEngine();
    const graph = joinGraph([
      { from: 'left', to: 'j', toInput: 0 },
      { from: 'right', to: 'j' },
    ]);
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(
      "node 'j' (type 'stub-join') requires explicit input ports on incoming edges",
    );
  });

  it('両エッジ toInput 未指定の多入力ノードも「明示を要求」で報告する', () => {
    const engine = makeEngine();
    const graph = joinGraph([
      { from: 'left', to: 'j' },
      { from: 'right', to: 'j' },
    ]);
    expect(() => engine.propagateSchemas(graph)).toThrow(
      "node 'j' (type 'stub-join') requires explicit input ports on incoming edges",
    );
  });

  it('単一入力ノードへの toInput 省略は後方互換で許容する', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', [{ a: 'x' }]) },
        { id: 'sel', type: 'stub-select', config: { columns: ['a'] } satisfies SelectConfig },
        { id: 'p', type: 'stub-pass', config: {} },
      ],
      // toInput を一切指定しない従来形式。
      edges: [
        { from: 's', to: 'sel' },
        { from: 'sel', to: 'p' },
      ],
    };
    expect(engine.propagateSchemas(graph).hasErrors).toBe(false);
    expect(engine.preview(graph).output.rows).toEqual([{ a: 'x' }]);
  });

  it('明示 toInput:0 の単一入力エッジも許容する', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'p', type: 'stub-pass', config: {} },
      ],
      edges: [{ from: 's', to: 'p', toInput: 0 }],
    };
    expect(engine.propagateSchemas(graph).hasErrors).toBe(false);
  });
});

describe('EtlEngine sink ノードの終端制約', () => {
  it('sink の後段にノードを接続すると GraphError', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', []) },
        { id: 'out', type: 'stub-sink', config: {} },
        { id: 'p', type: 'stub-pass', config: {} },
      ],
      edges: [
        { from: 's', to: 'out' },
        { from: 'out', to: 'p' },
      ],
    };
    expect(() => engine.propagateSchemas(graph)).toThrow(GraphError);
    expect(() => engine.propagateSchemas(graph)).toThrow(
      "sink node 'out' must be terminal (no downstream nodes)",
    );
    expect(() => engine.preview(graph)).toThrow(GraphError);
  });

  it('終端が sink のグラフは通る', () => {
    const engine = makeEngine();
    const graph: ToolGraph = {
      nodes: [
        { id: 's', type: 'stub-source', config: sourceConfig(schemaOf('a'), 'confirmed', [{ a: 'x' }]) },
        { id: 'out', type: 'stub-sink', config: {} },
      ],
      edges: [{ from: 's', to: 'out' }],
    };
    expect(engine.propagateSchemas(graph).order).toEqual(['s', 'out']);
    expect(engine.preview(graph).terminalId).toBe('out');
  });
});
