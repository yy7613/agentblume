import { useEffect, useState, type ReactNode } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ColumnDto, DataSourceDto, DataType, JsonCell, SchemaDto } from '../api/types';
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
const DIALOG_NODE_TYPES = new Set<ToolNodeType>(['agent-input', 'json-source', 'csv-source', 'database-source', 'rename', 'cast', 'join', 'sort', 'fill-null', 'replace', 'agent-output', 'workspace-output']);

export function NodeInspector({ client }: { readonly client?: ToolApiClient }) {
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
  const agentInputColumns = useToolBuilderStore((state) => {
    const node = state.nodes.find((candidate) => candidate.data.nodeType === 'agent-input');
    return ((node?.data.config['schema'] as SchemaDto | undefined)?.columns ?? EMPTY_COLUMNS) as readonly ColumnDto[];
  });
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string>();
  const [dialogDraft, setDialogDraft] = useState<Readonly<Record<string, unknown>>>();
  const [dialogNodeId, setDialogNodeId] = useState<string>();
  const [dataSources, setDataSources] = useState<readonly DataSourceDto[]>([]);
  const { text } = useI18n();

  useEffect(() => {
    if (node?.data.nodeType === 'json-source') {
      setJsonText(JSON.stringify(node.data.config['rows'] ?? [], null, 2));
      setJsonError(undefined);
    }
  }, [node?.id, node?.data.config]);
  useEffect(() => {
    if (client === undefined || typeof client.listDataSources !== 'function') return;
    void client.listDataSources({ tenantId: 'local', workspaceId: 'default' }).then(setDataSources).catch(() => setDataSources([]));
  }, [client]);

  if (node === undefined) return <aside className="inspector empty"><h2>{text('Inspector', 'インスペクター')}</h2><p>{text('Select a node.', 'ノードを選択してください。')}</p></aside>;
  const config = node.data.config;
  const setConfig = (patch: Record<string, unknown>) => update(node.id, { ...config, ...patch });
  const type = node.data.nodeType;
  const openDialog = () => { setDialogNodeId(node.id); setDialogDraft(structuredClone(config)); };
  const closeDialog = () => { setDialogNodeId(undefined); setDialogDraft(undefined); };

  return (
    <aside className="inspector" aria-label={text('Node inspector', 'ノードインスペクター')}>
      <span className="eyebrow">{catalogItem(type).kind === 'source' ? text('source', '入力') : catalogItem(type).kind === 'sink' ? text('output', '出力') : text('transform', '変換')}</span>
      <h2>{text(catalogItem(type).label, catalogItem(type).labelJa)}</h2>
      <p>{text(catalogItem(type).description, catalogItem(type).descriptionJa)}</p>
      {DIALOG_NODE_TYPES.has(type) && <button type="button" className="secondary inspector-configure" onClick={openDialog}>{text('Open settings', '設定を開く')}</button>}
      <datalist id="upstream-columns">{columns.map((column) => <option key={column.name} value={column.name} />)}</datalist>
      {type === 'agent-input' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><AgentInputFields key={node.id} config={config} setConfig={setConfig} /></details>}
      {type === 'json-source' && <details><summary>{text('Advanced JSON editor', '詳細JSON編集')}</summary>
        <label>{text('JSON rows', 'JSON行')}<textarea rows={12} value={jsonText} onChange={(event) => {
          const text = event.target.value; setJsonText(text);
          try { const rows = JSON.parse(text) as unknown; if (!Array.isArray(rows)) throw new Error('配列を入力してください'); setJsonError(undefined); setConfig({ rows }); }
          catch (error) { setJsonError(error instanceof Error ? error.message : 'Invalid JSON'); }
        }} />{jsonError !== undefined && <small className="field-error">{jsonError}</small>}</label>
      </details>}
      {type === 'csv-source' && <details><summary>{text('Advanced CSV editor', '詳細CSV編集')}</summary><CsvFields config={config} setConfig={setConfig} /></details>}
      {type === 'select' && <ColumnMultiSelect label={text('Choose columns', '列を選択')} columns={columns} value={(config['columns'] as string[] | undefined) ?? []} onChange={(next) => setConfig({ columns: next })} />}
      {type === 'select' && <details><summary>{text('Advanced text input', '詳細テキスト入力')}</summary><label>{text('Columns', '列')}<input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label></details>}
      {type === 'filter' && <FilterFields config={config} setConfig={setConfig} columns={columns} agentInputColumns={agentInputColumns} />}
      {type === 'rename' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Renames', '列名変更')} <small>{text('one from:to pair per line', '1行に from:to')}</small><textarea rows={8} value={(config['renames'] as {from:string;to:string}[] | undefined)?.map((pair) => `${pair.from}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ renames: parsePairs(event.target.value, 'to') })} /></label></details>}
      {type === 'cast' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Casts', '型変換')} <small>{text('one column:type pair per line', '1行に column:type')}</small><textarea rows={8} value={(config['casts'] as {column:string;to:string}[] | undefined)?.map((pair) => `${pair.column}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ casts: parsePairs(event.target.value, 'type') })} /></label></details>}
      {type === 'join' && <details><summary>{text('Advanced inline editor', '詳細インライン編集')}</summary><JoinFields config={config} setConfig={setConfig} leftColumns={leftColumns} rightColumns={rightColumns} /></details>}
      {type === 'union' && <label className="check"><input type="checkbox" checked={config['strict'] === true} onChange={(event) => setConfig({ strict: event.target.checked })} /> {text('Strict column match', '列名の完全一致を要求')}</label>}
      {type === 'sort' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Sort keys', 'ソートキー')} <small>{text('one column:asc|desc:first|last per line (latter parts optional)', '1行に column:asc|desc:first|last（後半は省略可）')}</small><textarea rows={8} value={(config['keys'] as SortKeyDraft[] | undefined)?.map((key) => [key.column, key.direction, key.nulls].filter((part) => part !== undefined).join(':')).join('\n') ?? ''} onChange={(event) => setConfig({ keys: parseSortKeys(event.target.value) })} /></label></details>}
      {type === 'distinct' && <ColumnMultiSelect label={text('Choose distinct columns', '重複判定の列を選択')} columns={columns} value={(config['columns'] as string[] | undefined) ?? []} onChange={(next) => setConfig({ columns: next })} hint={text('No selection uses all columns.', '未選択なら全列を使います。')} />}
      {type === 'distinct' && <details><summary>{text('Advanced text input', '詳細テキスト入力')}</summary><label>{text('Distinct columns', '重複判定の列')}<input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label></details>}
      {type === 'fill-null' && <details><summary>{text('Advanced inline editor', '詳細インライン編集')}</summary><FillNullFields config={config} setConfig={setConfig} columns={columns} /></details>}
      {type === 'replace' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Replacements', '置換ルール')} <small>{text('one column:from:to per line (null = null literal)', '1行に column:from:to（null は null リテラル）')}</small><textarea rows={8} value={(config['rules'] as ReplaceRuleDraft[] | undefined)?.map((rule) => `${rule.column}:${cellText(rule.from)}:${cellText(rule.to)}`).join('\n') ?? ''} onChange={(event) => setConfig({ rules: parseReplaceRules(event.target.value, columns) })} /></label></details>}
      {type === 'agent-output' && <><p>{text(`Direct result · ${String(config['shape'] ?? 'rows')} · ${String(config['maxRows'] ?? 100)} rows`, `直接返却 · ${String(config['shape'] ?? 'rows')} · ${String(config['maxRows'] ?? 100)}行`)}</p><details><summary>{text('Quick inline edit', '簡易インライン編集')}</summary><AgentOutputFields config={config} setConfig={setConfig} columns={columns} /></details></>}
      {type === 'workspace-output' && <><p>{text(`Session artifact · ${String(config['name'] ?? '')}`, `セッションArtifact · ${String(config['name'] ?? '')}`)}</p><details><summary>{text('Quick inline edit', '簡易インライン編集')}</summary><WorkspaceOutputFields config={config} setConfig={setConfig} columns={columns} /></details></>}
      {catalogItem(type).inputArity === 2
        ? <>
            {leftColumns.length > 0 && <div className="column-hints"><strong>{text('Left input columns', '左入力の列')}</strong>{leftColumns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
            {rightColumns.length > 0 && <div className="column-hints"><strong>{text('Right input columns', '右入力の列')}</strong>{rightColumns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
          </>
        : columns.length > 0 && <div className="column-hints"><strong>{text('Upstream columns', '上流の列')}</strong>{columns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
      {dialogNodeId === node.id && dialogDraft !== undefined && <NodeConfigDialog type={type} initial={dialogDraft} columns={columns} leftColumns={leftColumns} rightColumns={rightColumns} dataSources={dataSources} onCancel={closeDialog} onApply={(next) => { update(node.id, next); closeDialog(); }} />}
    </aside>
  );
}

function ColumnMultiSelect({ label, columns, value, onChange, hint }: { readonly label: string; readonly columns: readonly ColumnDto[]; readonly value: readonly string[]; readonly onChange: (columns: string[]) => void; readonly hint?: string }) {
  return <label>{label}{hint !== undefined && <small>{hint}</small>}<select aria-label={label} multiple size={Math.min(8, Math.max(3, columns.length))} value={value} onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}>{columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select>{columns.length === 0 && <small>{'Connect an upstream node to choose columns.'}</small>}</label>;
}

function AgentOutputFields({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const shape = String(config['shape'] ?? 'rows');
  return <>
    <label>{text('Result shape', '返却形式')}<select value={shape} onChange={(event) => setConfig({ shape: event.target.value })}>{['rows', 'first-row', 'single-value', 'summary'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>{text('Format', '形式')}<select value={String(config['format'] ?? 'json')} onChange={(event) => setConfig({ format: event.target.value })}>{['json', 'markdown-table', 'chartjs'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <ColumnMultiSelect label={text('Output columns', '返却する列')} columns={columns} value={(config['columns'] as string[] | undefined) ?? []} onChange={(next) => setConfig({ columns: next })} />
    {shape === 'single-value' && <label>{text('Value column', '値の列')}<select value={String(config['valueColumn'] ?? '')} onChange={(event) => setConfig({ valueColumn: event.target.value })}><option value="">{text('Select a column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>}
    <label>{text('Maximum rows', '最大行数')}<input type="number" min={1} max={10000} value={Number(config['maxRows'] ?? 100)} onChange={(event) => setConfig({ maxRows: Number(event.target.value) })} /></label>
    <label>{text('Maximum bytes', '最大バイト数')}<input type="number" min={1024} max={1048576} value={Number(config['maxBytes'] ?? 65536)} onChange={(event) => setConfig({ maxBytes: Number(event.target.value) })} /></label>
    <label>{text('When too large', '上限超過時')}<select value={String(config['overflow'] ?? 'error')} onChange={(event) => setConfig({ overflow: event.target.value })}><option value="error">error</option><option value="store-and-reference">store-and-reference</option></select></label>
  </>;
}

function WorkspaceOutputFields({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const artifactKind = String(config['artifactKind'] ?? 'table');
  return <>
    <p>{text('This data is temporary and limited to the active Agent session.', 'このデータは一時的で、現在のエージェントセッションだけで利用できます。')}</p>
    <label>{text('Artifact name', 'Artifact名')}<input value={String(config['name'] ?? '')} onChange={(event) => setConfig({ name: event.target.value })} /></label>
    <label>{text('Artifact type', 'Artifact種別')}<select value={artifactKind} onChange={(event) => setConfig({ artifactKind: event.target.value })}>{['table', 'json', 'chart', 'graph', 'blob'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    {artifactKind === 'graph' && <GraphMappingFields config={config} setConfig={setConfig} columns={columns} />}
    <label>{text('Write mode', '書き込み方法')}<select value={String(config['writeMode'] ?? 'create')} onChange={(event) => setConfig({ writeMode: event.target.value })}><option value="create">create</option><option value="replace">replace</option></select></label>
    <label>{text('Name conflict', '同名時')}<select value={String(config['onConflict'] ?? 'new-revision')} onChange={(event) => setConfig({ onConflict: event.target.value })}><option value="new-revision">new-revision</option><option value="fail">fail</option></select></label>
    <label>{text('Preview rows', 'プレビュー行数')}<input type="number" min={0} max={100} value={Number(config['previewRows'] ?? 10)} onChange={(event) => setConfig({ previewRows: Number(event.target.value) })} /></label>
  </>;
}

function GraphMappingFields({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const graph = (config['graph'] as { sourceColumn?: string; targetColumn?: string; edgeLabelColumn?: string } | undefined) ?? {};
  const patch = (next: Partial<typeof graph>) => setConfig({ graph: { ...graph, ...next } });
  const options = <><option value="">{text('Select a column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</>;
  return <section className="graph-mapping-fields">
    <strong>{text('Property graph mapping', 'プロパティグラフ対応')}</strong>
    <small>{text('Each input row becomes an edge; endpoint values become nodes.', '各入力行をedge、始点・終点の値をnodeとして保存します。')}</small>
    <label>{text('Source column', '始点列')}<select value={graph.sourceColumn ?? ''} onChange={(event) => patch({ sourceColumn: event.target.value })}>{options}</select></label>
    <label>{text('Target column', '終点列')}<select value={graph.targetColumn ?? ''} onChange={(event) => patch({ targetColumn: event.target.value })}>{options}</select></label>
    <label>{text('Edge label column (optional)', 'edgeラベル列（任意）')}<select value={graph.edgeLabelColumn ?? ''} onChange={(event) => patch({ edgeLabelColumn: event.target.value === '' ? undefined : event.target.value })}>{options}</select></label>
  </section>;
}

function NodeConfigDialog({ type, initial, columns, leftColumns, rightColumns, dataSources, onCancel, onApply }: { readonly type: ToolNodeType; readonly initial: Readonly<Record<string, unknown>>; readonly columns: readonly ColumnDto[]; readonly leftColumns: readonly ColumnDto[]; readonly rightColumns: readonly ColumnDto[]; readonly dataSources: readonly DataSourceDto[]; readonly onCancel: () => void; readonly onApply: (config: Readonly<Record<string, unknown>>) => void }) {
  const [draft, setDraft] = useState<Readonly<Record<string, unknown>>>(initial);
  const { text } = useI18n();
  const patch = (next: Record<string, unknown>) => setDraft((current) => ({ ...current, ...next }));
  return <div className="node-config-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="node-config-dialog" role="dialog" aria-modal="true" aria-label={text('Node configuration', 'ノード設定')}>
      <header><div><span className="eyebrow">{text('Configuration', '設定')}</span><h2>{text(catalogItem(type).label, catalogItem(type).labelJa)}</h2></div><button type="button" className="ghost" aria-label={text('Close settings', '設定を閉じる')} onClick={onCancel}>×</button></header>
      <div className="node-config-dialog-body">
        {type === 'agent-output' && <AgentOutputFields config={draft} setConfig={patch} columns={columns} />}
        {type === 'workspace-output' && <WorkspaceOutputFields config={draft} setConfig={patch} columns={columns} />}
        {type === 'rename' && <RenameRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'cast' && <CastRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'sort' && <SortRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'replace' && <ReplaceRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'agent-input' && <SchemaTableEditor config={draft} setConfig={patch} />}
        {type === 'join' && <JoinFields config={draft} setConfig={patch} leftColumns={leftColumns} rightColumns={rightColumns} />}
        {type === 'fill-null' && <FillNullFields config={draft} setConfig={patch} columns={columns} />}
        {(type === 'json-source' || type === 'csv-source' || type === 'database-source') && <SourceDialogEditor type={type} config={draft} setConfig={patch} dataSources={dataSources} />}
      </div>
      <footer><button type="button" className="secondary" onClick={onCancel}>{text('Cancel', 'キャンセル')}</button><button type="button" className="primary" onClick={() => onApply(draft)}>{text('Apply settings', '設定を適用')}</button></footer>
    </section>
  </div>;
}

function RenameRuleEditor({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n(); const rules = (config['renames'] as { from: string; to: string }[] | undefined) ?? [];
  const update = (index: number, next: Partial<{ from: string; to: string }>) => setConfig({ renames: rules.map((rule, i) => i === index ? { ...rule, ...next } : rule) });
  return <RuleEditor title={text('Rename rules', '列名変更ルール')} addLabel={text('Add rename', '列名変更を追加')} onAdd={() => setConfig({ renames: [...rules, { from: '', to: '' }] })}>{rules.map((rule, index) => <div className="rule-row" key={index}><select aria-label={text('Source column', '元の列')} value={rule.from} onChange={(event) => update(index, { from: event.target.value })}><option value="">{text('Select column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><input aria-label={text('New column name', '新しい列名')} value={rule.to} onChange={(event) => update(index, { to: event.target.value })} /><button type="button" aria-label={text('Remove rule', 'ルールを削除')} onClick={() => setConfig({ renames: rules.filter((_, i) => i !== index) })}>×</button></div>)}</RuleEditor>;
}

function CastRuleEditor({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n(); const rules = (config['casts'] as { column: string; to: DataType }[] | undefined) ?? [];
  const update = (index: number, next: Partial<{ column: string; to: DataType }>) => setConfig({ casts: rules.map((rule, i) => i === index ? { ...rule, ...next } : rule) });
  return <RuleEditor title={text('Cast rules', '型変換ルール')} addLabel={text('Add cast', '型変換を追加')} onAdd={() => setConfig({ casts: [...rules, { column: '', to: 'string' }] })}>{rules.map((rule, index) => <div className="rule-row" key={index}><select aria-label={text('Rule column', '対象列')} value={rule.column} onChange={(event) => update(index, { column: event.target.value })}><option value="">{text('Select column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><select aria-label={text('Target type', '変換先型')} value={rule.to} onChange={(event) => update(index, { to: event.target.value as DataType })}>{DATA_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select><button type="button" aria-label={text('Remove rule', 'ルールを削除')} onClick={() => setConfig({ casts: rules.filter((_, i) => i !== index) })}>×</button></div>)}</RuleEditor>;
}

function SortRuleEditor({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n(); const rules = (config['keys'] as SortKeyDraft[] | undefined) ?? [];
  const update = (index: number, next: Partial<SortKeyDraft>) => setConfig({ keys: rules.map((rule, i) => i === index ? { ...rule, ...next } : rule) });
  return <RuleEditor title={text('Sort keys', 'ソートキー')} addLabel={text('Add key', 'キーを追加')} onAdd={() => setConfig({ keys: [...rules, { column: '', direction: 'asc', nulls: 'last' }] })}>{rules.map((rule, index) => <div className="rule-row" key={index}><select aria-label={text('Rule column', '対象列')} value={rule.column} onChange={(event) => update(index, { column: event.target.value })}><option value="">{text('Select column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><select aria-label={text('Direction', '順序')} value={rule.direction ?? 'asc'} onChange={(event) => update(index, { direction: event.target.value as 'asc' | 'desc' })}><option value="asc">asc</option><option value="desc">desc</option></select><select aria-label={text('Null position', 'null位置')} value={rule.nulls ?? 'last'} onChange={(event) => update(index, { nulls: event.target.value as 'first' | 'last' })}><option value="first">first</option><option value="last">last</option></select><button type="button" aria-label={text('Remove rule', 'ルールを削除')} onClick={() => setConfig({ keys: rules.filter((_, i) => i !== index) })}>×</button></div>)}</RuleEditor>;
}

function ReplaceRuleEditor({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n(); const rules = (config['rules'] as ReplaceRuleDraft[] | undefined) ?? [];
  const update = (index: number, next: Partial<ReplaceRuleDraft>) => setConfig({ rules: rules.map((rule, i) => i === index ? { ...rule, ...next } : rule) });
  return <RuleEditor title={text('Replacement rules', '置換ルール')} addLabel={text('Add replacement', '置換を追加')} onAdd={() => setConfig({ rules: [...rules, { column: '', from: '', to: '' }] })}>{rules.map((rule, index) => { const type = columns.find((column) => column.name === rule.column)?.type; return <div className="rule-row" key={index}><select aria-label={text('Rule column', '対象列')} value={rule.column} onChange={(event) => update(index, { column: event.target.value })}><option value="">{text('Select column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select><input aria-label={text('Replace from', '置換前')} value={cellText(rule.from)} onChange={(event) => update(index, { from: coerceCell(event.target.value, type) })} /><input aria-label={text('Replace to', '置換後')} value={cellText(rule.to)} onChange={(event) => update(index, { to: coerceCell(event.target.value, type) })} /><button type="button" aria-label={text('Remove rule', 'ルールを削除')} onClick={() => setConfig({ rules: rules.filter((_, i) => i !== index) })}>×</button></div>; })}</RuleEditor>;
}

function RuleEditor({ title, addLabel, onAdd, children }: { readonly title: string; readonly addLabel: string; readonly onAdd: () => void; readonly children: ReactNode }) { return <section className="dialog-rule-editor"><h3>{title}</h3>{children}<button type="button" onClick={onAdd}>{addLabel}</button></section>; }

function SchemaTableEditor({ config, setConfig }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void }) {
  const { text } = useI18n(); const columns = ((config['schema'] as SchemaDto | undefined)?.columns ?? []) as readonly ColumnDto[];
  const sample = (config['sample'] as Readonly<Record<string, unknown>> | undefined) ?? {};
  const update = (index: number, next: Partial<ColumnDto>) => setConfig({ schema: { columns: columns.map((column, i) => i === index ? { ...column, ...next } : column) } });
  return <RuleEditor title={text('Input schema', '入力スキーマ')} addLabel={text('Add column', '列を追加')} onAdd={() => setConfig({ schema: { columns: [...columns, { name: '', type: 'string', nullable: false }] } })}>{columns.map((column, index) => <div className="rule-row" key={index}><input aria-label={text('Column name', '列名')} value={column.name} onChange={(event) => update(index, { name: event.target.value })} /><select aria-label={text('Column type', '列型')} value={column.type} onChange={(event) => update(index, { type: event.target.value as DataType })}>{DATA_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select><label className="check"><input type="checkbox" checked={column.nullable} onChange={(event) => update(index, { nullable: event.target.checked })} />{text('Optional', '任意')}</label><button type="button" aria-label={text('Remove column', '列を削除')} onClick={() => setConfig({ schema: { columns: columns.filter((_, i) => i !== index) } })}>×</button></div>)}<details><summary>{text('Advanced sample JSON', '詳細サンプルJSON')}</summary><textarea aria-label={text('Sample arguments', 'サンプル引数')} rows={7} value={JSON.stringify(sample, null, 2)} onChange={(event) => { try { const value = JSON.parse(event.target.value) as unknown; if (value !== null && typeof value === 'object' && !Array.isArray(value)) setConfig({ sample: value }); } catch {} }} /></details></RuleEditor>;
}

function SourceDialogEditor({ type, config, setConfig, dataSources }: { readonly type: 'json-source' | 'csv-source' | 'database-source'; readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly dataSources: readonly DataSourceDto[] }) {
  const { text } = useI18n();
  const sourceId = typeof config['dataSourceId'] === 'string' ? config['dataSourceId'] : '';
  const matching = dataSources.filter((source) => type === 'database-source' ? source.kind === 'database' : source.kind === 'file' && source.format === (type === 'csv-source' ? 'csv' : 'json'));
  const picker = <label>{text('Registered data source', '登録済みデータソース')}<select aria-label={text('Registered data source', '登録済みデータソース')} value={sourceId} onChange={(event) => setConfig({ dataSourceId: event.target.value === '' ? undefined : event.target.value })}><option value="">{text('Inline editor', 'インライン編集')}</option>{matching.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>;
  if (type === 'database-source') return <>{picker}<label>{text('Allowed table or view', '許可済みtable/view')}<input aria-label={text('Allowed table or view', '許可済みtable/view')} placeholder={text('e.g. reporting.sales_daily', '例: reporting.sales_daily')} value={String(config['table'] ?? '')} onChange={(event) => setConfig({ table: event.target.value })} /></label><label>{text('Maximum rows', '最大行数')}<input aria-label={text('Maximum rows', '最大行数')} type="number" min={1} max={10000} value={Number(config['limit'] ?? 1000)} onChange={(event) => setConfig({ limit: Number(event.target.value) })} /></label><p>{text('The backend rejects tables outside the configured allowlist and executes a read-only bounded query.', 'バックエンドは構成済みallowlist外のtableを拒否し、読み取り専用・上限付きで実行します。')}</p></>;
  if (sourceId !== '') return <>{picker}<p>{text('This source is resolved by the backend at preview and runtime. Its file body is never copied into the Tool definition.', 'プレビュー・実行時にバックエンドがこのソースを解決します。ファイル本文はTool定義に複製されません。')}</p></>;
  if (type === 'csv-source') return <>{picker}<CsvFields config={config} setConfig={setConfig} /></>;
  const rows = config['rows'] as readonly Readonly<Record<string, unknown>>[] | undefined ?? [];
  return <>{picker}<p>{text(`${rows.length} rows. Use Advanced JSON for bulk editing.`, `${rows.length}行です。大量編集は詳細JSONを使います。`)}</p><details><summary>{text('Advanced JSON', '詳細JSON')}</summary><textarea aria-label={text('JSON rows', 'JSON行')} rows={16} value={JSON.stringify(rows, null, 2)} onChange={(event) => { try { const value = JSON.parse(event.target.value) as unknown; if (Array.isArray(value)) setConfig({ rows: value }); } catch {} }} /></details></>;
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

function FilterFields({ config, setConfig, columns, agentInputColumns }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void; columns: readonly ColumnDto[]; agentInputColumns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const op = String(config['op'] ?? 'eq');
  const column = String(config['column'] ?? '');
  const columnType = columns.find((candidate) => candidate.name === column)?.type;
  const binding = config['valueBinding'] as { source?: string; field?: string } | undefined;
  const valueSource = binding?.source === 'agent-input' ? 'agent-input' : 'constant';
  return <>
    <label>{text('Column', '列')}<input list="upstream-columns" value={column} onChange={(event) => setConfig({ column: event.target.value })} /></label>
    <label>{text('Operator', '演算子')}<select value={op} onChange={(event) => setConfig({ op: event.target.value })}>{['eq','neq','gt','gte','lt','lte','contains','isNull','notNull'].map((value) => <option key={value}>{value}</option>)}</select></label>
    {!['isNull', 'notNull'].includes(op) && <>
      <label>{text('Condition value', '条件値の取得元')}<select value={valueSource} onChange={(event) => setConfig(event.target.value === 'agent-input' ? { valueBinding: { source: 'agent-input', field: agentInputColumns[0]?.name ?? '' } } : { valueBinding: undefined })}><option value="constant">{text('Fixed value', '固定値')}</option><option value="agent-input">{text('Agent input', 'エージェント入力')}</option></select></label>
      {valueSource === 'agent-input'
        ? <label>{text('Agent input field', 'エージェント入力フィールド')}<select aria-label={text('Agent input field', 'エージェント入力フィールド')} value={binding?.field ?? ''} onChange={(event) => setConfig({ valueBinding: { source: 'agent-input', field: event.target.value } })}><option value="">{text('Select an input field', '入力フィールドを選択')}</option>{agentInputColumns.map((input) => <option key={input.name} value={input.name}>{input.name} · {input.type}</option>)}</select>{agentInputColumns.length === 0 && <small className="field-error">{text('Add an Agent Input node and define its schema first.', '先にAgent Inputノードを追加し、スキーマを定義してください。')}</small>}<small>{text('The fixed value remains the design-time preview sample.', '固定値は設計時プレビューのサンプルとして残ります。')}</small></label>
        : <label>{text('Value', '値')}<input value={String(config['value'] ?? '')} onChange={(event) => setConfig({ value: columnType === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value })} /></label>}
    </>}
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
