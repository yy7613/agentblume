import { describe, expect, it } from 'vitest';
import { incompleteConfigNodeIds } from './draft-readiness';
import type { ToolFlowNode } from './store';
import type { ToolNodeType } from './node-catalog';

function node(id: string, nodeType: ToolNodeType, config: Readonly<Record<string, unknown>>): ToolFlowNode {
  return { id, type: 'tool', position: { x: 0, y: 0 }, data: { nodeType, label: id, config } };
}

describe('incompleteConfigNodeIds', () => {
  it('設定済みノードと事前判定の対象外ノードは空配列を返す', () => {
    expect(incompleteConfigNodeIds([
      node('json-1', 'json-source', { rows: [] }),
      // filterのcolumn未入力はサーバーが有用なissueを返すので事前判定の対象外。
      node('filter-1', 'filter', { column: '', op: 'eq', value: '' }),
      node('db-1', 'database-source', { dataSourceId: 'ds-1', table: 'public.sales', limit: 10 }),
      node('web-1', 'web-search-source', { provider: 'tavily', query: 'agentblume', maxResults: 5 }),
      node('ts-1', 'time-series-analysis', { timeColumn: 'day', valueColumns: ['amount'] }),
      node('graph-1', 'graph-output', { graph: { sourceColumn: 'id', targetColumn: 'name' } }),
      node('graph-2', 'graph-output', { graph: { mode: 'correlation-network', columnX: 'a', columnY: 'b' } }),
    ])).toEqual([]);
  });

  it('必須設定が空のノードIDを列挙する', () => {
    expect(incompleteConfigNodeIds([
      node('db-1', 'database-source', { dataSourceId: '', table: '' }),
      node('db-2', 'database-source', { dataSourceId: 'ds-1', table: '  ' }),
      node('web-1', 'web-search-source', { provider: '', query: 'x' }),
      node('web-2', 'web-search-source', { provider: 'tavily' }),
      node('ts-1', 'time-series-analysis', { timeColumn: '', valueColumns: ['amount'] }),
      node('ts-2', 'time-series-analysis', { timeColumn: 'day', valueColumns: [] }),
      node('ts-3', 'time-series-analysis', { timeColumn: 'day' }),
      node('graph-1', 'graph-output', { graph: { sourceColumn: '', targetColumn: 'name' } }),
      node('graph-2', 'graph-output', { graph: { sourceColumn: 'id', targetColumn: '' } }),
      node('graph-3', 'graph-output', {}),
      node('graph-4', 'graph-output', { graph: null }),
      node('graph-5', 'graph-output', { graph: { mode: 'correlation-network', columnX: 'a', columnY: '' } }),
    ]).length).toBe(12);
  });
});
