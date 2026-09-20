import { useEffect, useMemo, useState } from 'react';
import type { Edge } from '@xyflow/react';
import type { ToolApiClient } from '../api/tool-api';
import type { PropagationResultDto, ToolSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DiagnosticsPanel, TOOL_SECTION, type LocalTarget } from '../components/DiagnosticsPanel';
import { DraftRestoreBanner } from '../components/DraftRestoreBanner';
import { draftKey, useDraftPersistence } from '../hooks/useDraftPersistence';
import { useReportUnsavedChanges } from '../unsaved-changes';
import { useI18n } from '../i18n';
import { ScreenLink, usePendingOpen, type OpenTarget } from '../navigation';
import { FlowCanvas } from './FlowCanvas';
import { MetadataBar } from './MetadataBar';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import { PreviewPanel } from './PreviewPanel';
import { useDraftPreview } from './use-draft-preview';
import { AGENT_CONTEXT_NAME_INPUT_ID, AgentToolContextPanel } from './AgentToolContextPanel';
import { catalogItem } from './node-catalog';
import { TemplateDialog } from './TemplateDialog';
import { useToolBuilderStore, type ToolBuilderDraft, type ToolFlowNode } from './store';
import { scope } from '../scope';

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }

/**
 * 出力（終端）ノードのid。検証結果があればその terminalId、無ければ out-degree 0 の出力系ノード
 * （agent-input は引数宣言なので除く）。出力スキーマの問題を直すときに選択する。
 */
export function terminalNodeId(nodes: readonly ToolFlowNode[], edges: readonly Pick<Edge, 'source'>[], propagation: PropagationResultDto | undefined): string | undefined {
  if (propagation !== undefined && nodes.some((node) => node.id === propagation.terminalId)) return propagation.terminalId;
  const sources = new Set(edges.map((edge) => edge.source));
  const terminals = nodes.filter((node) => node.data.nodeType !== 'agent-input' && !sources.has(node.id));
  return (terminals.find((node) => catalogItem(node.data.nodeType)?.kind === 'sink') ?? terminals[0])?.id;
}

/**
 * 診断結果や実行失敗が指す「直す場所」へ移る。ノードはキャンバスで選択（設定パネルが開く）、
 * エージェント向けコンテキストは入力欄へフォーカス、出力は終端ノードを選択する。
 * DOM を触るので、対象が描画済みになってから呼ぶ（ToolBuilder は view が editor になった後の effect で呼ぶ）。
 */
export function focusToolTarget(target: LocalTarget): void {
  const store = useToolBuilderStore.getState();
  if (target.nodeId !== undefined && store.nodes.some((node) => node.id === target.nodeId)) store.selectNode(target.nodeId);
  if (target.section === TOOL_SECTION.output) {
    const terminal = terminalNodeId(store.nodes, store.edges, store.propagation);
    if (terminal !== undefined) store.selectNode(terminal);
  }
  if (target.section === TOOL_SECTION.agentContext) {
    const input = document.getElementById(AGENT_CONTEXT_NAME_INPUT_ID);
    // jsdom には scrollIntoView が無いので任意呼び出しにする。
    input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    input?.focus();
  }
}

export function ToolBuilder({ client }: { readonly client: ToolApiClient }) {
  useDraftPreview(client);
  const { text } = useI18n();
  // Layer 1: 保存済みTool一覧。'list'が既定viewで、new/openでLayer 2（editor）へ遷移する。
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string>();
  // 削除は確認してから実行する（取り消せない操作を1クリックで走らせない）。
  const [pendingDelete, setPendingDelete] = useState<ToolSummaryDto>();
  // 「開いたうえで直す場所へ」の依頼。editor が描画されてから DOM / 選択を触るため effect で消費する。
  const [focusRequest, setFocusRequest] = useState<LocalTarget>();
  // 「テンプレートから作成」（v43）。作成に成功したらキャンバス（editor）へ移る。
  const [templateOpen, setTemplateOpen] = useState(false);
  const createdFromTemplate = useToolBuilderStore((state) => state.createdFromTemplate);

  // 下書きの自動保存。グラフとメタデータだけを退避し、推論結果やプレビューは復元時に再計算させる。
  const metadata = useToolBuilderStore((state) => state.metadata);
  const nodes = useToolBuilderStore((state) => state.nodes);
  const edges = useToolBuilderStore((state) => state.edges);
  const currentVersion = useToolBuilderStore((state) => state.currentVersion);
  const draftValue = useMemo<ToolBuilderDraft>(() => ({ metadata, nodes, edges }), [metadata, nodes, edges]);
  // 保存済みTool（currentVersionあり）はinternalIdで、未保存の新規は '__new__' でキーを分ける。
  // 新規編集中のinternalIdは入力途中で変わるためキーに使わない（下書きが散らばるのを避ける）。
  const draft = useDraftPersistence<ToolBuilderDraft>({
    key: draftKey('tool-builder', scope, currentVersion === undefined ? undefined : metadata.internalId),
    value: draftValue,
    enabled: view === 'editor',
  });
  useReportUnsavedChanges('tool-builder', draft.dirty);

  useEffect(() => {
    let active = true;
    void client.listTools(scope).then((items) => { if (active) setTools(items); }).catch((cause: unknown) => { if (active) setListError(message(cause)); });
    return () => { active = false; };
  }, [client]);

  async function refreshTools(): Promise<void> {
    try { setTools(await client.listTools(scope)); }
    catch (cause) { setListError(message(cause)); }
  }

  function startNewTool(): void {
    useToolBuilderStore.getState().reset();
    setListError(undefined);
    setView('editor');
  }
  /** テンプレートから作成する前に、いまの編集内容を捨てて新しい下書きの土台にする。 */
  function openTemplates(): void {
    useToolBuilderStore.getState().reset();
    setListError(undefined);
    setTemplateOpen(true);
  }
  /** 作成できたらキャンバスへ。作成せずに閉じたときは一覧のまま。 */
  function closeTemplates(): void {
    setTemplateOpen(false);
    if (useToolBuilderStore.getState().createdFromTemplate !== undefined) setView('editor');
  }
  async function backToList(): Promise<void> { setView('list'); await refreshTools(); }
  /** 一覧・他画面からの依頼で保存済みToolを開く。開けたら true（失敗は一覧にエラーを出して false）。 */
  async function openTool(internalId: string): Promise<boolean> {
    setBusy(true); setListError(undefined);
    try {
      const [tool, versions] = await Promise.all([client.getTool(internalId, scope), client.listVersions(internalId, scope)]);
      useToolBuilderStore.getState().loadTool(tool);
      useToolBuilderStore.getState().setVersions(versions);
      setView('editor');
      return true;
    } catch (cause) { setListError(message(cause)); return false; }
    finally { setBusy(false); }
  }
  async function removeTool(internalId: string): Promise<void> {
    setBusy(true); setListError(undefined);
    try { await client.deleteTool(internalId, scope); await refreshTools(); }
    catch (cause) { setListError(message(cause)); }
    finally { setBusy(false); setPendingDelete(undefined); }
  }
  // 診断結果や他画面の「ツールを開く」からの依頼。mount 時と表示中の両方で受け、開いたら nodeId / section の場所へ移る。
  usePendingOpen('Tool', (target) => void openToolAt(target));
  async function openToolAt(target: OpenTarget): Promise<void> {
    // 開けなかった依頼の場所指定は残さない（残すと、次に開いた別のToolの編集画面で同名ノードの選択や入力欄へのフォーカスが起きる）。
    const opened = await openTool(target.internalId);
    if (opened && (target.nodeId !== undefined || target.section !== undefined)) {
      setFocusRequest({ ...(target.nodeId === undefined ? {} : { nodeId: target.nodeId }), ...(target.section === undefined ? {} : { section: target.section }) });
    }
  }
  useEffect(() => {
    if (focusRequest === undefined || view !== 'editor' || busy) return;
    focusToolTarget(focusRequest);
    setFocusRequest(undefined);
  }, [focusRequest, view, busy]);

  if (view === 'list') {
    return <main className="agent-builder tool-list-page">
      <header className="agent-builder-header">
        <div><span className="eyebrow">{text('Tool Builder', 'ツールビルダー')}</span><h1>{text('Tools', 'ツール一覧')}</h1><p>{text('Compose an ETL graph and save the reviewed definition as a new version.', 'ETLグラフを組み立て、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
        <div className="save-actions">
          <button type="button" className="secondary" onClick={openTemplates}>{text('Create from a template', 'テンプレートから作成')}</button>
          <button type="button" className="primary" onClick={startNewTool}>{text('New tool', '新規作成')}</button>
        </div>
      </header>
      {listError !== undefined && <div className="api-error">{listError}</div>}
      <section className="workspace-card agent-list">
        {tools.length === 0 ? <p className="empty-state"><span>{text('No tools yet.', 'ツールはまだありません。')}</span> <span>{text('A Tool reads a registered data source, so register one first.', 'ツールは登録済みのデータソースを読むので、先にデータソースを登録してください。')}</span> <ScreenLink to="Data">{text('Open the Data sources screen', 'データソース画面を開く')}</ScreenLink></p> : <div className="agent-list-rows">{tools.map((item) => <article className="agent-list-row" key={item.internalId}>
          <div><strong>{item.displayName}</strong><code>{item.publishName}@{item.latestVersion}</code><small>{item.sideEffect} · {item.state}</small></div>
          <div className="agent-list-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void openTool(item.internalId)}>{text('Open', '開く')}</button>
            <button type="button" className="secondary danger" disabled={busy} onClick={() => setPendingDelete(item)}>{text('Delete', '削除')}</button>
          </div>
        </article>)}</div>}
      </section>
      <ConfirmDialog open={pendingDelete !== undefined} title={text('Delete tool', 'ツールを削除')}
        message={text(`Delete "${pendingDelete?.displayName ?? ''}" (${pendingDelete?.publishName ?? ''})? It disappears from this list and Agents can no longer reference it.`, `「${pendingDelete?.displayName ?? ''}」(${pendingDelete?.publishName ?? ''})を削除しますか？一覧から消え、エージェントから参照できなくなります。`)}
        confirmLabel={text('Delete', '削除')} cancelLabel={text('Cancel', 'キャンセル')} danger busy={busy}
        onConfirm={() => { if (pendingDelete !== undefined) void removeTool(pendingDelete.internalId); }} onCancel={() => setPendingDelete(undefined)} />
      <TemplateDialog client={client} open={templateOpen} onClose={closeTemplates} />
    </main>;
  }
  return <div className="tool-builder-shell">
    <button type="button" className="secondary agent-back-button" onClick={() => void backToList()}>{text('Back to list', '一覧へ戻る')}</button>
    {createdFromTemplate !== undefined && <div className="template-created" role="status">
      {text(`Built from the template ${createdFromTemplate}. Set the owner and the names, then save.`, `テンプレート ${createdFromTemplate} から作成しました。所有者と名前を確認して保存してください。`)}
      <button type="button" className="ghost" aria-label={text('Close notice', '通知を閉じる')} onClick={() => useToolBuilderStore.getState().clearCreatedFromTemplate()}>×</button>
    </div>}
    {draft.pending !== undefined && <DraftRestoreBanner savedAt={draft.pending.savedAt}
      onRestore={() => { const value = draft.restore(); if (value !== undefined) useToolBuilderStore.getState().applyDraft(value); }}
      onDiscard={draft.discard} />}
    <div className="tool-builder">
      <MetadataBar client={client} onSaved={draft.clear} />
      <div className="builder-workspace"><NodePalette client={client} /><FlowCanvas /><NodeInspector client={client} /></div>
      <div className="result-workspace"><ToolDraftDiagnostics /><PreviewPanel /><AgentToolContextPanel /></div>
    </div>
  </div>;
}

/**
 * 「呼び出し診断」（MetadataBar のボタン）の結果。プレビュー・エージェント向けコンテキストの上に
 * 全幅で出し、閉じるまで残す（直しながら参照できるよう、編集で自動的には消さない）。
 */
export function ToolDraftDiagnostics() {
  const diagnostics = useToolBuilderStore((state) => state.diagnostics);
  const setDiagnostics = useToolBuilderStore((state) => state.setDiagnostics);
  const { text } = useI18n();
  if (diagnostics === undefined || diagnostics === 'loading') return null;
  if ('failed' in diagnostics) {
    return <div className="tool-diagnostics"><div className="api-error" role="alert">{text('Diagnostics failed: ', '診断に失敗しました: ')}{diagnostics.failed} <button type="button" className="ghost" aria-label={text('Close diagnostics', '診断を閉じる')} onClick={() => setDiagnostics(undefined)}>×</button></div></div>;
  }
  return <div className="tool-diagnostics"><DiagnosticsPanel diagnostics={{ kind: 'tool', tool: diagnostics }} context="tool-editor" onOpenLocal={focusToolTarget} onClose={() => setDiagnostics(undefined)} /></div>;
}
