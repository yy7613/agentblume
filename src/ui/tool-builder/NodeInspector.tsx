import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AnalysisConfigProposalDto, ColumnDto, DataSourceDto, DataType, SchemaDto, SearchProviderDto, TenantScopeDto, ToolGraphDto } from '../api/types';
import { catalogItem, toInputOf, type ToolNodeType } from './node-catalog';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';
import { DATA_TYPES, cellText, coerceCell, coerceScalar, columnsText, parseColumns, parsePairs, parseReplaceRules, parseSortKeys, splitList, type FillRuleDraft, type JoinKeyDraft, type ReplaceRuleDraft, type SortKeyDraft } from './node-config-utils';

const EMPTY_COLUMNS: readonly ColumnDto[] = [];
const DIALOG_NODE_TYPES = new Set<ToolNodeType>(['agent-input', 'json-source', 'csv-source', 'database-source', 'web-search-source', 'rename', 'cast', 'join', 'sort', 'fill-null', 'replace', 'summary-statistics', 'correlation-analysis', 'time-series-analysis', 'outlier-filter', 'agent-output', 'workspace-output', 'graph-output', 'chart-output']);

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
  const [searchProviders, setSearchProviders] = useState<readonly SearchProviderDto[]>([]);
  const [analysisAssistantAvailable, setAnalysisAssistantAvailable] = useState(false);
  const tenantId = useToolBuilderStore((state) => state.metadata.tenantId);
  const workspaceId = useToolBuilderStore((state) => state.metadata.workspaceId);
  const scope = { tenantId, workspaceId };
  const builderNodes = useToolBuilderStore((state) => state.nodes);
  const builderEdges = useToolBuilderStore((state) => state.edges);
  const graph = useMemo<ToolGraphDto>(() => ({
    nodes: builderNodes.map((item) => ({ id: item.id, type: item.data.nodeType, config: item.data.config })),
    edges: builderEdges.map((item) => ({ from: item.source, to: item.target, ...(toInputOf(item.targetHandle) === undefined ? {} : { toInput: toInputOf(item.targetHandle) }) })),
  }), [builderNodes, builderEdges]);
  const { text } = useI18n();

  useEffect(() => {
    if (node?.data.nodeType === 'json-source') {
      setJsonText(JSON.stringify(node.data.config['rows'] ?? [], null, 2));
      setJsonError(undefined);
    }
  }, [node?.id, node?.data.config]);
  useEffect(() => {
    if (client === undefined || typeof client.listDataSources !== 'function') return;
    void client.listDataSources({ tenantId, workspaceId }).then(setDataSources).catch(() => setDataSources([]));
    void client.listSearchProviders().then(setSearchProviders).catch(() => setSearchProviders([]));
    void client.analysisAssistantCapability().then(setAnalysisAssistantAvailable).catch(() => setAnalysisAssistantAvailable(false));
  }, [client, tenantId, workspaceId]);

  if (node === undefined) return <aside className="inspector empty"><h2>{text('Inspector', 'インスペクター')}</h2><p>{text('Select a node.', 'ノードを選択してください。')}</p></aside>;
  const config = node.data.config;
  const setConfig = (patch: Record<string, unknown>) => update(node.id, { ...config, ...patch });
  // 形が切り替わる設定（filter の 旧形式 ⇄ conditions）はmergeでは古いキーが残るため丸ごと置き換える。
  const replaceConfig = (next: Record<string, unknown>) => update(node.id, next);
  const type = node.data.nodeType;
  const openDialog = () => { setDialogNodeId(node.id); setDialogDraft(structuredClone(config)); };
  const closeDialog = () => { setDialogNodeId(undefined); setDialogDraft(undefined); };

  return (
    <aside className="inspector" aria-label={text('Node inspector', 'ノードインスペクター')}>
      <span className="eyebrow">{catalogItem(type).kind === 'source' ? text('source', '入力') : catalogItem(type).kind === 'sink' ? text('output', '出力') : catalogItem(type).kind === 'analyze' ? text('analysis', '分析') : text('transform', '変換')}</span>
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
      {type === 'current-datetime' && <CurrentDatetimeFields config={config} setConfig={setConfig} />}
      {type === 'select' && <ColumnMultiSelect label={text('Choose columns', '列を選択')} columns={columns} value={(config['columns'] as string[] | undefined) ?? []} onChange={(next) => setConfig({ columns: next })} />}
      {type === 'select' && <details><summary>{text('Advanced text input', '詳細テキスト入力')}</summary><label>{text('Columns', '列')}<input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label></details>}
      {type === 'filter' && <FilterFields config={config} replaceConfig={replaceConfig} columns={columns} agentInputColumns={agentInputColumns} />}
      {type === 'rename' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Renames', '列名変更')} <small>{text('one from:to pair per line', '1行に from:to')}</small><textarea rows={8} value={(config['renames'] as {from:string;to:string}[] | undefined)?.map((pair) => `${pair.from}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ renames: parsePairs(event.target.value, 'to') })} /></label></details>}
      {type === 'cast' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Casts', '型変換')} <small>{text('one column:type pair per line', '1行に column:type')}</small><textarea rows={8} value={(config['casts'] as {column:string;to:string}[] | undefined)?.map((pair) => `${pair.column}:${pair.to}`).join('\n') ?? ''} onChange={(event) => setConfig({ casts: parsePairs(event.target.value, 'type') })} /></label></details>}
      {type === 'join' && <details><summary>{text('Advanced inline editor', '詳細インライン編集')}</summary><JoinFields config={config} setConfig={setConfig} leftColumns={leftColumns} rightColumns={rightColumns} /></details>}
      {type === 'union' && <label className="check"><input type="checkbox" checked={config['strict'] === true} onChange={(event) => setConfig({ strict: event.target.checked })} /> {text('Strict column match', '列名の完全一致を要求')}</label>}
      {type === 'limit' && <LimitFields config={config} setConfig={setConfig} />}
      {type === 'group-by' && <GroupByFields config={config} setConfig={setConfig} columns={columns} />}
      {type === 'sort' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Sort keys', 'ソートキー')} <small>{text('one column:asc|desc:first|last per line (latter parts optional)', '1行に column:asc|desc:first|last（後半は省略可）')}</small><textarea rows={8} value={(config['keys'] as SortKeyDraft[] | undefined)?.map((key) => [key.column, key.direction, key.nulls].filter((part) => part !== undefined).join(':')).join('\n') ?? ''} onChange={(event) => setConfig({ keys: parseSortKeys(event.target.value) })} /></label></details>}
      {type === 'distinct' && <ColumnMultiSelect label={text('Choose distinct columns', '重複判定の列を選択')} columns={columns} value={(config['columns'] as string[] | undefined) ?? []} onChange={(next) => setConfig({ columns: next })} hint={text('No selection uses all columns.', '未選択なら全列を使います。')} />}
      {type === 'distinct' && <details><summary>{text('Advanced text input', '詳細テキスト入力')}</summary><label>{text('Distinct columns', '重複判定の列')}<input value={(config['columns'] as string[] | undefined)?.join(', ') ?? ''} onChange={(event) => setConfig({ columns: splitList(event.target.value) })} placeholder="id, name" /></label></details>}
      {type === 'fill-null' && <details><summary>{text('Advanced inline editor', '詳細インライン編集')}</summary><FillNullFields config={config} setConfig={setConfig} columns={columns} /></details>}
      {type === 'replace' && <details><summary>{text('Advanced text editor', '詳細テキスト編集')}</summary><label>{text('Replacements', '置換ルール')} <small>{text('one column:from:to per line (null = null literal)', '1行に column:from:to（null は null リテラル）')}</small><textarea rows={8} value={(config['rules'] as ReplaceRuleDraft[] | undefined)?.map((rule) => `${rule.column}:${cellText(rule.from)}:${cellText(rule.to)}`).join('\n') ?? ''} onChange={(event) => setConfig({ rules: parseReplaceRules(event.target.value, columns) })} /></label></details>}
      {isAnalysisType(type) && <><p>{text('Configure analysis columns and method in the dialog. Results stay deterministic and can be used by following nodes.', '分析列と方法は設定ダイアログで指定します。結果は決定的に計算され、後続ノードでも利用できます。')}</p></>}
      {type === 'agent-output' && <><p>{text(`Direct result · ${String(config['shape'] ?? 'rows')} · ${String(config['maxRows'] ?? 100)} rows`, `直接返却 · ${String(config['shape'] ?? 'rows')} · ${String(config['maxRows'] ?? 100)}行`)}</p><details><summary>{text('Quick inline edit', '簡易インライン編集')}</summary><AgentOutputFields config={config} setConfig={setConfig} columns={columns} /></details></>}
      {type === 'workspace-output' && <><p>{text(`Session artifact · ${String(config['name'] ?? '')}`, `セッションArtifact · ${String(config['name'] ?? '')}`)}</p><details><summary>{text('Quick inline edit', '簡易インライン編集')}</summary><WorkspaceOutputFields config={config} setConfig={setConfig} /></details></>}
      {type === 'graph-output' && <><p>{text(`Property graph · ${String(config['name'] ?? '')}`, `プロパティグラフ · ${String(config['name'] ?? '')}`)}</p><details><summary>{text('Quick inline edit', '簡易インライン編集')}</summary><GraphOutputFields config={config} setConfig={setConfig} columns={columns} /></details></>}
      {type === 'chart-output' && <><p>{text(`Chart artifact · ${String(config['chartType'] ?? '')}`, `チャートArtifact · ${String(config['chartType'] ?? '')}`)}</p></>}
      {catalogItem(type).inputArity === 2
        ? <>
            {leftColumns.length > 0 && <div className="column-hints"><strong>{text('Left input columns', '左入力の列')}</strong>{leftColumns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
            {rightColumns.length > 0 && <div className="column-hints"><strong>{text('Right input columns', '右入力の列')}</strong>{rightColumns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
          </>
        : columns.length > 0 && <div className="column-hints"><strong>{text('Upstream columns', '上流の列')}</strong>{columns.map((column) => <code key={column.name}>{column.name}: {column.type}</code>)}</div>}
      {dialogNodeId === node.id && dialogDraft !== undefined && <NodeConfigDialog type={type} initial={dialogDraft} nodeId={node.id} graph={graph} analysisAssistantAvailable={analysisAssistantAvailable} columns={columns} leftColumns={leftColumns} rightColumns={rightColumns} dataSources={dataSources} searchProviders={searchProviders} client={client} scope={scope} onCancel={closeDialog} onApply={(next) => { update(node.id, next); closeDialog(); }} />}
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

function WorkspaceOutputFields({ config, setConfig }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void }) {
  const { text } = useI18n();
  return <>
    <p>{text('This data is temporary and limited to the active Agent session.', 'このデータは一時的で、現在のエージェントセッションだけで利用できます。')}</p>
    <label>{text('Artifact name', 'Artifact名')}<input value={String(config['name'] ?? '')} onChange={(event) => setConfig({ name: event.target.value })} /></label>
    <label>{text('Artifact type', 'Artifact種別')}<select value={String(config['artifactKind'] ?? 'table')} onChange={(event) => setConfig({ artifactKind: event.target.value })}>{['table', 'json', 'chart', 'blob'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label>{text('Write mode', '書き込み方法')}<select value={String(config['writeMode'] ?? 'create')} onChange={(event) => setConfig({ writeMode: event.target.value })}><option value="create">create</option><option value="replace">replace</option></select></label>
    <label>{text('Name conflict', '同名時')}<select value={String(config['onConflict'] ?? 'new-revision')} onChange={(event) => setConfig({ onConflict: event.target.value })}><option value="new-revision">new-revision</option><option value="fail">fail</option></select></label>
    <label>{text('Preview rows', 'プレビュー行数')}<input type="number" min={0} max={100} value={Number(config['previewRows'] ?? 10)} onChange={(event) => setConfig({ previewRows: Number(event.target.value) })} /></label>
  </>;
}

function ChartOutputFields({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n(); const mapping = (config['mapping'] as Readonly<Record<string, string | number>> | undefined) ?? {};
  const patchMapping = (key: string, value: string) => setConfig({ mapping: { ...mapping, [key]: value } });
  const field = (key: string, label: string) => <label>{label}<select value={typeof mapping[key] === 'string' ? String(mapping[key]) : ''} onChange={(event) => patchMapping(key, event.target.value)}><option value="">{text('Select a column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label>;
  const chartType = String(config['chartType'] ?? 'time-series');
  return <>
    <p>{text('Charts are saved as a bounded session artifact. The agent receives only its descriptor and preview.', 'チャートは上限付きのセッションArtifactとして保存します。エージェントへは参照情報とプレビューだけが渡されます。')}</p>
    <label>{text('Artifact name', 'Artifact名')}<input value={String(config['name'] ?? '')} onChange={(event) => setConfig({ name: event.target.value })} /></label>
    <label>{text('Chart type', 'チャート種別')}<select value={chartType} onChange={(event) => setConfig({ chartType: event.target.value, mapping: {} })}>{['histogram','box-plot','scatter','correlation-heatmap','time-series','outlier-overlay'].map((value) => <option key={value}>{value}</option>)}</select></label>
    {chartType === 'histogram' && field('valueColumn', text('Value column', '値列'))}
    {chartType === 'box-plot' && <>{field('valueColumn', text('Value column', '値列'))}{field('categoryColumn', text('Category column', 'カテゴリ列'))}</>}
    {chartType === 'scatter' && <>{field('xColumn', text('X column', 'X列'))}{field('yColumn', text('Y column', 'Y列'))}{field('seriesColumn', text('Series column', '系列列'))}</>}
    {chartType === 'correlation-heatmap' && <>{field('xColumn', text('X column', 'X列'))}{field('yColumn', text('Y column', 'Y列'))}{field('coefficientColumn', text('Coefficient column', '係数列'))}</>}
    {chartType === 'time-series' && <>{field('timeColumn', text('Time column', '日時列'))}{field('valueColumn', text('Value column', '値列'))}{field('seriesColumn', text('Series column', '系列列'))}</>}
    {chartType === 'outlier-overlay' && <>{field('xColumn', text('X column', 'X列'))}{field('valueColumn', text('Value column', '値列'))}{field('flagColumn', text('Outlier flag column', '外れ値フラグ列'))}</>}
    <label>{text('Maximum points', '最大ポイント数')}<input type="number" min={1} max={5000} value={Number(config['maxPoints'] ?? 1000)} onChange={(event) => setConfig({ maxPoints: Number(event.target.value) })} /></label>
    <label>{text('Downsample', '間引き')}<select value={String(config['downsample'] ?? 'none')} onChange={(event) => setConfig({ downsample: event.target.value })}><option value="none">none</option><option value="lttb">lttb</option></select></label>
    <label>{text('Title (optional)', 'タイトル（任意）')}<input value={String(config['title'] ?? '')} onChange={(event) => setConfig({ title: event.target.value === '' ? undefined : event.target.value })} /></label>
    <label>{text('Preview rows', 'プレビュー行数')}<input type="number" min={0} max={100} value={Number(config['previewRows'] ?? 10)} onChange={(event) => setConfig({ previewRows: Number(event.target.value) })} /></label>
  </>;
}

function GraphOutputFields({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  return <>
    <p>{text('Each input row becomes an edge. Endpoint values become nodes in a temporary session graph.', '各入力行をedge、始点・終点の値をnodeとして一時的なセッショングラフに保存します。')}</p>
    <label>{text('Artifact name', 'Artifact名')}<input value={String(config['name'] ?? '')} onChange={(event) => setConfig({ name: event.target.value })} /></label>
    <GraphMappingFields config={config} setConfig={setConfig} columns={columns} />
    <label>{text('Write mode', '書き込み方法')}<select value={String(config['writeMode'] ?? 'create')} onChange={(event) => setConfig({ writeMode: event.target.value })}><option value="create">create</option><option value="replace">replace</option></select></label>
    <label>{text('Name conflict', '同名時')}<select value={String(config['onConflict'] ?? 'new-revision')} onChange={(event) => setConfig({ onConflict: event.target.value })}><option value="new-revision">new-revision</option><option value="fail">fail</option></select></label>
    <label>{text('Preview rows', 'プレビュー行数')}<input type="number" min={0} max={100} value={Number(config['previewRows'] ?? 10)} onChange={(event) => setConfig({ previewRows: Number(event.target.value) })} /></label>
  </>;
}

function GraphMappingFields({ config, setConfig, columns }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const graph = (config['graph'] as { mode?: string; sourceColumn?: string; targetColumn?: string; edgeLabelColumn?: string; columnX?: string; columnY?: string; coefficient?: string; pairCount?: string; minimumAbsoluteCoefficient?: number; minimumPairCount?: number } | undefined) ?? {};
  const patch = (next: Partial<typeof graph>) => setConfig({ graph: { ...graph, ...next } });
  const options = <><option value="">{text('Select a column', '列を選択')}</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</>;
  const mode = graph.mode === 'correlation-network' ? 'correlation-network' : 'edge-list';
  return <section className="graph-mapping-fields">
    <strong>{text('Property graph mapping', 'プロパティグラフ対応')}</strong>
    <label>{text('Mapping mode', '対応モード')}<select value={mode} onChange={(event) => setConfig({ graph: event.target.value === 'correlation-network' ? { mode: 'correlation-network', columnX: '', columnY: '', coefficient: '', pairCount: '', minimumAbsoluteCoefficient: 0, minimumPairCount: 2 } : { mode: 'edge-list', sourceColumn: '', targetColumn: '' } })}><option value="edge-list">{text('Edge list', 'エッジリスト')}</option><option value="correlation-network">{text('Correlation network', '相関ネットワーク')}</option></select></label>
    {mode === 'edge-list' ? <><small>{text('Each input row becomes an edge; endpoint values become nodes.', '各入力行をedge、始点・終点の値をnodeとして保存します。')}</small><label>{text('Source column', '始点列')}<select value={graph.sourceColumn ?? ''} onChange={(event) => patch({ sourceColumn: event.target.value })}>{options}</select></label><label>{text('Target column', '終点列')}<select value={graph.targetColumn ?? ''} onChange={(event) => patch({ targetColumn: event.target.value })}>{options}</select></label><label>{text('Edge label column (optional)', 'edgeラベル列（任意）')}<select value={graph.edgeLabelColumn ?? ''} onChange={(event) => patch({ edgeLabelColumn: event.target.value === '' ? undefined : event.target.value })}>{options}</select></label></> : <><small>{text('Correlation pairs become undirected edges. Diagonal and duplicate pairs are removed.', '相関ペアを無向edgeとして保存します。対角成分と重複ペアは除きます。')}</small><label>{text('First variable column', '変数X列')}<select value={graph.columnX ?? ''} onChange={(event) => patch({ columnX: event.target.value })}>{options}</select></label><label>{text('Second variable column', '変数Y列')}<select value={graph.columnY ?? ''} onChange={(event) => patch({ columnY: event.target.value })}>{options}</select></label><label>{text('Coefficient column', '係数列')}<select value={graph.coefficient ?? ''} onChange={(event) => patch({ coefficient: event.target.value })}>{options}</select></label><label>{text('Pair count column', 'ペア数列')}<select value={graph.pairCount ?? ''} onChange={(event) => patch({ pairCount: event.target.value })}>{options}</select></label><label>{text('Minimum absolute coefficient', '絶対係数の下限')}<input type="number" min={0} max={1} step={0.05} value={Number(graph.minimumAbsoluteCoefficient ?? 0)} onChange={(event) => patch({ minimumAbsoluteCoefficient: Number(event.target.value) })} /></label><label>{text('Minimum pair count', '最小ペア数')}<input type="number" min={0} value={Number(graph.minimumPairCount ?? 2)} onChange={(event) => patch({ minimumPairCount: Number(event.target.value) })} /></label></>}
  </section>;
}

function NodeConfigDialog({ type, initial, nodeId, graph, analysisAssistantAvailable, columns, leftColumns, rightColumns, dataSources, searchProviders, client, scope, onCancel, onApply }: { readonly type: ToolNodeType; readonly initial: Readonly<Record<string, unknown>>; readonly nodeId: string; readonly graph: ToolGraphDto; readonly analysisAssistantAvailable: boolean; readonly columns: readonly ColumnDto[]; readonly leftColumns: readonly ColumnDto[]; readonly rightColumns: readonly ColumnDto[]; readonly dataSources: readonly DataSourceDto[]; readonly searchProviders: readonly SearchProviderDto[]; readonly client?: ToolApiClient; readonly scope: TenantScopeDto; readonly onCancel: () => void; readonly onApply: (config: Readonly<Record<string, unknown>>) => void }) {
  const [draft, setDraft] = useState<Readonly<Record<string, unknown>>>(initial);
  const [intent, setIntent] = useState(''); const [proposal, setProposal] = useState<AnalysisConfigProposalDto>(); const [assistantError, setAssistantError] = useState<string>(); const [suggesting, setSuggesting] = useState(false);
  const { text } = useI18n();
  const patch = (next: Record<string, unknown>) => setDraft((current) => ({ ...current, ...next }));
  const suggest = async () => { if (client === undefined || intent.trim() === '') return; setSuggesting(true); setAssistantError(undefined); try { const result = await client.suggestAnalysisConfig({ graph: { ...graph, nodes: graph.nodes.map((item) => item.id === nodeId ? { ...item, config: draft } : item) }, nodeId, intent, scope }); setProposal(result); } catch (error) { setAssistantError(error instanceof Error ? error.message : text('Suggestion failed.', '設定案の取得に失敗しました。')); } finally { setSuggesting(false); } };
  return <div className="node-config-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="node-config-dialog" role="dialog" aria-modal="true" aria-label={text('Node configuration', 'ノード設定')}>
      <header><div><span className="eyebrow">{text('Configuration', '設定')}</span><h2>{text(catalogItem(type).label, catalogItem(type).labelJa)}</h2></div><button type="button" className="ghost" aria-label={text('Close settings', '設定を閉じる')} onClick={onCancel}>×</button></header>
      <div className="node-config-dialog-body">
        {type === 'agent-output' && <AgentOutputFields config={draft} setConfig={patch} columns={columns} />}
        {type === 'workspace-output' && <WorkspaceOutputFields config={draft} setConfig={patch} />}
        {type === 'graph-output' && <GraphOutputFields config={draft} setConfig={patch} columns={columns} />}
        {type === 'chart-output' && <ChartOutputFields config={draft} setConfig={patch} columns={columns} />}
        {type === 'rename' && <RenameRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'cast' && <CastRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'sort' && <SortRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'replace' && <ReplaceRuleEditor config={draft} setConfig={patch} columns={columns} />}
        {type === 'agent-input' && <SchemaTableEditor config={draft} setConfig={patch} />}
        {type === 'join' && <JoinFields config={draft} setConfig={patch} leftColumns={leftColumns} rightColumns={rightColumns} />}
        {type === 'fill-null' && <FillNullFields config={draft} setConfig={patch} columns={columns} />}
        {isAnalysisType(type) && <AnalysisFields type={type} config={draft} setConfig={patch} columns={columns} />}
        {isAnalysisType(type) && analysisAssistantAvailable && <section className="analysis-assistant"><h3>{text('Local LLM assistance', 'ローカルLLM設定補助')}</h3><label>{text('Analysis goal', '分析したいこと')}<textarea value={intent} onChange={(event) => setIntent(event.target.value)} placeholder={text('e.g. Find month-to-month trends by category.', '例: カテゴリ別の月次推移を確認したい')} rows={3} /></label><button type="button" className="secondary" disabled={suggesting || intent.trim() === ''} onClick={() => void suggest()}>{suggesting ? text('Suggesting…', '提案中…') : text('Suggest configuration', '設定案を作成')}</button>{assistantError !== undefined && <small className="field-error">{assistantError}</small>}{proposal !== undefined && <div className="assistant-proposal"><p>{text('The proposal has been validated against the current schema and preview.', '設定案は現在のスキーマとプレビューで検証済みです。')}</p>{proposal.rationale.map((item, index) => <small key={`r-${index}`}>• {item}</small>)}{proposal.warnings.map((item, index) => <small className="field-error" key={`w-${index}`}>• {item}</small>)}<button type="button" onClick={() => { setDraft(proposal.config); setProposal(undefined); }}>{text('Apply proposal to this dialog', 'このダイアログへ提案を適用')}</button></div>}</section>}
        {(type === 'json-source' || type === 'csv-source' || type === 'database-source' || type === 'web-search-source') && <SourceDialogEditor type={type} config={draft} setConfig={patch} dataSources={dataSources} searchProviders={searchProviders} client={client} scope={scope} />}
      </div>
      <footer><button type="button" className="secondary" onClick={onCancel}>{text('Cancel', 'キャンセル')}</button><button type="button" className="primary" onClick={() => onApply(draft)}>{text('Apply settings', '設定を適用')}</button></footer>
    </section>
  </div>;
}

function isAnalysisType(type: ToolNodeType): type is 'summary-statistics' | 'correlation-analysis' | 'time-series-analysis' | 'outlier-filter' { return ['summary-statistics', 'correlation-analysis', 'time-series-analysis', 'outlier-filter'].includes(type); }

function AnalysisFields({ type, config, setConfig, columns }: { readonly type: 'summary-statistics' | 'correlation-analysis' | 'time-series-analysis' | 'outlier-filter'; readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const numeric = columns.filter((column) => column.type === 'number');
  const selected = (key: string) => Array.isArray(config[key]) ? (config[key] as string[]) : [];
  const setSelected = (key: string, values: string[]) => setConfig({ [key]: values });
  if (type === 'summary-statistics') return <>
    <ColumnMultiSelect label={text('Numeric columns', '数値列')} columns={numeric} value={selected('columns')} onChange={(next) => setSelected('columns', next)} />
    <ColumnMultiSelect label={text('Group columns', 'グループ列')} columns={columns} value={selected('groupBy')} onChange={(next) => setSelected('groupBy', next)} hint={text('Optional', '任意')} />
    <ColumnMultiSelect label={text('Metrics', '統計量')} columns={['valid-count','missing-count','unique-count','sum','mean','stddev','min','q1','median','q3','max'].map((name) => ({ name, type: 'number' as DataType, nullable: false }))} value={selected('metrics')} onChange={(next) => setSelected('metrics', next)} />
    <label>{text('Standard deviation', '標準偏差')}<select value={String(config['variance'] ?? 'sample')} onChange={(event) => setConfig({ variance: event.target.value })}><option value="sample">sample</option><option value="population">population</option></select></label>
  </>;
  if (type === 'correlation-analysis') return <>
    <ColumnMultiSelect label={text('Numeric columns', '数値列')} columns={numeric} value={selected('columns')} onChange={(next) => setSelected('columns', next)} hint={text('Select two or more columns.', '2列以上を選択します。')} />
    <label>{text('Method', '方法')}<select value={String(config['method'] ?? 'pearson')} onChange={(event) => setConfig({ method: event.target.value })}><option value="pearson">Pearson</option><option value="spearman">Spearman</option></select></label>
    <label>{text('Missing values', '欠損値')}<select value={String(config['missing'] ?? 'pairwise')} onChange={(event) => setConfig({ missing: event.target.value })}><option value="pairwise">pairwise</option><option value="listwise">listwise</option></select></label>
    <label>{text('Minimum pairs', '最小ペア数')}<input type="number" min={2} value={Number(config['minPairs'] ?? 2)} onChange={(event) => setConfig({ minPairs: Number(event.target.value) })} /></label>
    <label className="check"><input type="checkbox" checked={config['includeDiagonal'] === true} onChange={(event) => setConfig({ includeDiagonal: event.target.checked })} />{text('Include diagonal', '対角成分を含める')}</label>
  </>;
  if (type === 'time-series-analysis') return <>
    <label>{text('Time column', '日時列')}<select value={String(config['timeColumn'] ?? '')} onChange={(event) => setConfig({ timeColumn: event.target.value })}><option value="">{text('Select a date column', '日時列を選択')}</option>{columns.filter((column) => column.type === 'date').map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
    <ColumnMultiSelect label={text('Value columns', '値列')} columns={numeric} value={selected('valueColumns')} onChange={(next) => setSelected('valueColumns', next)} />
    <ColumnMultiSelect label={text('Group columns', 'グループ列')} columns={columns} value={selected('groupBy')} onChange={(next) => setSelected('groupBy', next)} hint={text('Optional', '任意')} />
    <label>{text('Timezone', 'タイムゾーン')}<input value={String(config['timezone'] ?? 'UTC')} onChange={(event) => setConfig({ timezone: event.target.value })} placeholder="UTC" /></label>
    <label>{text('Interval', '間隔')}<select value={String(config['interval'] ?? 'day')} onChange={(event) => setConfig({ interval: event.target.value })}>{['minute','hour','day','week','month'].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>{text('Aggregation', '集計')}<select value={String(config['aggregate'] ?? 'mean')} onChange={(event) => setConfig({ aggregate: event.target.value })}>{['count','sum','mean','min','max'].map((value) => <option key={value}>{value}</option>)}</select></label>
  </>;
  return <>
    <ColumnMultiSelect label={text('Numeric columns', '数値列')} columns={numeric} value={selected('columns')} onChange={(next) => setSelected('columns', next)} />
    <ColumnMultiSelect label={text('Group columns', 'グループ列')} columns={columns} value={selected('groupBy')} onChange={(next) => setSelected('groupBy', next)} hint={text('Optional', '任意')} />
    <label>{text('Method', '方法')}<select value={String(config['method'] ?? 'iqr')} onChange={(event) => setConfig({ method: event.target.value })}>{['iqr','z-score','mad'].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>{text('Threshold', '閾値')}<input type="number" min={0.01} step={0.1} value={Number(config['threshold'] ?? 1.5)} onChange={(event) => setConfig({ threshold: Number(event.target.value) })} /></label>
    <label>{text('Action', '操作')}<select value={String(config['action'] ?? 'flag')} onChange={(event) => setConfig({ action: event.target.value })}><option value="flag">{text('Flag rows', '行にフラグを付ける')}</option><option value="exclude">{text('Exclude rows', '行を除外する')}</option></select></label>
    <label>{text('Null values', 'null値')}<select value={String(config['nulls'] ?? 'keep')} onChange={(event) => setConfig({ nulls: event.target.value })}><option value="keep">{text('Keep', '保持')}</option><option value="exclude">{text('Exclude', '除外')}</option></select></label>
  </>;
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

function SourceDialogEditor({ type, config, setConfig, dataSources, searchProviders, client, scope }: { readonly type: 'json-source' | 'csv-source' | 'database-source' | 'web-search-source'; readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly dataSources: readonly DataSourceDto[]; readonly searchProviders: readonly SearchProviderDto[]; readonly client?: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  if (type === 'web-search-source') return <WebSearchFields config={config} setConfig={setConfig} providers={searchProviders} client={client} scope={scope} />;
  const sourceId = typeof config['dataSourceId'] === 'string' ? config['dataSourceId'] : '';
  const matching = dataSources.filter((source) => type === 'database-source' ? source.kind === 'database' : source.kind === 'file' && source.format === (type === 'csv-source' ? 'csv' : 'json'));
  const picker = <label>{text('Registered data source', '登録済みデータソース')}<select aria-label={text('Registered data source', '登録済みデータソース')} value={sourceId} onChange={(event) => setConfig({ dataSourceId: event.target.value === '' ? undefined : event.target.value })}><option value="">{text('Inline editor', 'インライン編集')}</option>{matching.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>;
  if (type === 'database-source') return <>{picker}<label>{text('Allowed table or view', '許可済みtable/view')}<input aria-label={text('Allowed table or view', '許可済みtable/view')} placeholder={text('e.g. reporting.sales_daily', '例: reporting.sales_daily')} value={String(config['table'] ?? '')} onChange={(event) => setConfig({ table: event.target.value })} /></label><label>{text('Maximum rows', '最大行数')}<input aria-label={text('Maximum rows', '最大行数')} type="number" min={1} max={10000} value={Number(config['limit'] ?? 1000)} onChange={(event) => setConfig({ limit: Number(event.target.value) })} /></label><p>{text('The backend rejects tables outside the configured allowlist and executes a read-only bounded query.', 'バックエンドは構成済みallowlist外のtableを拒否し、読み取り専用・上限付きで実行します。')}</p></>;
  if (sourceId !== '') return <>{picker}<p>{text('This source is resolved by the backend at preview and runtime. Its file body is never copied into the Tool definition.', 'プレビュー・実行時にバックエンドがこのソースを解決します。ファイル本文はTool定義に複製されません。')}</p></>;
  if (type === 'csv-source') return <>{picker}<CsvFields config={config} setConfig={setConfig} /></>;
  const rows = config['rows'] as readonly Readonly<Record<string, unknown>>[] | undefined ?? [];
  return <>{picker}<p>{text(`${rows.length} rows. Use Advanced JSON for bulk editing.`, `${rows.length}行です。大量編集は詳細JSONを使います。`)}</p><details><summary>{text('Advanced JSON', '詳細JSON')}</summary><textarea aria-label={text('JSON rows', 'JSON行')} rows={16} value={JSON.stringify(rows, null, 2)} onChange={(event) => { try { const value = JSON.parse(event.target.value) as unknown; if (Array.isArray(value)) setConfig({ rows: value }); } catch {} }} /></details></>;
}

function WebSearchFields({ config, setConfig, providers, client, scope }: { readonly config: Readonly<Record<string, unknown>>; readonly setConfig: (patch: Record<string, unknown>) => void; readonly providers: readonly SearchProviderDto[]; readonly client?: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string>();
  const provider = String(config['provider'] ?? '');
  const query = String(config['query'] ?? '');
  const maxResults = Number(config['maxResults'] ?? 5);
  const domains = Array.isArray(config['includeDomains']) ? (config['includeDomains'] as unknown[]).filter((value): value is string => typeof value === 'string').join(', ') : '';
  const selected = providers.find((candidate) => candidate.id === provider);
  const fetchResults = async () => {
    if (client === undefined || selected === undefined || query.trim() === '') return;
    setFetching(true); setError(undefined);
    try {
      const search = await client.fetchWebSearch({ scope, provider: selected.id, query, maxResults, ...(domains.trim() === '' ? {} : { includeDomains: splitList(domains) }) });
      setConfig({ cacheKey: search.cacheKey, retrievedAt: search.retrievedAt, expiresAt: search.expiresAt, provider: search.provider, query: search.query, maxResults: search.maxResults, includeDomains: search.includeDomains });
    } catch (cause) { setError(cause instanceof Error ? cause.message : text('Search failed.', '検索に失敗しました。')); }
    finally { setFetching(false); }
  };
  return <>
    <label>{text('Search provider', '検索provider')}<select aria-label={text('Search provider', '検索provider')} value={provider} onChange={(event) => setConfig({ provider: event.target.value, cacheKey: undefined, retrievedAt: undefined, expiresAt: undefined })}><option value="">{text('Select a configured provider', '設定済みproviderを選択')}</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <label>{text('Search query', '検索語')}<input aria-label={text('Search query', '検索語')} placeholder={text('e.g. recent AI safety news', '例: 生成AIの最新セキュリティ動向')} value={query} onChange={(event) => setConfig({ query: event.target.value, cacheKey: undefined, retrievedAt: undefined, expiresAt: undefined })} /></label>
    <label>{text('Maximum results', '最大取得件数')}<input aria-label={text('Maximum results', '最大取得件数')} type="number" min={1} max={10} value={maxResults} onChange={(event) => setConfig({ maxResults: Number(event.target.value), cacheKey: undefined, retrievedAt: undefined, expiresAt: undefined })} /></label>
    {selected?.supportsDomainFilter === true && <label>{text('Limit to domains', '対象domainに限定')}<input aria-label={text('Limit to domains', '対象domainに限定')} placeholder={text('example.com, docs.example.org', 'example.com, docs.example.org')} value={domains} onChange={(event) => setConfig({ includeDomains: splitList(event.target.value), cacheKey: undefined, retrievedAt: undefined, expiresAt: undefined })} /></label>}
    <p>{text('Search is never called by automatic preview. Fetch results explicitly to refresh the server-side cache.', '自動プレビューは検索しません。サーバー側キャッシュを更新するには明示的に結果を取得します。')}</p>
    <button type="button" onClick={() => void fetchResults()} disabled={fetching || selected === undefined || query.trim() === ''}>{fetching ? text('Fetching…', '取得中…') : text('Fetch results', '検索結果を取得')}</button>
    {typeof config['retrievedAt'] === 'string' && <small>{text(`Cached at ${config['retrievedAt']}`, `キャッシュ取得: ${config['retrievedAt']}`)}</small>}
    {error !== undefined && <small className="field-error">{error}</small>}
  </>;
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

function CurrentDatetimeFields({ config, setConfig }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void }) {
  const { text } = useI18n();
  const label = text('Timezone (optional)', 'タイムゾーン（任意）');
  return <>
    <label>{label}<input aria-label={label} placeholder="Asia/Tokyo" value={String(config['timezone'] ?? '')} onChange={(event) => setConfig({ timezone: event.target.value.trim() === '' ? undefined : event.target.value.trim() })} /></label>
    <small>{text('Leave it empty to use the server timezone. Enter an IANA name such as Asia/Tokyo or UTC.', '空欄ならサーバーのタイムゾーンを使います。Asia/Tokyo や UTC などのIANA名を入力します。')}</small>
    <p>{text('Returns one row: now, date, yearMonth, time, weekday.', 'now・date・yearMonth・time・weekday を持つ1行を返します。')}</p>
  </>;
}

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isNull', 'notNull'] as const;
/** 値を要さない演算子。 */
const FILTER_VALUELESS_OPS: readonly string[] = ['isNull', 'notNull'];
/** 記号で表せる演算子の表示ラベル（option の value = op コードは変えない）。 */
const FILTER_OP_SYMBOLS: Readonly<Record<string, string>> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

/** 条件1行。旧形式（単一条件のフラットconfig）も同じ形へ正規化して扱う。 */
interface FilterConditionDraft {
  readonly column: string;
  readonly op: string;
  readonly value?: unknown;
  readonly valueBinding?: { readonly source?: string; readonly field?: string };
}

/** 条件1つ分のキーだけを持つプレーンなconfigへ（undefinedのキーは残さない）。 */
function filterConditionConfig(condition: FilterConditionDraft): Record<string, unknown> {
  return {
    column: condition.column,
    op: condition.op,
    ...(condition.value === undefined ? {} : { value: condition.value }),
    ...(condition.valueBinding === undefined ? {} : { valueBinding: condition.valueBinding }),
  };
}

/** 保存済みconfig（旧形式 / conditions形式）を条件配列へ正規化する。 */
function filterConditionDrafts(config: Readonly<Record<string, unknown>>): FilterConditionDraft[] {
  const conditions = config['conditions'];
  const sources = Array.isArray(conditions) && conditions.length > 0 ? (conditions as unknown[]) : [config];
  return sources.map((source) => {
    const raw = (source !== null && typeof source === 'object' ? source : {}) as Readonly<Record<string, unknown>>;
    const binding = raw['valueBinding'] as { source?: string; field?: string } | undefined;
    return {
      column: typeof raw['column'] === 'string' ? raw['column'] : '',
      op: typeof raw['op'] === 'string' ? raw['op'] : 'eq',
      ...(raw['value'] === undefined ? {} : { value: raw['value'] }),
      ...(binding === undefined ? {} : { valueBinding: binding }),
    };
  });
}

/**
 * filter の設定UI。1条件のときは旧形式のフラットconfigを書き戻し（保存済みTool・
 * agent-input バインディングの互換を保つ）、2条件以上で `{ conditions, combine }` へ切り替える。
 */
function FilterFields({ config, replaceConfig, columns, agentInputColumns }: { config: Readonly<Record<string, unknown>>; replaceConfig(next: Record<string, unknown>): void; columns: readonly ColumnDto[]; agentInputColumns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  /** 記号があるものは記号、無いものは両言語テキストで表示する。 */
  const opLabel = (op: string): string => FILTER_OP_SYMBOLS[op]
    ?? (op === 'contains' ? text('contains', '含む')
      : op === 'isNull' ? text('is empty', 'が空')
        : op === 'notNull' ? text('is not empty', 'が空でない') : op);
  const conditions = filterConditionDrafts(config);
  const combine = config['combine'] === 'or' ? 'or' : 'and';
  const multiple = conditions.length > 1;
  const write = (next: readonly FilterConditionDraft[], nextCombine: string = combine) => {
    const first = next[0] ?? { column: '', op: 'eq' };
    replaceConfig(next.length <= 1
      ? filterConditionConfig(first)
      : { conditions: next.map(filterConditionConfig), combine: nextCombine });
  };
  const patch = (index: number, next: Partial<FilterConditionDraft>) =>
    write(conditions.map((condition, position) => position === index ? { ...condition, ...next } : condition));
  return <>
    {multiple && <label>{text('Combine conditions', '条件の結合')}<select aria-label={text('Combine conditions', '条件の結合')} value={combine} onChange={(event) => write(conditions, event.target.value)}><option value="and">{text('Match all (AND)', 'すべて満たす (AND)')}</option><option value="or">{text('Match any (OR)', 'いずれかを満たす (OR)')}</option></select></label>}
    {conditions.map((condition, index) => {
      const columnType = columns.find((candidate) => candidate.name === condition.column)?.type;
      const coerce = (raw: string): unknown => columnType === 'number' && raw !== '' ? Number(raw) : raw;
      const binding = condition.valueBinding;
      const valueSource = binding?.source === 'agent-input' ? 'agent-input' : 'constant';
      const valueField = <label>{text('Value', '値')}<input value={String(condition.value ?? '')} onChange={(event) => patch(index, { value: coerce(event.target.value) })} /></label>;
      return <Fragment key={index}>
        {multiple && <strong className="rule-title">{text(`Condition ${index + 1}`, `条件${index + 1}`)}</strong>}
        <label>{text('Column', '列')}<input list="upstream-columns" value={condition.column} onChange={(event) => patch(index, { column: event.target.value })} /></label>
        <label>{text('Operator', '演算子')}<select aria-label={text('Operator', '演算子')} value={condition.op} onChange={(event) => patch(index, { op: event.target.value })}>{FILTER_OPS.map((value) => <option key={value} value={value}>{opLabel(value)}</option>)}</select></label>
        {!FILTER_VALUELESS_OPS.includes(condition.op) && <>
          <label>{text('Condition value', '条件値の取得元')}<select value={valueSource} onChange={(event) => patch(index, event.target.value === 'agent-input' ? { valueBinding: { source: 'agent-input', field: agentInputColumns[0]?.name ?? '' } } : { valueBinding: undefined })}><option value="constant">{text('Fixed value', '固定値')}</option><option value="agent-input">{text('Agent input', 'エージェント入力')}</option></select></label>
          {valueSource === 'agent-input'
            ? <label>{text('Agent input field', 'エージェント入力フィールド')}<select aria-label={text('Agent input field', 'エージェント入力フィールド')} value={binding?.field ?? ''} onChange={(event) => patch(index, { valueBinding: { source: 'agent-input', field: event.target.value } })}><option value="">{text('Select an input field', '入力フィールドを選択')}</option>{agentInputColumns.map((input) => <option key={input.name} value={input.name}>{input.name} · {input.type}</option>)}</select>{agentInputColumns.length === 0 && <small className="field-error">{text('Add an Agent Input node and define its schema first.', '先にAgent Inputノードを追加し、スキーマを定義してください。')}</small>}<small>{text('The fixed value remains the design-time preview sample.', '固定値は設計時プレビューのサンプルとして残ります。')}</small></label>
            : valueField}
        </>}
        {multiple && <div className="rule-row"><button type="button" aria-label={text('Remove condition', '条件を削除')} onClick={() => write(conditions.filter((_, position) => position !== index))}>×</button></div>}
      </Fragment>;
    })}
    <button type="button" onClick={() => write([...conditions, { column: '', op: 'eq', value: '' }])}>{text('Add condition', '条件を追加')}</button>
  </>;
}

function LimitFields({ config, setConfig }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void }) {
  const { text } = useI18n();
  return <>
    <label>{text('Row count', '残す行数')}<input aria-label={text('Row count', '残す行数')} type="number" min={1} max={10000} value={Number(config['count'] ?? 100)} onChange={(event) => setConfig({ count: Number(event.target.value) })} /></label>
    <label>{text('Skip rows', 'スキップする行数')}<input aria-label={text('Skip rows', 'スキップする行数')} type="number" min={0} value={Number(config['offset'] ?? 0)} onChange={(event) => setConfig({ offset: Number(event.target.value) })} /></label>
    <p>{text('Put Sort upstream to keep the top N rows.', '上流に並べ替えを置くと上位N件になります。')}</p>
  </>;
}

const GROUP_BY_OPS = ['count', 'count-distinct', 'sum', 'mean', 'min', 'max', 'first'] as const;
/** 対象列を要さない op。 */
const GROUP_BY_COLUMNLESS_OPS: readonly string[] = ['count'];
/** 数値列だけを候補にする op。 */
const GROUP_BY_NUMERIC_OPS: readonly string[] = ['sum', 'mean'];

interface GroupByAggregateDraft { readonly op: string; readonly column?: string; readonly as: string }

/** 既存の出力列名と衝突しない既定名。 */
function nextAggregateName(aggregates: readonly GroupByAggregateDraft[]): string {
  const taken = new Set(aggregates.map((aggregate) => aggregate.as));
  if (!taken.has('count')) return 'count';
  let index = 2;
  while (taken.has(`count${index}`)) index += 1;
  return `count${index}`;
}

function GroupByFields({ config, setConfig, columns }: { config: Readonly<Record<string, unknown>>; setConfig(patch: Record<string, unknown>): void; columns: readonly ColumnDto[] }) {
  const { text } = useI18n();
  const groupBy = Array.isArray(config['groupBy']) ? (config['groupBy'] as string[]) : [];
  const aggregates = Array.isArray(config['aggregates']) ? (config['aggregates'] as GroupByAggregateDraft[]) : [];
  const setAggregate = (index: number, next: GroupByAggregateDraft) =>
    setConfig({ aggregates: aggregates.map((aggregate, position) => position === index ? next : aggregate) });
  return <>
    <ColumnMultiSelect label={text('Group columns', 'グループ列')} columns={columns} value={groupBy} onChange={(next) => setConfig({ groupBy: next })} hint={text('One output row per group.', 'グループごとに1行を出力します。')} />
    <strong className="rule-title">{text('Aggregates', '集計')} <small>{text('count needs no column', 'countは対象列の指定なし')}</small></strong>
    {aggregates.map((aggregate, index) => {
      const candidates = GROUP_BY_NUMERIC_OPS.includes(aggregate.op) ? columns.filter((column) => column.type === 'number') : columns;
      return <div className="rule-row" key={index}>
        <select aria-label={text('Aggregate operation', '集計方法')} value={aggregate.op} onChange={(event) => setAggregate(index, GROUP_BY_COLUMNLESS_OPS.includes(event.target.value) ? { op: event.target.value, as: aggregate.as } : { ...aggregate, op: event.target.value })}>{GROUP_BY_OPS.map((value) => <option key={value}>{value}</option>)}</select>
        {!GROUP_BY_COLUMNLESS_OPS.includes(aggregate.op) && <select aria-label={text('Aggregate column', '集計する列')} value={aggregate.column ?? ''} onChange={(event) => setAggregate(index, { ...aggregate, column: event.target.value })}><option value="">{text('Select column', '列を選択')}</option>{candidates.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select>}
        <input aria-label={text('Output column name', '出力列名')} value={aggregate.as} onChange={(event) => setAggregate(index, { ...aggregate, as: event.target.value })} />
        <button type="button" aria-label={text('Remove aggregate', '集計を削除')} onClick={() => setConfig({ aggregates: aggregates.filter((_, position) => position !== index) })}>×</button>
      </div>;
    })}
    <button type="button" onClick={() => setConfig({ aggregates: [...aggregates, { op: 'count', as: nextAggregateName(aggregates) }] })}>{text('Add aggregate', '集計を追加')}</button>
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
    <label className="check"><input type="checkbox" checked={config['coerceKeys'] === 'string'} onChange={(event) => setConfig({ coerceKeys: event.target.checked ? 'string' : 'none' })} /> {text('Compare keys as text (join 001 with 1)', 'キーを文字列として比較 (001と1を結合)')}</label>
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
