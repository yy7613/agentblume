import { useEffect, useState } from 'react';
import type { ColumnDto, DataType, SchemaDto } from '../api/types';
import { catalogItem, type ToolNodeType } from './node-catalog';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

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
  const { text } = useI18n();

  useEffect(() => {
    if (node?.data.nodeType === 'json-source') {
      setJsonText(JSON.stringify(node.data.config['rows'] ?? [], null, 2));
      setJsonError(undefined);
    }
  }, [node?.id, node?.data.config]);

  if (node === undefined) return <aside className="inspector empty"><h2>{text('Inspector', 'インスペクター')}</h2><p>{text('Select a node.', 'ノードを選択してください。')}</p></aside>;
  const config = node.data.config;
  const setConfig = (patch: Record<string, unknown>) => update(node.id, { ...config, ...patch });
  const type = node.data.nodeType;

  return (
    <aside className="inspector" aria-label={text('Node inspector', 'ノードインスペクター')}>
      <span className="eyebrow">{catalogItem(type).kind === 'source' ? text('source', '入力') : text('transform', '変換')}</span>
      <h2>{text(catalogItem(type).label, catalogItem(type).labelJa)}</h2>
      <p>{text(catalogItem(type).description, catalogItem(type).descriptionJa)}</p>
      <datalist id="upstream-columns">{columns.map((column) => <option key={column.name} value={column.name} />)}</datalist>
      {type === 'agent-input' && <AgentInputFields key={node.id} config={config} setConfig={setConfig} />}
      {type === 'json-source' && (
        <label>{text('JSON rows', 'JSON行')}<textarea rows={12} value={jsonText} onChange={(event) => {
          const text = event.target.value; setJsonText(text);
          try { const rows = JSON.parse(text) as unknown; if (!Array.isArray(rows)) throw new Error('配列を入力してください'); setJsonError(undefined); setConfig({ rows }); }
          catch (error) { setJsonError(error instanceof Error ? error.message : 'Invalid JSON'); }
        }} />{jsonError !== undefined && <small className="field-error">{jsonError}</small>}</label>
      )}
      {type === 'csv-source' && <CsvFields config={config} setConfig={setConfig} />}
      {type === 'select' && <label>{text('Columns', '列')}<input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label>}
      {type === 'filter' && <FilterFields config={config} setConfig={setConfig} columns={columns} />}
      {type === 'rename' && <label>{text('Renames', '列名変更')} <small>{text('one from:to pair per line', '1行に from:to')}</small><textarea rows={8} value={(config['renames'] as {from:string;to:string}[] | undefined)?.map((pair) => `${pair.from}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ renames: parsePairs(event.target.value, 'to') })} /></label>}
      {type === 'cast' && <label>{text('Casts', '型変換')} <small>{text('one column:type pair per line', '1行に column:type')}</small><textarea rows={8} value={(config['casts'] as {column:string;to:string}[] | undefined)?.map((pair) => `${pair.column}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ casts: parsePairs(event.target.value, 'type') })} /></label>}
      {columns.length > 0 && <div className="column-hints"><strong>{text('Upstream columns', '上流の列')}</strong>{columns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
    </aside>
  );
}

const DATA_TYPES: readonly DataType[] = ['string', 'number', 'boolean', 'date', 'null', 'unknown'];

function columnsText(schema: SchemaDto | undefined): string {
  return (schema?.columns ?? []).map((column) => `${column.name}:${column.type}:${column.nullable ? 'optional' : 'required'}`).join('\n');
}

function parseColumns(value: string): ColumnDto[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', rawType = '', presence = 'required'] = line.split(':').map((part) => part.trim());
    if (name === '') throw new Error('列名が必要です');
    if (!DATA_TYPES.includes(rawType as DataType)) throw new Error(`未対応の型です: ${rawType}`);
    if (presence !== 'required' && presence !== 'optional') throw new Error(`required/optionalを指定してください: ${presence}`);
    return { name, type: rawType as DataType, nullable: presence === 'optional' };
  });
}

function AgentInputFields({ config, setConfig }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void }) {
  const { text } = useI18n();
  const schema = config['schema'] as SchemaDto | undefined;
  const sample = config['sample'] as Readonly<Record<string, unknown>> | undefined;
  const [schemaValue, setSchemaValue] = useState(columnsText(schema));
  const [sampleValue, setSampleValue] = useState(JSON.stringify(sample ?? {}, null, 2));
  const [schemaError, setSchemaError] = useState<string>();
  const [sampleError, setSampleError] = useState<string>();
  return <>
    <label>{text('Input columns', '入力列')} <small>name:type:required|optional</small><textarea aria-label={text('Input columns', '入力列')} rows={7} value={schemaValue} onChange={(event) => {
      const value = event.target.value; setSchemaValue(value);
      try { const columns = parseColumns(value); setSchemaError(undefined); setConfig({ schema: { columns } }); }
      catch (error) { setSchemaError(error instanceof Error ? error.message : 'Invalid schema'); }
    }} />{schemaError !== undefined && <small className="field-error">{schemaError}</small>}</label>
    <label>{text('Sample arguments', 'サンプル引数')}<textarea aria-label={text('Sample arguments', 'サンプル引数')} rows={8} value={sampleValue} onChange={(event) => {
      const value = event.target.value; setSampleValue(value);
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON objectを入力してください');
        setSampleError(undefined); setConfig({ sample: parsed });
      } catch (error) { setSampleError(error instanceof Error ? error.message : 'Invalid JSON'); }
    }} />{sampleError !== undefined && <small className="field-error">{sampleError}</small>}</label>
  </>;
}

function CsvFields({ config, setConfig }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void }) {
  const { text } = useI18n();
  return <>
    <label>{text('CSV text', 'CSVテキスト')}<textarea rows={10} value={String(config['text'] ?? '')} onChange={(event) => setConfig({ text: event.target.value })} /></label>
    <label>{text('Delimiter', '区切り文字')}<input maxLength={1} value={String(config['delimiter'] ?? ',')} onChange={(event) => setConfig({ delimiter: event.target.value })} /></label>
    <label className="check"><input type="checkbox" checked={config['header'] !== false} onChange={(event) => setConfig({ header: event.target.checked })} /> {text('Header row', 'ヘッダー行')}</label>
    <label className="check"><input type="checkbox" checked={config['inferTypes'] !== false} onChange={(event) => setConfig({ inferTypes: event.target.checked })} /> {text('Infer types', '型を推論')}</label>
  </>;
}

function FilterFields({ config, setConfig, columns }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void; columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const op = String(config['op'] ?? 'eq');
  const column = String(config['column'] ?? '');
  const columnType = columns.find((candidate) => candidate.name === column)?.type;
  return <>
    <label>{text('Column', '列')}<input list="upstream-columns" value={column} onChange={(event) => setConfig({ column: event.target.value })} /></label>
    <label>{text('Operator', '演算子')}<select value={op} onChange={(event) => setConfig({ op: event.target.value })}>{['eq','neq','gt','gte','lt','lte','contains','isNull','notNull'].map((value) => <option key={value}>{value}</option>)}</select></label>
    {!['isNull', 'notNull'].includes(op) && <label>{text('Value', '値')}<input value={String(config['value'] ?? '')} onChange={(event) => setConfig({ value: columnType === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value })} /></label>}
  </>;
}
