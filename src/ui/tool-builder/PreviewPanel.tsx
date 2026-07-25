import type { JsonCell, TableDto } from '../api/types';
import { localizeSchemaIssueMessage } from '../api/error-messages';
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
  const { text, language } = useI18n();
  const nodeId = selectedNodeId ?? preview?.terminalId;
  const inference = nodeId === undefined ? undefined : propagation?.nodes[nodeId];
  const nodePreview = nodeId === undefined ? undefined : preview?.nodes[nodeId];
  const table = nodePreview?.table ?? (nodeId === preview?.terminalId ? preview?.output : undefined);

  return (
    <section className="preview-panel" aria-label={text('Preview', 'プレビュー')}>
      <div className="panel-title"><div><span className="eyebrow">{text('Preview', 'プレビュー')}</span><h2>{nodeId ?? text('No node selected', 'ノード未選択')}</h2></div>{loading && <span className="spinner">{text('Updating…', '更新中…')}</span>}</div>
      {draftIssue !== undefined && <div className="api-error" role="alert">{draftIssue}</div>}
      {inference !== undefined && <div className="schema-strip">{inference.schema.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.type}{column.nullable ? ' · nullable' : ''}</span></div>)}</div>}
      {inference?.issues.map((issue, index) => <div className={`inline-issue ${issue.severity}`} key={`${issue.message}-${index}`}>{localizeSchemaIssueMessage(issue.message, language)}</div>)}
      {table === undefined ? <p className="empty-state">{text('Sample rows appear when the graph is valid.', 'グラフが有効になるとサンプル行が表示されます。')}</p> : <TablePreview table={table} truncated={nodePreview?.truncated ?? false} />}
    </section>
  );
}

function TablePreview({ table, truncated }: { readonly table: TableDto; readonly truncated: boolean }) {
  const { text } = useI18n();
  return <div className="table-wrap"><table><thead><tr>{table.schema.columns.map((column) => <th key={column.name}>{column.name}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{table.schema.columns.map((column) => <td key={column.name}>{displayCell(row[column.name] ?? null)}</td>)}</tr>)}</tbody></table>{truncated && <small>{text('Truncated to 100 rows.', '100行で切り詰めました。')}</small>}</div>;
}
