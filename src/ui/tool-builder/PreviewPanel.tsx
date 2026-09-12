import { useMemo } from 'react';
import type { JsonCell, TableDto } from '../api/types';
import { localizeSchemaIssueMessage } from '../api/error-messages';
import { unconnectedNodeIds } from './draft-readiness';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

function displayCell(value: JsonCell): string {
  return value === null ? 'null' : String(value);
}

export function PreviewPanel() {
  const selectedNodeId = useToolBuilderStore((state) => state.selectedNodeId);
  const propagation = useToolBuilderStore((state) => state.propagation);
  const preview = useToolBuilderStore((state) => state.preview);
  const loading = useToolBuilderStore((state) => state.previewLoading);
  // ここは自動検証(草案)の結果だけを表示する。保存失敗は保存ボタン近傍に出す。
  const draftIssue = useToolBuilderStore((state) => state.draftIssue);
  const nodes = useToolBuilderStore((state) => state.nodes);
  const edges = useToolBuilderStore((state) => state.edges);
  // サーバーの GraphError は「終端が2つ」としか言わないので、どのノードが繋がっていないかを名指しで補う。
  const unconnected = useMemo(() => unconnectedNodeIds(nodes, edges), [nodes, edges]);
  const { text, language } = useI18n();
  const nodeId = selectedNodeId ?? preview?.terminalId;
  const inference = nodeId === undefined ? undefined : propagation?.nodes[nodeId];
  const nodePreview = nodeId === undefined ? undefined : preview?.nodes[nodeId];
  const table = nodePreview?.table ?? (nodeId === preview?.terminalId ? preview?.output : undefined);

  return (
    <section className="preview-panel" aria-label={text('Preview', 'プレビュー')}>
      <div className="panel-title"><div><span className="eyebrow">{text('Preview', 'プレビュー')}</span><h2>{nodeId ?? text('No node selected', 'ノード未選択')}</h2></div>{loading && <span className="spinner">{text('Updating…', '更新中…')}</span>}</div>
      {draftIssue !== undefined && <div className="api-error" role="alert">{draftIssue}</div>}
      {unconnected.length > 0 && <div className="inline-issue warning unconnected-notice">{text(`Not connected: ${unconnected.join(', ')}. Connect every node into the flow that ends at the output node.`, `未接続のノード: ${unconnected.join('、')}。出力ノードへ至る流れにつなげてください`)}</div>}
      {inference !== undefined && <div className="schema-strip">{inference.schema.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.type}{column.nullable ? ' · nullable' : ''}</span></div>)}</div>}
      {inference?.issues.map((issue, index) => <div className={`inline-issue ${issue.severity}`} key={`${issue.message}-${index}`}>{localizeSchemaIssueMessage(issue.message, language)}</div>)}
      {table === undefined ? <p className="empty-state">{text('Sample rows appear when the graph is valid.', 'グラフが有効になるとサンプル行が表示されます。')}</p> : <TablePreview table={table} truncated={nodePreview?.truncated ?? false} rowCount={nodePreview?.rowCount ?? table.rows.length} />}
    </section>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function TablePreview({ table, truncated, rowCount }: { readonly table: TableDto; readonly truncated: boolean; readonly rowCount: number }) {
  const { text } = useI18n();
  const shown = table.rows.length;
  // 表は表示用スナップショットに過ぎない（計算は全行で行われている）。全行数を必ず添えて、
  // 「このノードは 100 行しか出していない」と誤読させない。
  const summary = truncated
    ? text(`Showing ${formatCount(shown)} of ${formatCount(rowCount)} rows.`, `全 ${formatCount(rowCount)} 行のうち ${formatCount(shown)} 行を表示`)
    : text(`${formatCount(rowCount)} row${rowCount === 1 ? '' : 's'}`, `${formatCount(rowCount)} 行`);
  return <div className="table-wrap"><table><thead><tr>{table.schema.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{table.schema.columns.map((column) => <td key={column.name}>{displayCell(row[column.name] ?? null)}</td>)}</tr>)}</tbody></table><small className="row-count">{summary}</small></div>;
}
