import { useEffect, useState } from 'react';
import type { ColumnDto, DataType, JsonCell, SchemaDto } from '../api/types';
import { catalogItem, toInputOf, type ToolNodeType } from './node-catalog';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

interface JoinKeyDraft { readonly left: string; readonly right: string }
interface SortKeyDraft { readonly column: string; readonly direction?: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' }
interface FillRuleDraft { readonly column: string; readonly strategy: string; readonly value?: JsonCell }
interface ReplaceRuleDraft { readonly column: string; readonly from: JsonCell; readonly to: JsonCell }

/** 列型に合わせてテキスト入力値を number/boolean へ寄せる（null にはしない）。 */
function coerceScalar(raw: string, type?: DataType): Exclude<JsonCell, null> {
  if (type === 'number' && raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
}

/** replace の from/to 用: 'null' は null リテラル、他は列型で寄せる。 */
function coerceCell(raw: string, type?: DataType): JsonCell {
  return raw === 'null' ? null : coerceScalar(raw, type);
}

function cellText(cell: JsonCell | undefined): string {
  return cell === null ? 'null' : String(cell ?? '');
}

function parseSortKeys(value: string): SortKeyDraft[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [column = '', direction = '', nulls = ''] = line.split(':').map((part) => part.trim());
    return {
      column,
      ...(direction === 'asc' || direction === 'desc' ? { direction } : {}),
      ...(nulls === 'first' || nulls === 'last' ? { nulls } : {}),
    };
  });
}

function parseReplaceRules(value: string, columns: readonly ColumnDto[]): ReplaceRuleDraft[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [column = '', from = '', to = ''] = line.split(':').map((part) => part.trim());
    const type = columns.find((candidate) => candidate.name === column)?.type;
    return { column, from: coerceCell(from, type), to: coerceCell(to, type) };
  });
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
  // 2入力ノード用: 左（toInput:0）/ 右（toInput:1）それぞれの上流スキーマ列。
  const leftColumns = useToolBuilderStore((state) => {
    if (selectedNodeId === undefined) return EMPTY_COLUMNS;
    const edge = state.edges.find((candidate) => candidate.target === selectedNodeId && (toInputOf(candidate.targetHandle) ?? 0) === 0);
    return edge === undefined ? EMPTY_COLUMNS : (state.propagation?.nodes[edge.source]?.schema.columns ?? EMPTY_COLUMNS);
  });
  const rightColumns = useToolBuilderStore((state) => {
    if (selectedNodeId === undefined) return EMPTY_COLUMNS;
    const edge = state.edges.find((candidate) => candidate.target === selectedNodeId && toInputOf(candidate.targetHandle) === 1);
    return edge === undefined ? EMPTY_COLUMNS : (state.propagation?.nodes[edge.source]?.schema.columns ?? EMPTY_COLUMNS);
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
      {type === 'join' && <JoinFields config={config} setConfig={setConfig} leftColumns={leftColumns} rightColumns={rightColumns} />}
      {type === 'union' && <label className="check"><input type="checkbox" checked={config['strict'] === true} onChange={(event) => setConfig({ strict: event.target.checked })} /> {text('Strict column match', '列名の完全一致を要求')}</label>}
      {type === 'sort' && <label>{text('Sort keys', 'ソートキー')} <small>{text('one column:asc|desc:first|last per line (latter parts optional)', '1行に column:asc|desc:first|last（後半は省略可）')}</small><textarea rows={8} value={(config['keys'] as SortKeyDraft[] | undefined)?.map((key) => [key.column, key.direction, key.nulls].filter((part) => part !== undefined).join(':')).join('\n') ?? ''} onChange={(event) => setConfig({ keys: parseSortKeys(event.target.value) })} /></label>}
      {type === 'distinct' && <label>{text('Distinct columns', '重複判定の列')} <small>{text('empty = all columns', '空 = 全列')}</small><input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label>}
      {type === 'fill-null' && <FillNullFields config={config} setConfig={setConfig} columns={columns} />}
      {type === 'replace' && <label>{text('Replacements', '置換ルール')} <small>{text('one column:from:to per line (null = null literal)', '1行に column:from:to（null は null リテラル）')}</small><textarea rows={8} value={(config['rules'] as ReplaceRuleDraft[] | undefined)?.map((rule) => `${rule.column}:${cellText(rule.from)}:${cellText(rule.to)}`).join('\n') ?? ''} onChange={(event) => setConfig({ rules: parseReplaceRules(event.target.value, columns) })} /></label>}
      {catalogItem(type).inputArity === 2
        ? <>
            {leftColumns.length > 0 && <div className="column-hints"><strong>{text('Left input columns', '左入力の列')}</strong>{leftColumns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
            {rightColumns.length > 0 && <div className="column-hints"><strong>{text('Right input columns', '右入力の列')}</strong>{rightColumns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
          </>
        : columns.length > 0 && <div className="column-hints"><strong>{text('Upstream columns', '上流の列')}</strong>{columns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
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

function JoinFields({ config, setConfig, leftColumns, rightColumns }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void; leftColumns: readonly ColumnDto[]; rightColumns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const keys = (config['keys'] as JoinKeyDraft[] | undefined) ?? [];
  const setKey = (index: number, patch: Partial<JoinKeyDraft>) =>
    setConfig({ keys: keys.map((key, i) => (i === index ? { ...key, ...patch } : key)) });
  return <>
    <label>{text('Join mode', '結合モード')}<select aria-label={text('Join mode', '結合モード')} value={String(config['mode'] ?? 'inner')} onChange={(event) => setConfig({ mode: event.target.value })}>{['inner', 'left', 'right', 'full'].map((value) => <option key={value}>{value}</option>)}</select></label>
    <datalist id="join-left-columns">{leftColumns.map((column) => <option key={column.name} value={column.name} />)}</datalist>
    <datalist id="join-right-columns">{rightColumns.map((column) => <option key={column.name} value={column.name} />)}</datalist>
    <strong className="rule-title">{text('Key pairs', 'キーペア')} <small>{text('left = input 0 / right = input 1', '左=入力0 / 右=入力1')}</small></strong>
    {keys.map((key, index) => (
      <div className="rule-row" key={index}>
        <input aria-label={text('Left key', '左キー')} list="join-left-columns" value={key.left} onChange={(event) => setKey(index, { left: event.target.value })} placeholder={text('left column', '左の列')} />
        <input aria-label={text('Right key', '右キー')} list="join-right-columns" value={key.right} onChange={(event) => setKey(index, { right: event.target.value })} placeholder={text('right column', '右の列')} />
        <button type="button" aria-label={text('Remove key', 'キーを削除')} onClick={() => setConfig({ keys: keys.filter((_, i) => i !== index) })}>×</button>
      </div>
    ))}
    <button type="button" onClick={() => setConfig({ keys: [...keys, { left: '', right: '' }] })}>{text('Add key', 'キーを追加')}</button>
    <label>{text('Right suffix', '右列サフィックス')}<input value={String(config['rightSuffix'] ?? '_right')} onChange={(event) => setConfig({ rightSuffix: event.target.value })} /></label>
  </>;
}

function FillNullFields({ config, setConfig, columns }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void; columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const rules = (config['rules'] as FillRuleDraft[] | undefined) ?? [];
  const setRule = (index: number, next: FillRuleDraft) =>
    setConfig({ rules: rules.map((rule, i) => (i === index ? next : rule)) });
  return <>
    <strong className="rule-title">{text('Null rules', 'nullルール')} <small>{text('constant fills value / drop-row removes rows', 'constant=定数で埋める / drop-row=行を削除')}</small></strong>
    {rules.map((rule, index) => {
      const columnType = columns.find((candidate) => candidate.name === rule.column)?.type;
      return (
        <div className="rule-row" key={index}>
          <input aria-label={text('Rule column', '対象列')} list="upstream-columns" value={rule.column} onChange={(event) => setRule(index, { ...rule, column: event.target.value })} placeholder={text('column', '列')} />
          <select aria-label={text('Strategy', '戦略')} value={rule.strategy} onChange={(event) => setRule(index, event.target.value === 'drop-row' ? { column: rule.column, strategy: 'drop-row' } : { ...rule, strategy: 'constant', value: rule.value ?? '' })}>
            <option value="constant">constant</option>
            <option value="drop-row">drop-row</option>
          </select>
          {rule.strategy === 'constant' && <input aria-label={text('Fill value', '埋める値')} value={cellText(rule.value)} onChange={(event) => setRule(index, { ...rule, value: coerceScalar(event.target.value, columnType) })} />}
          <button type="button" aria-label={text('Remove rule', 'ルールを削除')} onClick={() => setConfig({ rules: rules.filter((_, i) => i !== index) })}>×</button>
        </div>
      );
    })}
    <button type="button" onClick={() => setConfig({ rules: [...rules, { column: '', strategy: 'constant', value: '' }] })}>{text('Add rule', 'ルールを追加')}</button>
  </>;
}
