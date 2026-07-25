/**
 * 自動プレビュー（infer-schema / preview）を投げる前のローカル事前判定。
 *
 * 既定configが空のまま追加された直後のノードは、サーバーの validateConfig が必ず
 * ConfigError（422・英語Zodメッセージ）を返し、propagationも失われる。要求せずUIで
 * 「設定が未完了です」と伝えるため、確実に422になる空設定だけを対象にする
 * （列の欠損・型不一致などサーバーの検証結果が有用なものは対象にしない）。
 */
import type { ToolNodeType } from './node-catalog';
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
