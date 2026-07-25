/**
 * アプリ層: ETL エンジン（v1 実装契約 §11）
 *
 * `ToolGraph` を受け取り、
 * - `propagateSchemas`: 各ノードのスキーマと（上流合成後の）最終 state を算出。
 * - `preview`: 各ノードを実行し、行数上限を適用したテーブルを算出。
 *
 * 共通のグラフ検証（id一意 / edge端点実在 / 閉路なし / 入次数=inputArity /
 * 入力ポート妥当性 / sinkは終端 / 終端ちょうど1つ）を両メソッドの冒頭で行い、
 * 違反は GraphError を投げる。
 *
 * `propagateSchemas` は UI のスキーマ点検経路なので、個々のノードの config 検証
 * 失敗はノード単位のフォルトとして隔離し、他ノードの推論は続行する
 * （`preview` は実行系なので従来どおり厳格に throw する）。
 *
 * 入力（graph / config / 上流テーブル）は破壊的変更しない。
 */
import type { Schema, SchemaState, Table } from '../../domain/data/types';
import { GraphError } from '../../domain/etl/errors';
import type { EtlNode, SchemaIssue } from '../../domain/etl/node';
import type { NodeRegistry } from '../../domain/etl/registry';
import { combineStates } from '../../domain/etl/state';
import { topologicalSort } from '../../domain/etl/topo';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';

/** 1ノードのスキーマ推論結果（上流合成後の最終 state を含む）。 */
export interface NodeInference {
  readonly nodeId: string;
  readonly schema: Schema;
  /** 上流 final state 群 + 当ノード局所 state を合成した最終 state。 */
  readonly state: SchemaState;
  readonly issues: readonly SchemaIssue[];
}

/** スキーマ伝播の全体結果。 */
export interface PropagationResult {
  /** トポロジカル順のノードid列。 */
  readonly order: string[];
  /** nodeId → 推論結果。 */
  readonly nodes: Record<string, NodeInference>;
  /** いずれかのノードに severity:'error' の issue があれば true。 */
  readonly hasErrors: boolean;
}

/** プレビュー実行のオプション。 */
export interface PreviewOptions {
  /** 各ノード出力の最大行数（既定 100）。 */
  readonly rowLimit?: number;
}

/** 1ノードのプレビュー結果。 */
export interface NodePreview {
  readonly nodeId: string;
  /** 行数上限を適用した後のテーブル。 */
  readonly table: Table;
  /** 上限超過で行を切り捨てたら true。 */
  readonly truncated: boolean;
}

/** プレビュー実行の全体結果。 */
export interface PreviewResult {
  readonly terminalId: string;
  /** 終端ノードの（上限適用後）テーブル。 */
  readonly output: Table;
  /** nodeId → プレビュー結果。 */
  readonly nodes: Record<string, NodePreview>;
}

/** 既定の行数上限。 */
const DEFAULT_ROW_LIMIT = 100;

/** 推論を打ち切ったノードの出力スキーマ（列なし）。 */
const EMPTY_SCHEMA: Schema = { columns: [] };

/**
 * グラフ検証の中間表現。
 * - `order`: トポロジカル順のノードid。
 * - `nodeById`: id → GraphNode。
 * - `nodeOf`: id → 登録済み EtlNode。
 * - `inputsOf`: id → 上流ノードid列（toInput 昇順）。
 * - `terminalId`: 出次数0の唯一ノード。
 */
interface ValidatedGraph {
  readonly order: string[];
  readonly nodeById: Map<string, GraphNode>;
  readonly nodeOf: Map<string, EtlNode>;
  readonly inputsOf: Map<string, string[]>;
  readonly terminalId: string;
}

export class EtlEngine {
  private readonly registry: NodeRegistry;

  constructor(registry: NodeRegistry) {
    this.registry = registry;
  }

  /**
   * トポロジカル順に各ノードのスキーマを推論する。
   *
   * 各ノードの入力スキーマ（上流ノードの出力スキーマ、toInput 順）を集めて
   * `node.inferSchema` を呼び、最終 state を上流 final state 群と合成する。
   *
   * ノード単位のフォルト分離: `validateConfig` が投げた場合、そのノードだけを
   * `state:'mismatch'` + error issue として記録し、他ノード（別系統を含む）の
   * 推論は継続する。設定未完了のノードが1つあるだけでグラフ全体の列候補が
   * 失われる（UI が操作不能になる）のを防ぐため。
   */
  propagateSchemas(graph: ToolGraph): PropagationResult {
    const v = this.validate(graph);

    const schemaById = new Map<string, Schema>();
    const stateById = new Map<string, SchemaState>();
    const nodes: Record<string, NodeInference> = {};
    let hasErrors = false;

    /** config 検証に失敗したノード（自身の設定が不正）。 */
    const invalidConfigIds = new Set<string>();
    /** 推論を打ち切ったノード（config 失敗ノードとその下流すべて）。 */
    const blockedIds = new Set<string>();

    const record = (id: string, schema: Schema, state: SchemaState, issues: readonly SchemaIssue[]): void => {
      schemaById.set(id, schema);
      stateById.set(id, state);
      if (issues.some((issue) => issue.severity === 'error')) {
        hasErrors = true;
      }
      nodes[id] = { nodeId: id, schema, state, issues };
    };

    for (const id of v.order) {
      const graphNode = v.nodeById.get(id) as GraphNode;
      const node = v.nodeOf.get(id) as EtlNode;
      const upstreamIds = v.inputsOf.get(id) ?? [];

      const upstreamStates = upstreamIds.map((fromId) => {
        const st = stateById.get(fromId);
        if (st === undefined) {
          throw new GraphError(`upstream state not computed for node: ${fromId}`);
        }
        return st;
      });

      // 上流が打ち切られている場合は入力スキーマが不明なので推論しない。
      // issue は「直接の上流が config 不正」のときだけ付け、さらに下流へは
      // 連鎖させない（同一原因の issue をグラフ全体へ複製しない）。
      if (upstreamIds.some((fromId) => blockedIds.has(fromId))) {
        blockedIds.add(id);
        const causes = [...new Set(upstreamIds.filter((fromId) => invalidConfigIds.has(fromId)))];
        const issues: SchemaIssue[] = causes.map((fromId) => ({
          severity: 'error',
          message: `upstream node '${fromId}' has invalid config`,
        }));
        record(id, EMPTY_SCHEMA, combineStates([...upstreamStates, 'unknown']), issues);
        continue;
      }

      let config: unknown;
      try {
        config = node.validateConfig(graphNode.config);
      } catch (error) {
        invalidConfigIds.add(id);
        blockedIds.add(id);
        record(id, EMPTY_SCHEMA, 'mismatch', [
          { severity: 'error', message: `node '${id}' has invalid config: ${errorMessage(error)}` },
        ]);
        continue;
      }

      const inputSchemas: Schema[] = upstreamIds.map((fromId) => {
        const s = schemaById.get(fromId);
        if (s === undefined) {
          // トポロジカル順で上流は必ず先に処理済み。到達し得ない防御。
          throw new GraphError(`upstream schema not computed for node: ${fromId}`);
        }
        return s;
      });

      const inference = node.inferSchema(inputSchemas, config);
      record(id, inference.schema, combineStates([...upstreamStates, inference.state]), inference.issues);
    }

    return { order: v.order, nodes, hasErrors };
  }

  /**
   * トポロジカル順に各ノードを実行し、行数上限を適用したテーブルを算出する。
   *
   * `output` は終端ノードの（上限適用後）テーブル。実行時に列欠損等があれば
   * 各ノードが SchemaError を投げてよく、Engine はそのまま伝播する。
   */
  preview(graph: ToolGraph, options?: PreviewOptions): PreviewResult {
    const v = this.validate(graph);

    const rowLimit = options?.rowLimit ?? DEFAULT_ROW_LIMIT;

    const tableById = new Map<string, Table>();
    const nodes: Record<string, NodePreview> = {};

    for (const id of v.order) {
      const graphNode = v.nodeById.get(id) as GraphNode;
      const node = v.nodeOf.get(id) as EtlNode;
      const upstreamIds = v.inputsOf.get(id) ?? [];

      const inputTables: Table[] = upstreamIds.map((fromId) => {
        const t = tableById.get(fromId);
        if (t === undefined) {
          throw new GraphError(`upstream table not computed for node: ${fromId}`);
        }
        return t;
      });

      const config = node.validateConfig(graphNode.config);
      const produced = node.execute(inputTables, config);
      const { table, truncated } = limitRows(produced, rowLimit);

      tableById.set(id, table);
      nodes[id] = { nodeId: id, table, truncated };
    }

    const output = tableById.get(v.terminalId) as Table;

    return { terminalId: v.terminalId, output, nodes };
  }

  /**
   * 共通のグラフ検証（§11）。違反は GraphError。
   *
   * 検証項目（この順序で実行する）:
   * 1. ノードid一意。
   * 2. edge の from/to が実在。
   * 3. 閉路なし（topologicalSort）。
   * 4. 各ノードの入次数が registry.get(type).inputArity と一致。
   * 5. 入力ポート（toInput）が範囲内・重複なし・多入力ノードでは明示。
   * 6. kind:'sink' のノードは終端（出次数0）。
   * 7. 終端（出次数0）がちょうど1つ。
   *
   * 3 を 4 より先に置くのは、閉路が入次数の超過として先に露見すると
   * 「expects 1 input(s) but has in-degree 2」という誤診断になるため。
   */
  private validate(graph: ToolGraph): ValidatedGraph {
    // 1. id 一意 & id→GraphNode。
    const nodeById = new Map<string, GraphNode>();
    for (const gn of graph.nodes) {
      if (nodeById.has(gn.id)) {
        throw new GraphError(`duplicate node id: ${gn.id}`);
      }
      nodeById.set(gn.id, gn);
    }

    // type 解決（未知 type は registry.get が GraphError を投げる）。
    const nodeOf = new Map<string, EtlNode>();
    for (const gn of graph.nodes) {
      nodeOf.set(gn.id, this.registry.get(gn.type));
    }

    // 2. edge の端点実在チェック + 入次数集計 + 出次数集計 + 入力（toInput順）収集。
    const indegree = new Map<string, number>();
    const outdegree = new Map<string, number>();
    for (const gn of graph.nodes) {
      indegree.set(gn.id, 0);
      outdegree.set(gn.id, 0);
    }

    interface IncomingEdge {
      readonly from: string;
      /** 実効ポート番号（未指定は 0）。検証 5 でノード内一意が保証される。 */
      readonly toInput: number;
      /** toInput が明示されていたか（多入力ノードでは明示を要求する）。 */
      readonly explicit: boolean;
    }
    const incoming = new Map<string, IncomingEdge[]>();

    for (const edge of graph.edges) {
      if (!nodeById.has(edge.from)) {
        throw new GraphError(`edge references unknown node id: ${edge.from}`);
      }
      if (!nodeById.has(edge.to)) {
        throw new GraphError(`edge references unknown node id: ${edge.to}`);
      }
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
      outdegree.set(edge.from, (outdegree.get(edge.from) ?? 0) + 1);

      const list = incoming.get(edge.to);
      const entry: IncomingEdge = {
        from: edge.from,
        toInput: edge.toInput ?? 0,
        explicit: edge.toInput !== undefined,
      };
      if (list === undefined) incoming.set(edge.to, [entry]);
      else list.push(entry);
    }

    // 3. 閉路なし（未知参照は上で弾いているが topologicalSort も同種チェックを持つ）。
    const order = topologicalSort(
      graph.nodes.map((gn) => gn.id),
      graph.edges.map((e) => ({ from: e.from, to: e.to })),
    );

    // 4. 入次数 = inputArity。
    for (const gn of graph.nodes) {
      const node = nodeOf.get(gn.id) as EtlNode;
      const deg = indegree.get(gn.id) ?? 0;
      if (deg !== node.inputArity) {
        throw new GraphError(
          `node '${gn.id}' (type '${gn.type}') expects ${node.inputArity} input(s) but has in-degree ${deg}`,
        );
      }
    }

    // 5. 入力ポート（toInput）の妥当性。入次数=inputArity は確認済みなので、
    //    入力エッジがあるノードの inputArity は必ず1以上。
    for (const gn of graph.nodes) {
      const node = nodeOf.get(gn.id) as EtlNode;
      const list = incoming.get(gn.id) ?? [];

      for (const edge of list) {
        if (!Number.isInteger(edge.toInput) || edge.toInput < 0 || edge.toInput >= node.inputArity) {
          throw new GraphError(
            `edge to '${gn.id}' uses input port ${edge.toInput} but node type '${gn.type}' accepts ${node.inputArity} input(s)`,
          );
        }
      }

      // 多入力ノードは左右の取り違えが結果を変えるため全入力エッジに明示を要求する。
      // 単一入力ノードへの省略は後方互換のため従来どおり許容。
      if (node.inputArity >= 2 && list.some((edge) => !edge.explicit)) {
        throw new GraphError(
          `node '${gn.id}' (type '${gn.type}') requires explicit input ports on incoming edges`,
        );
      }

      const usedPorts = new Set<number>();
      for (const edge of list) {
        if (usedPorts.has(edge.toInput)) {
          throw new GraphError(`node '${gn.id}' has multiple edges on input port ${edge.toInput}`);
        }
        usedPorts.add(edge.toInput);
      }
    }

    // 6. sink は終端でなければならない。中間に置かれた sink の副作用は
    //    実行時（dispatcher は終端のみ処理）に無言で失われるため接続を禁じる。
    for (const gn of graph.nodes) {
      const node = nodeOf.get(gn.id) as EtlNode;
      if (node.kind === 'sink' && (outdegree.get(gn.id) ?? 0) > 0) {
        throw new GraphError(`sink node '${gn.id}' must be terminal (no downstream nodes)`);
      }
    }

    // 入力（上流ノードid）を toInput 昇順で確定（ポートは一意なので同値はない）。
    const inputsOf = new Map<string, string[]>();
    for (const gn of graph.nodes) {
      const sorted = [...(incoming.get(gn.id) ?? [])].sort((a, b) => a.toInput - b.toInput);
      inputsOf.set(
        gn.id,
        sorted.map((e) => e.from),
      );
    }

    // 7. 終端（出次数0）がちょうど1つ。未接続の agent-input はTool引数の宣言として
    //    使えるため、他の実行終端がある場合だけ終端候補から外す。
    const rawTerminals = graph.nodes.filter((gn) => (outdegree.get(gn.id) ?? 0) === 0);
    const terminals = rawTerminals.length > 1
      ? rawTerminals.filter((gn) => gn.type !== 'agent-input')
      : rawTerminals;
    if (terminals.length === 0) {
      throw new GraphError('graph has no terminal node (out-degree 0)');
    }
    if (terminals.length > 1) {
      const ids = terminals.map((t) => t.id).join(', ');
      throw new GraphError(`graph must have exactly one terminal node, found ${terminals.length}: ${ids}`);
    }
    const terminalId = (terminals[0] as GraphNode).id;

    return { order, nodeById, nodeOf, inputsOf, terminalId };
  }
}

/** 例外から issue 用のメッセージを取り出す（非 Error も文字列化する）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * テーブルの行を上限まで切り詰める。超過時のみ `truncated:true`。
 * スキーマは保持。入力テーブルは破壊的変更しない。
 */
function limitRows(table: Table, rowLimit: number): { table: Table; truncated: boolean } {
  if (table.rows.length <= rowLimit) {
    return { table, truncated: false };
  }
  return {
    table: { schema: table.schema, rows: table.rows.slice(0, rowLimit) },
    truncated: true,
  };
}
