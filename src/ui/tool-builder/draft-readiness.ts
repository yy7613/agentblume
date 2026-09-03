/**
 * 自動プレビュー（infer-schema / preview）を投げる前のローカル事前判定。
 *
 * 既定configが空のまま追加された直後のノードは、サーバーの validateConfig が必ず
 * ConfigError（422・英語Zodメッセージ）を返し、propagationも失われる。要求せずUIで
 * 「設定が未完了です」と伝えるため、確実に422になる空設定だけを対象にする
 * （列の欠損・型不一致などサーバーの検証結果が有用なものは対象にしない）。
 */
import type { Edge } from '@xyflow/react';
import { catalogItem, type ToolNodeType } from './node-catalog';
import type { ToolFlowNode } from './store';

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function graphMappingIncomplete(graph: unknown): boolean {
  if (graph === null || typeof graph !== 'object') return true;
  const mapping = graph as Record<string, unknown>;
  return mapping['mode'] === 'correlation-network'
    ? blank(mapping['columnX']) || blank(mapping['columnY'])
    : blank(mapping['sourceColumn']) || blank(mapping['targetColumn']);
}

const INCOMPLETE_CHECKS: Partial<Record<ToolNodeType, (config: Readonly<Record<string, unknown>>) => boolean>> = {
  'database-source': (config) => blank(config['dataSourceId']) || blank(config['table']),
  'web-search-source': (config) => blank(config['provider']) || blank(config['query']),
  'time-series-analysis': (config) => blank(config['timeColumn']) || !Array.isArray(config['valueColumns']) || config['valueColumns'].length === 0,
  'graph-output': (config) => graphMappingIncomplete(config['graph']),
};

/** 必須設定が空のままのノードID（自動検証へ送ると422になるもの）。 */
export function incompleteConfigNodeIds(nodes: readonly ToolFlowNode[]): readonly string[] {
  return nodes
    .filter((node) => INCOMPLETE_CHECKS[node.data.nodeType]?.(node.data.config) === true)
    .map((node) => node.id);
}

/**
 * 出力ノードへ至る流れに繋がっていないノードのID。
 *
 * サーバーの GraphError（終端が複数 / in-degree 不足）は「どのノードを繋げばよいか」を語らないため、
 * ここで具体的なノード名を挙げる。判定は次の2つ:
 * - 入力を取るノード（inputArity > 0）なのに入力が1本も無い。
 * - 出力の無いノード（out-degree 0）が2つ以上ある（終端は1つだけのはずなので、全部を挙げる）。
 * agent-input は引数の宣言であって流れに乗らない（未接続が正しい）ため対象外。
 */
export function unconnectedNodeIds(nodes: readonly ToolFlowNode[], edges: readonly Pick<Edge, 'source' | 'target'>[]): readonly string[] {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
  }
  const candidates = nodes.filter((node) => node.data.nodeType !== 'agent-input');
  const flagged = new Set<string>();
  for (const node of candidates) {
    // 未知の型（カタログ外）は入力を取ると見なして安全側に寄せる。
    const arity = (catalogItem(node.data.nodeType) as { inputArity?: number } | undefined)?.inputArity ?? 1;
    if (arity > 0 && (inDegree.get(node.id) ?? 0) === 0) flagged.add(node.id);
  }
  const terminals = candidates.filter((node) => (outDegree.get(node.id) ?? 0) === 0);
  if (terminals.length > 1) for (const node of terminals) flagged.add(node.id);
  return candidates.filter((node) => flagged.has(node.id)).map((node) => node.id);
}
