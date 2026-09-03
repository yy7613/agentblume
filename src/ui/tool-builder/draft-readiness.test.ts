import { describe, expect, it } from 'vitest';
import { incompleteConfigNodeIds, unconnectedNodeIds } from './draft-readiness';
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

describe('unconnectedNodeIds', () => {
  const edge = (source: string, target: string) => ({ source, target });
  const source = node('source-1', 'json-source', { rows: [] });
  const filter = node('filter-1', 'filter', { column: 'age', op: 'gte', value: 18 });
  const output = node('agent-output-1', 'agent-output', {});

  it('ソースから出力ノードまで一本に繋がったグラフでは空', () => {
    expect(unconnectedNodeIds([source, filter, output], [edge('source-1', 'filter-1'), edge('filter-1', 'agent-output-1')])).toEqual([]);
    // ソース1つだけのグラフも（終端が1つなので）空。
    expect(unconnectedNodeIds([source], [])).toEqual([]);
  });

  it('入力を取るノードに入力が無ければ挙げる', () => {
    // filter-1 に入力が無い。終端は filter-1 と source-1 の2つになるので source-1 も並ぶ。
    expect(unconnectedNodeIds([source, filter], [])).toEqual(['source-1', 'filter-1']);
    // select-1 だけが浮いている（source→filter は繋がっている）。終端は filter-1 と select-1。
    const select = node('select-1', 'select', { columns: [] });
    expect(unconnectedNodeIds([source, filter, select], [edge('source-1', 'filter-1')])).toEqual(['filter-1', 'select-1']);
  });

  it('出力の無いノードが2つ以上あれば、孤立したソースを含めて全部挙げる', () => {
    const csv = node('csv-1', 'csv-source', { text: 'a\n1' });
    expect(unconnectedNodeIds([source, filter, csv], [edge('source-1', 'filter-1')])).toEqual(['filter-1', 'csv-1']);
  });

  it('agent-input は引数の宣言なので、未接続でも挙げない', () => {
    const args = node('args', 'agent-input', { schema: { columns: [] }, sample: {} });
    expect(unconnectedNodeIds([args, source, filter], [edge('source-1', 'filter-1')])).toEqual([]);
    // agent-input が孤立していても、他に浮いたノードがあればそちらだけを挙げる。
    const select = node('select-1', 'select', { columns: [] });
    expect(unconnectedNodeIds([args, source, filter, select], [edge('source-1', 'filter-1')])).toEqual(['filter-1', 'select-1']);
  });

  it('2入力ノードは片側だけ繋がっていても未接続とは言わない（本数不足はサーバーの検証に任せる）', () => {
    const join = node('join-1', 'join', { mode: 'inner', keys: [], rightSuffix: '_right' });
    expect(unconnectedNodeIds([source, join], [edge('source-1', 'join-1')])).toEqual([]);
    expect(unconnectedNodeIds([source, join], [])).toEqual(['source-1', 'join-1']);
  });

  it('空のグラフと、agent-input だけのグラフは空', () => {
    expect(unconnectedNodeIds([], [])).toEqual([]);
    expect(unconnectedNodeIds([node('args', 'agent-input', { schema: { columns: [] }, sample: {} })], [])).toEqual([]);
  });

  it('出力ノードが2つあれば（どちらも繋がっていても）両方挙げる', () => {
    const second = node('workspace-output-1', 'workspace-output', {});
    expect(unconnectedNodeIds(
      [source, filter, output, second],
      [edge('source-1', 'filter-1'), edge('filter-1', 'agent-output-1'), edge('filter-1', 'workspace-output-1')],
    )).toEqual(['agent-output-1', 'workspace-output-1']);
  });

  it('カタログに無い型は入力を取ると見なす（安全側）', () => {
    const odd = node('odd-1', 'not-a-node-type' as ToolNodeType, {});
    expect(unconnectedNodeIds([source, odd], [edge('source-1', 'odd-1')])).toEqual([]);
    expect(unconnectedNodeIds([source, odd], [])).toEqual(['source-1', 'odd-1']);
  });

  it('存在しないノードを指すエッジがあっても落ちず、実在ノードの判定に影響しない', () => {
    expect(unconnectedNodeIds([source, filter], [edge('source-1', 'filter-1'), edge('ghost-a', 'ghost-b'), edge('ghost-c', 'filter-1')])).toEqual([]);
    // 幽霊ノードからの入力だけで in-degree を満たしていても、それは別の検査（サーバー）の領分。
    expect(unconnectedNodeIds([source, filter], [edge('ghost-a', 'filter-1')])).toEqual(['source-1', 'filter-1']);
  });

  it('循環は入力も出力もあるのでこの判定では挙げない（循環自体はサーバーの GraphError に任せる）', () => {
    const second = node('filter-2', 'filter', { column: 'age', op: 'lt', value: 65 });
    expect(unconnectedNodeIds(
      [source, filter, second],
      [edge('source-1', 'filter-1'), edge('filter-1', 'filter-2'), edge('filter-2', 'filter-1')],
    )).toEqual([]);
  });

  it('返す順序はノード配列の順（エッジや検出順ではない）', () => {
    const csv = node('csv-1', 'csv-source', { text: 'a\n1' });
    expect(unconnectedNodeIds([csv, filter, source], [edge('source-1', 'filter-1')])).toEqual(['csv-1', 'filter-1']);
  });
});
