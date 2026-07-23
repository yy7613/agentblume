import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { ToolSummaryDto } from '../api/types';
import { useI18n } from '../i18n';
import { FlowCanvas } from './FlowCanvas';
import { MetadataBar } from './MetadataBar';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import { PreviewPanel } from './PreviewPanel';
import { useDraftPreview } from './use-draft-preview';
import { AgentToolContextPanel } from './AgentToolContextPanel';
import { useToolBuilderStore } from './store';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }

export function ToolBuilder({ client }: { readonly client: ToolApiClient }) {
  useDraftPreview(client);
  const { text } = useI18n();
  // Layer 1: 保存済みTool一覧。'list'が既定viewで、new/openでLayer 2（editor）へ遷移する。
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState<string>();

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
  async function backToList(): Promise<void> { setView('list'); await refreshTools(); }
  async function openTool(internalId: string): Promise<void> {
    setBusy(true); setListError(undefined);
    try {
      const [tool, versions] = await Promise.all([client.getTool(internalId, scope), client.listVersions(internalId, scope)]);
      useToolBuilderStore.getState().loadTool(tool);
      useToolBuilderStore.getState().setVersions(versions);
      setView('editor');
    } catch (cause) { setListError(message(cause)); }
    finally { setBusy(false); }
  }
  async function removeTool(internalId: string): Promise<void> {
    setBusy(true); setListError(undefined);
    try { await client.deleteTool(internalId, scope); await refreshTools(); }
    catch (cause) { setListError(message(cause)); }
    finally { setBusy(false); }
  }

  if (view === 'list') {
    return <main className="agent-builder tool-list-page">
      <header className="agent-builder-header">
        <div><span className="eyebrow">{text('Tool Builder', 'ツールビルダー')}</span><h1>{text('Tools', 'ツール一覧')}</h1><p>{text('Compose an ETL graph and save the reviewed definition as a new version.', 'ETLグラフを組み立て、レビュー後の定義を新しいバージョンとして保存します。')}</p></div>
        <div className="save-actions"><button type="button" className="primary" onClick={startNewTool}>{text('New tool', '新規作成')}</button></div>
      </header>
      {listError !== undefined && <div className="api-error">{listError}</div>}
      <section className="workspace-card agent-list">
        {tools.length === 0 ? <p className="empty-state">{text('No tools yet.', 'ツールはまだありません。')}</p> : <div className="agent-list-rows">{tools.map((item) => <article className="agent-list-row" key={item.internalId}>
          <div><strong>{item.displayName}</strong><code>{item.publishName}@{item.latestVersion}</code><small>{item.sideEffect} · {item.state}</small></div>
          <div className="agent-list-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void openTool(item.internalId)}>{text('Open', '開く')}</button>
            <button type="button" className="secondary danger" disabled={busy} onClick={() => void removeTool(item.internalId)}>{text('Delete', '削除')}</button>
          </div>
        </article>)}</div>}
      </section>
    </main>;
  }
  return <div className="tool-builder-shell">
    <button type="button" className="secondary agent-back-button" onClick={() => void backToList()}>{text('Back to list', '一覧へ戻る')}</button>
    <div className="tool-builder">
      <MetadataBar client={client} />
      <div className="builder-workspace"><NodePalette client={client} /><FlowCanvas /><NodeInspector client={client} /></div>
      <div className="result-workspace"><PreviewPanel /><AgentToolContextPanel /></div>
    </div>
  </div>;
}
