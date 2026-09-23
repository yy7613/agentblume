/**
 * ドメイン層: グラフの編集操作（v47 実装契約 §4 / ADR-0051 決定 1・2）— 純関数のみ。
 *
 * 設計アシスタントはグラフ全体ではなく**編集操作**を返す。人が組んだ配置と設定を壊さず、
 * 何が変わったかを一覧で見せられるようにするため（ADR-0051）。
 *
 * その操作をグラフへ当てるのがここ。**配線は関数が決める**のが肝で、
 * 「この後ろに足す」と言われたら既存の出力エッジの付け替えまでこちらで行う
 * （モデルにエッジを書かせる場面を減らすほど、12B 級でも壊れにくい）。
 *
 * 守る線引き:
 * - **意味を補わない**。列名を直さない、config を解釈しない、足りない設定を埋めない。
 *   config は丸ごと受け取って丸ごと置く（中身の正しさはスキーマ伝播と各ノードの検証の仕事）。
 * - 違反は必ず `GraphEditError` で止める。黙って読み替えると、モデルの書き癖が直らないまま
 *   別のノードが壊れる。文面には**何番目の操作の何が悪いか**と**直し方**を入れる（差し戻しの材料）。
 * - 入力のグラフは変異させない（返るのは新しい `ToolGraph`）。
 */
import { isRecord } from '../shared/assert';
import { GraphError } from './errors';
import type { GraphEdge, GraphNode, ToolGraph } from './graph';
import type { NodeId } from './ids';

/**
 * ノード id の形（契約 §4）。小文字英字で始まり、英小文字・数字・ハイフンだけの 1〜40 文字。
 * 実行には効かないが、モデルが `Sort_1` や日本語の id を書くと UI と差分表示が読みにくくなる。
 */
export const NODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** `toInput` に許す値（2 入力ノードの左右）。入次数そのものの検査は `EtlEngine` が行う。 */
const INPUT_PORTS: readonly number[] = [0, 1];

/** 編集操作 5 種（契約 §4）。モデルの応答はこの語彙だけを使う。 */
export type GraphOperation =
  | {
    readonly op: 'add-node';
    readonly id: NodeId;
    readonly type: string;
    readonly config?: unknown;
    /** 指定すると「その直後の鎖に挿入」する。省略すると孤立ノード（続く `connect` で繋ぐ）。 */
    readonly after?: NodeId;
  }
  | { readonly op: 'remove-node'; readonly id: NodeId }
  | { readonly op: 'set-config'; readonly id: NodeId; readonly config: unknown }
  | { readonly op: 'connect'; readonly from: NodeId; readonly to: NodeId; readonly toInput?: number }
  | { readonly op: 'disconnect'; readonly from: NodeId; readonly to: NodeId };

/**
 * 適用できた操作 1 件の記録（画面が一覧に出し、そのノードを強調する）。
 *
 * `summary` は決定的な英文。UI が日本語化しやすいよう、語彙と並びを固定した短い文にする
 * （文面で条件分岐させないため、原文は必ず `<動詞> <種別> '<id>'` で始める）。
 */
export interface GraphChange {
  readonly op: GraphOperation['op'];
  /** 強調するノード。`connect` / `disconnect` は入力を得た / 失った側（`to`）を指す。 */
  readonly nodeId: NodeId;
  readonly summary: string;
}

export interface GraphEditResult {
  readonly graph: ToolGraph;
  readonly applied: readonly GraphChange[];
}

/**
 * 編集操作をグラフへ当てられなかった（語彙の違反）。
 *
 * `GraphError` を継承するのは、万一ユースケースの外へ漏れても HTTP 422 ETL_GRAPH として
 * 扱われるようにするため（本来はユースケースが捕まえて差し戻しの材料にする）。
 */
export class GraphEditError extends GraphError {
  constructor(message: string) {
    super(message);
    this.name = 'GraphEditError';
  }
}

/** `summary` に載せる config 値 1 つ分の文字数上限（長い JSON で一覧が潰れないように）。 */
const VALUE_CHARS = 60;
/** `summary` の config 要約全体の文字数上限。 */
const DIGEST_CHARS = 200;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/**
 * config の要点を決定的な 1 行にする。
 *
 * キーの並びは受け取ったオブジェクトの並びのまま（同じ入力に同じ出力）。値は JSON のまま短く切る:
 * 種別ごとに文面を作り分けると、ノードを足すたびにここを直すことになる。
 */
export function summarizeConfig(config: unknown): string {
  if (config === undefined || config === null) return '';
  if (typeof config !== 'object' || Array.isArray(config)) return truncate(JSON.stringify(config) ?? '', DIGEST_CHARS);
  const entries = Object.entries(config as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${truncate(JSON.stringify(value) ?? 'null', VALUE_CHARS)}`);
  return truncate(entries.join(', '), DIGEST_CHARS);
}

/** 操作の位置を含む違反文（差し戻しでモデルが読む）。「何番目の何が悪いか」+「直し方」。 */
function violation(index: number, op: GraphOperation['op'], reason: string, fix: string): GraphEditError {
  return new GraphEditError(`operation ${index + 1} ('${op}'): ${reason}. ${fix}`);
}

/** 操作が名指しするノードを引く。無ければ違反（存在しない id への操作は契約 §4 で違反）。 */
function requireNode(nodes: readonly GraphNode[], id: unknown, index: number, op: GraphOperation['op'], role: string): GraphNode {
  if (typeof id !== 'string' || id === '') {
    throw violation(index, op, `${role} is missing`, `Set "${role}" to the id of a node that exists in the current graph.`);
  }
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    const known = nodes.map((candidate) => `'${candidate.id}'`).join(', ');
    throw violation(index, op, `${role} '${id}' is not a node in the current graph`, `Use one of the existing node ids (${known === '' ? 'the graph is empty' : known}), or add the node first with 'add-node'.`);
  }
  return node;
}

/** `add-node` を当てる。`after` があれば「その直後の鎖へ挿入」する（契約 §4 の表）。 */
function applyAddNode(
  graph: ToolGraph,
  operation: Extract<GraphOperation, { op: 'add-node' }>,
  index: number,
): { graph: ToolGraph; change: GraphChange } {
  const id = operation.id;
  if (typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) {
    throw violation(index, 'add-node', `the node id ${JSON.stringify(id ?? null)} does not match ${NODE_ID_PATTERN.source}`, 'Use lower-case letters, digits and hyphens only, starting with a letter (for example "sort-1").');
  }
  if (graph.nodes.some((node) => node.id === id)) {
    throw violation(index, 'add-node', `a node with the id '${id}' already exists`, `Pick a new id, or use 'set-config' to change the existing '${id}'.`);
  }
  if (typeof operation.type !== 'string' || operation.type === '') {
    throw violation(index, 'add-node', `the node type of '${id}' is missing`, 'Set "type" to one of the node types in the catalog.');
  }

  const node: GraphNode = { id, type: operation.type, config: operation.config ?? {} };
  const nodes = [...graph.nodes, node];
  const digest = summarizeConfig(node.config);

  if (operation.after === undefined) {
    // 孤立ノード。source を足すときと、2 入力ノードへ後から繋ぐときの経路（続く `connect` が繋ぐ）。
    return {
      graph: { nodes, edges: graph.edges },
      change: { op: 'add-node', nodeId: id, summary: `added ${node.type} '${id}'${digest === '' ? '' : ` with ${digest}`}` },
    };
  }

  const after = requireNode(graph.nodes, operation.after, index, 'add-node', 'after').id;
  const outgoing = graph.edges.filter((edge) => edge.from === after);
  // 出力が 1 本のときだけ鎖の途中へ割り込む。2 本以上は「どの枝の手前か」が決まらないので
  // 付け替えずに枝を 1 本増やすに留める（勝手に本流を選ぶと、別の枝の意味が静かに変わる）。
  const spliced = outgoing.length === 1;
  const edges: GraphEdge[] = graph.edges.map((edge) =>
    spliced && edge.from === after ? { from: id, to: edge.to, ...(edge.toInput === undefined ? {} : { toInput: edge.toInput }) } : edge);
  edges.push({ from: after, to: id });

  const target = outgoing[0];
  return {
    graph: { nodes, edges },
    change: {
      op: 'add-node',
      nodeId: id,
      summary: `added ${node.type} '${id}' after '${after}'${spliced && target !== undefined ? `, before '${target.to}'` : ''}${digest === '' ? '' : ` with ${digest}`}`,
    },
  };
}

/** `remove-node` を当てる。入力 1・出力 1 のときだけ上流と下流を直結する（契約 §4 の表）。 */
function applyRemoveNode(
  graph: ToolGraph,
  operation: Extract<GraphOperation, { op: 'remove-node' }>,
  index: number,
): { graph: ToolGraph; change: GraphChange } {
  const node = requireNode(graph.nodes, operation.id, index, 'remove-node', 'id');
  const incoming = graph.edges.filter((edge) => edge.to === node.id);
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  const source = incoming[0];
  const target = outgoing[0];
  // 直結できるのは鎖の途中だけ。分岐・合流の途中を外したときに繋ぎ直すと、どの枝を残すかを
  // こちらが決めることになる（意味を補わない）。
  const bridge = incoming.length === 1 && outgoing.length === 1 && source !== undefined && target !== undefined
    ? { from: source.from, to: target.to, ...(target.toInput === undefined ? {} : { toInput: target.toInput }) }
    : undefined;

  const edges: GraphEdge[] = [];
  for (const edge of graph.edges) {
    // 直結する辺は、外したノードの出力辺があった位置へ置く（辺の並び順を保ち、join の左右が入れ替わらない）。
    if (bridge !== undefined && edge.from === node.id) edges.push(bridge);
    if (edge.from === node.id || edge.to === node.id) continue;
    edges.push(edge);
  }

  return {
    graph: { nodes: graph.nodes.filter((candidate) => candidate.id !== node.id), edges },
    change: {
      op: 'remove-node',
      nodeId: node.id,
      summary: `removed ${node.type} '${node.id}'${bridge === undefined ? '' : `, connecting '${bridge.from}' to '${bridge.to}'`}`,
    },
  };
}

/** `set-config` を当てる。config は**丸ごと**置き換える（部分更新は無い）。 */
function applySetConfig(
  graph: ToolGraph,
  operation: Extract<GraphOperation, { op: 'set-config' }>,
  index: number,
): { graph: ToolGraph; change: GraphChange } {
  const node = requireNode(graph.nodes, operation.id, index, 'set-config', 'id');
  if (!isRecord(operation.config)) {
    throw violation(index, 'set-config', `the config of '${node.id}' is not an object`, 'Send the complete config object for that node type; it replaces the current one.');
  }
  return {
    graph: {
      // position は写す（`...node` が持つ）。人が並べたキャンバスを設定変更で崩さない。
      nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, config: operation.config } : candidate)),
      edges: graph.edges,
    },
    change: { op: 'set-config', nodeId: node.id, summary: `set config of ${node.type} '${node.id}': ${summarizeConfig(operation.config)}` },
  };
}

/** `connect` を当てる。`toInput` は 2 入力ノード（join / union）の左右だけ。 */
function applyConnect(
  graph: ToolGraph,
  operation: Extract<GraphOperation, { op: 'connect' }>,
  index: number,
): { graph: ToolGraph; change: GraphChange } {
  const from = requireNode(graph.nodes, operation.from, index, 'connect', 'from').id;
  const to = requireNode(graph.nodes, operation.to, index, 'connect', 'to');
  if (from === to.id) {
    throw violation(index, 'connect', `'${from}' cannot be connected to itself`, 'Connect two different nodes; a node never feeds itself.');
  }
  if (operation.toInput !== undefined && !INPUT_PORTS.includes(operation.toInput)) {
    throw violation(index, 'connect', `"toInput": ${JSON.stringify(operation.toInput)} is not an input port`, 'Use 0 (left) or 1 (right), and only on a node that takes two inputs (join, union). Leave it out everywhere else.');
  }
  if (graph.edges.some((edge) => edge.from === from && edge.to === to.id)) {
    throw violation(index, 'connect', `'${from}' is already connected to '${to.id}'`, `Leave the existing edge alone, or 'disconnect' it first if you want a different input port.`);
  }
  return {
    graph: {
      nodes: graph.nodes,
      edges: [...graph.edges, { from, to: to.id, ...(operation.toInput === undefined ? {} : { toInput: operation.toInput }) }],
    },
    change: {
      op: 'connect',
      nodeId: to.id,
      summary: `connected '${from}' to ${to.type} '${to.id}'${operation.toInput === undefined ? '' : ` on input ${operation.toInput}`}`,
    },
  };
}

/** `disconnect` を当てる。同じ 2 点を結ぶ辺をすべて外す。 */
function applyDisconnect(
  graph: ToolGraph,
  operation: Extract<GraphOperation, { op: 'disconnect' }>,
  index: number,
): { graph: ToolGraph; change: GraphChange } {
  const from = requireNode(graph.nodes, operation.from, index, 'disconnect', 'from').id;
  const to = requireNode(graph.nodes, operation.to, index, 'disconnect', 'to');
  const edges = graph.edges.filter((edge) => !(edge.from === from && edge.to === to.id));
  if (edges.length === graph.edges.length) {
    throw violation(index, 'disconnect', `there is no edge from '${from}' to '${to.id}'`, 'Only disconnect edges that exist in the current graph.');
  }
  return {
    graph: { nodes: graph.nodes, edges },
    change: { op: 'disconnect', nodeId: to.id, summary: `disconnected '${from}' from ${to.type} '${to.id}'` },
  };
}

/** id の綴りを畳んだ形（大小・`_`・空白・連続した区切りの違いを無視して同じ id と見なす）。 */
function foldNodeId(written: string): string {
  return written
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '');
}

/**
 * モデルが書いたノード id の**機械的な書き間違い**を、操作の適用前に決定的に直す（ADR-0047 の正規化と同じ判断）。
 *
 * 実測（12B）: 同じ応答の中で新しいノードを `source-e-stat` と名付けながら `after` には `source-e_stat` と
 * 書く、`region_input_node` のように `_` を使う、といった揺れが差し戻しでも直らなかった。
 * 綴りを畳んで一意に決まるものだけを直す:
 * - 既存ノードのどれか 1 つに畳んだ形が一致する参照は、その既存 id へ寄せる。
 * - `add-node` の新しい id は畳んだ形にし、同じ応答の中でその id（の揺れ）を指す参照も揃える。
 * 畳んでも規則に合わない・複数に当たる・何にも当たらない id は触らず、`applyGraphOperations` が理由つきで弾く。
 */
export function canonicalizeOperationIds(operations: readonly GraphOperation[], existingIds: readonly NodeId[]): GraphOperation[] {
  const byFold = new Map<string, NodeId[]>();
  const remember = (id: NodeId): void => {
    const folded = foldNodeId(id);
    const ids = byFold.get(folded) ?? [];
    if (!ids.includes(id)) byFold.set(folded, [...ids, id]);
  };
  for (const id of existingIds) remember(id);
  // 新しいノードは畳んだ形を id にする（規則に合う形へ寄せる）。既存と衝突しない場合だけ。
  const renamed = new Map<string, NodeId>();
  for (const operation of operations) {
    if (operation.op !== 'add-node') continue;
    const folded = foldNodeId(operation.id);
    if (!NODE_ID_PATTERN.test(folded) || byFold.has(folded)) { remember(operation.id); continue; }
    renamed.set(operation.id, folded);
    remember(folded);
  }
  const resolve = (written: NodeId): NodeId => {
    const direct = renamed.get(written);
    if (direct !== undefined) return direct;
    const candidates = byFold.get(foldNodeId(written)) ?? [];
    return candidates.length === 1 ? candidates[0]! : written;
  };
  return operations.map((operation) => {
    switch (operation.op) {
      case 'add-node':
        return { ...operation, id: renamed.get(operation.id) ?? operation.id, ...(operation.after === undefined ? {} : { after: resolve(operation.after) }) };
      case 'remove-node':
      case 'set-config':
        return { ...operation, id: resolve(operation.id) };
      case 'connect':
      case 'disconnect':
        return { ...operation, from: resolve(operation.from), to: resolve(operation.to) };
      default:
        return operation;
    }
  });
}

/**
 * 編集操作を順に当てる（純関数・同じ入力に同じ出力）。
 *
 * 操作は**いまのグラフ**に対する差分として順に評価する。途中で違反があれば全体を捨てて投げる:
 * 半分だけ当たったグラフを返すと、画面には「意味の無い途中の形」が展開され、
 * 取り消しでしか戻せなくなる。
 */
export function applyGraphOperations(graph: ToolGraph, operations: readonly GraphOperation[]): GraphEditResult {
  let current: ToolGraph = { nodes: graph.nodes, edges: graph.edges };
  const applied: GraphChange[] = [];

  operations.forEach((operation, index) => {
    const op = (operation as { op?: unknown })?.op;
    switch (op) {
      case 'add-node': {
        const result = applyAddNode(current, operation as Extract<GraphOperation, { op: 'add-node' }>, index);
        current = result.graph;
        applied.push(result.change);
        return;
      }
      case 'remove-node': {
        const result = applyRemoveNode(current, operation as Extract<GraphOperation, { op: 'remove-node' }>, index);
        current = result.graph;
        applied.push(result.change);
        return;
      }
      case 'set-config': {
        const result = applySetConfig(current, operation as Extract<GraphOperation, { op: 'set-config' }>, index);
        current = result.graph;
        applied.push(result.change);
        return;
      }
      case 'connect': {
        const result = applyConnect(current, operation as Extract<GraphOperation, { op: 'connect' }>, index);
        current = result.graph;
        applied.push(result.change);
        return;
      }
      case 'disconnect': {
        const result = applyDisconnect(current, operation as Extract<GraphOperation, { op: 'disconnect' }>, index);
        current = result.graph;
        applied.push(result.change);
        return;
      }
      default:
        throw new GraphEditError(`operation ${index + 1}: unknown operation ${JSON.stringify(op ?? null)}. Use one of 'add-node', 'remove-node', 'set-config', 'connect', 'disconnect'.`);
    }
  });

  return { graph: current, applied };
}
