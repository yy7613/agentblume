import { useEffect, useState } from 'react';
import type { ColumnDto } from '../api/types';
import { catalogItem, type ToolNodeType } from './node-catalog';
import { useToolBuilderStore } from './store';

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePairs(
  value: string,
  rightKey: 'to' | 'type',
): Array<{ from: string; to: string } | { column: string; to: string }> {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [left = '', right = ''] = line.split(':', 2).map((part) => part.trim());
    return rightKey === 'to' ? { from: left, to: right } : { column: left, to: right };
  });
}

const EMPTY_COLUMNS: readonly ColumnDto[] = [];

export function NodeInspector() {
  const selectedNodeId = useToolBuilderStore((state) => state.selectedNodeId);
  const node = useToolBuilderStore((state) => state.nodes.find((candidate) => candidate.id === selectedNodeId));
  const update = useToolBuilderStore((state) => state.updateNodeConfig);
  const columns = useToolBuilderStore((state) => {
    if (selectedNodeId === undefined) return EMPTY_COLUMNS;
    const sourceId = state.edges.find((edge) => edge.target === selectedNodeId)?.source;
    return sourceId === undefined
      ? EMPTY_COLUMNS
      : (state.propagation?.nodes[sourceId]?.schema.columns ?? EMPTY_COLUMNS);
  });
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string>();

  useEffect(() => {
    if (node?.data.nodeType === 'json-source') {
      setJsonText(JSON.stringify(node.data.config['rows'] ?? [], null, 2));
      setJsonError(undefined);
    }
  }, [node?.id, node?.data.config]);

  if (node === undefined) return <aside className="inspector empty"><h2>Inspector</h2><p>ノードを選択してください。</p></aside>;
  const config = node.data.config;
  const setConfig = (patch: Record<string, unknown>) => update(node.id, { ...config, ...patch });
  const type = node.data.nodeType;

  return (
    <aside className="inspector" aria-label="Node inspector">
      <span className="eyebrow">{catalogItem(type).kind}</span>
      <h2>{catalogItem(type).label}</h2>
      <p>{catalogItem(type).description}</p>
      <datalist id="upstream-columns">{columns.map((column) => <option key={column.name} value={column.name} />)}</datalist>
      {type === 'json-source' && (
        <label>JSON rows<textarea rows={12} value={jsonText} onChange={(event) => {
          const text = event.target.value; setJsonText(text);
          try { const rows = JSON.parse(text) as unknown; if (!Array.isArray(rows)) throw new Error('配列を入力してください'); setJsonError(undefined); setConfig({ rows }); }
          catch (error) { setJsonError(error instanceof Error ? error.message : 'Invalid JSON'); }
        }} />{jsonError !== undefined && <small className="field-error">{jsonError}</small>}</label>
      )}
      {type === 'csv-source' && <CsvFields config={config} setConfig={setConfig} />}
      {type === 'select' && <label>Columns<input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label>}
      {type === 'filter' && <FilterFields config={config} setConfig={setConfig} columns={columns} />}
      {type === 'rename' && <label>Renames <small>1行に from:to</small><textarea rows={8} value={(config['renames'] as {from:string;to:string}[] | undefined)?.map((pair) => `${pair.from}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ renames: parsePairs(event.target.value, 'to') })} /></label>}
      {type === 'cast' && <label>Casts <small>1行に column:type</small><textarea rows={8} value={(config['casts'] as {column:string;to:string}[] | undefined)?.map((pair) => `${pair.column}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ casts: parsePairs(event.target.value, 'type') })} /></label>}
      {columns.length > 0 && <div className="column-hints"><strong>Upstream columns</strong>{columns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
    </aside>
  );
}

function CsvFields({ config, setConfig }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void }) {
  return <>
    <label>CSV text<textarea rows={10} value={String(config['text'] ?? '')} onChange={(event) => setConfig({ text: event.target.value })} /></label>
    <label>Delimiter<input maxLength={1} value={String(config['delimiter'] ?? ',')} onChange={(event) => setConfig({ delimiter: event.target.value })} /></label>
    <label className="check"><input type="checkbox" checked={config['header'] !== false} onChange={(event) => setConfig({ header: event.target.checked })} /> Header row</label>
    <label className="check"><input type="checkbox" checked={config['inferTypes'] !== false} onChange={(event) => setConfig({ inferTypes: event.target.checked })} /> Infer types</label>
  </>;
}

function FilterFields({ config, setConfig, columns }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void; columns: readonly ColumnDto[] }) {
  const op = String(config['op'] ?? 'eq');
  const column = String(config['column'] ?? '');
  const columnType = columns.find((candidate) => candidate.name === column)?.type;
  return <>
    <label>Column<input list="upstream-columns" value={column} onChange={(event) => setConfig({ column: event.target.value })} /></label>
    <label>Operator<select value={op} onChange={(event) => setConfig({ op: event.target.value })}>{['eq','neq','gt','gte','lt','lte','contains','isNull','notNull'].map((value) => <option key={value}>{value}</option>)}</select></label>
    {!['isNull', 'notNull'].includes(op) && <label>Value<input value={String(config['value'] ?? '')} onChange={(event) => setConfig({ value: columnType === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value })} /></label>}
  </>;
}
