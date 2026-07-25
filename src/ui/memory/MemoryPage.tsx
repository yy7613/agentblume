import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { MemoryProposalDto, MemoryProposalStateDto, WikiPageSummaryDto, WikiSpaceSummaryDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InlineFeedback } from '../components/InlineFeedback';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
type Tab = 'wiki' | 'proposals';

interface EditorState {
  readonly id?: string;
  readonly title: string;
  readonly tags: string;
  readonly body: string;
  readonly version?: number;
}

const EMPTY_EDITOR: EditorState = { title: '', tags: '', body: '' };

export function MemoryPage({ client }: { readonly client: ToolApiClient }) {
  const [tab, setTab] = useState<Tab>('wiki');
  const { text } = useI18n();
  return <main className="workspace-page">
    <header className="workspace-header"><div><span className="eyebrow">{text('Memory', '記憶')}</span><h1>{text('Long-term memory', '長期記憶')}</h1><p>{text('Curate the agent\'s LLM Wiki and review distilled memory proposals (human-approved before anything is written).', 'エージェントの LLM Wiki を整備し、蒸留された記憶提案を確認します（書き込みは人手承認後）。')}</p></div></header>
    <div className="validation-tabs" role="tablist" aria-label={text('Memory tabs', '記憶タブ')}>
      <button type="button" role="tab" aria-selected={tab === 'wiki'} className={tab === 'wiki' ? 'active' : ''} onClick={() => setTab('wiki')}>{text('Wiki', 'Wiki')}</button>
      <button type="button" role="tab" aria-selected={tab === 'proposals'} className={tab === 'proposals' ? 'active' : ''} onClick={() => setTab('proposals')}>{text('Proposals', '提案')}</button>
    </div>
    {tab === 'wiki' ? <WikiTab client={client} /> : <ProposalsTab client={client} />}
  </main>;
}

function WikiTab({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [query, setQuery] = useState('');
  const [wikis, setWikis] = useState<readonly WikiSpaceSummaryDto[]>([]);
  const [selectedWikiId, setSelectedWikiId] = useState('');
  const [wikiDraft, setWikiDraft] = useState({ id: '', name: '', description: '' });
  const [pages, setPages] = useState<readonly WikiPageSummaryDto[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  // Wiki管理(作成/削除)のエラーとページ編集のエラーは発生源の近くに出すため別stateに分ける。
  const [wikiError, setWikiError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingSpaceDelete, setPendingSpaceDelete] = useState(false);
  const [pendingPageDelete, setPendingPageDelete] = useState<{ readonly id: string; readonly title: string }>();

  const refreshWikis = useCallback(async (preferId?: string) => {
    setWikiError(null);
    try {
      const items = typeof client.listWikis === 'function' ? await client.listWikis(scope) : [{ id: 'default', name: 'Default Wiki', description: '', updatedAt: '' }]; setWikis(items);
      const nextId = (preferId ?? selectedWikiId) || items[0]?.id || '';
      setSelectedWikiId(nextId);
      const selected = items.find((item) => item.id === nextId);
      if (selected !== undefined) setWikiDraft({ id: selected.id, name: selected.name, description: selected.description });
    }
    catch (err) { setWikiError(err instanceof Error ? err.message : 'load failed'); }
  }, [client, selectedWikiId]);

  const refresh = useCallback(async (q: string, wikiId = selectedWikiId) => {
    setPageError(null);
    if (wikiId === '') { setPages([]); return; }
    try { setPages(typeof client.listWikiPages === 'function' ? await client.listWikiPages(wikiId, scope, q) : await client.listWiki(scope, q)); }
    catch (err) { setPageError(err instanceof Error ? err.message : 'load failed'); }
  }, [client, selectedWikiId]);

  useEffect(() => { void refreshWikis(); }, [client]);
  useEffect(() => { void refresh('', selectedWikiId); setEditor(EMPTY_EDITOR); }, [selectedWikiId, refresh]);

  const open = useCallback(async (id: string) => {
    setPageError(null); setSavedTitle(undefined);
    try {
      const page = typeof client.getWikiPage === 'function' ? await client.getWikiPage(selectedWikiId, id, scope) : await client.getWiki(id, scope);
      setEditor({ id: page.id, title: page.title, tags: page.tags.join(', '), body: page.body, version: page.version });
    } catch (err) { setPageError(err instanceof Error ? err.message : 'open failed'); }
  }, [client, selectedWikiId]);

  const save = useCallback(async () => {
    setBusy(true); setPageError(null);
    try {
      const tags = editor.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      const input = { scope, ...(editor.id !== undefined ? { id: editor.id } : {}), title: editor.title, tags, body: editor.body };
      const page = typeof client.saveWikiPage === 'function' ? await client.saveWikiPage(selectedWikiId, { ...input, wikiId: selectedWikiId }) : await client.saveWiki(input);
      setEditor({ id: page.id, title: page.title, tags: page.tags.join(', '), body: page.body, version: page.version });
      setSavedTitle(page.title);
      await refresh(query);
    } catch (err) { setPageError(err instanceof Error ? err.message : 'save failed'); }
    finally { setBusy(false); }
  }, [client, editor, query, refresh]);

  const saveSpace = useCallback(async () => {
    setBusy(true); setWikiError(null);
    try {
      const saved = await client.saveWikiSpace({ scope, id: wikiDraft.id.trim(), name: wikiDraft.name.trim(), ...(wikiDraft.description.trim() !== '' ? { description: wikiDraft.description.trim() } : {}) });
      await refreshWikis(saved.id);
    } catch (err) { setWikiError(err instanceof Error ? err.message : 'wiki save failed'); }
    finally { setBusy(false); }
  }, [client, refreshWikis, wikiDraft]);

  const removeSpace = useCallback(async () => {
    if (selectedWikiId === '') return;
    setBusy(true); setWikiError(null);
    try { await client.deleteWikiSpace(selectedWikiId, scope); await refreshWikis(''); }
    catch (err) { setWikiError(err instanceof Error ? err.message : 'wiki delete failed'); }
    finally { setBusy(false); }
  }, [client, selectedWikiId, refreshWikis]);

  const removePage = useCallback(async (id: string) => {
    setBusy(true); setPageError(null);
    try {
      await client.deleteWiki(id, scope);
      if (editor.id === id) setEditor(EMPTY_EDITOR);
      await refresh(query);
    } catch (err) { setPageError(err instanceof Error ? err.message : 'delete failed'); }
    finally { setBusy(false); }
  }, [client, editor.id, query, refresh]);

  const selectWiki = (id: string) => {
    setSelectedWikiId(id);
    const selected = wikis.find((item) => item.id === id);
    if (selected !== undefined) setWikiDraft({ id: selected.id, name: selected.name, description: selected.description });
  };
  const newWiki = () => { setWikiDraft({ id: '', name: '', description: '' }); };
  const canSave = selectedWikiId !== '' && editor.title.trim().length > 0 && editor.body.trim().length > 0 && !busy;
  const canSaveWiki = wikiDraft.id.trim() !== '' && wikiDraft.name.trim() !== '' && !busy;
  const selectedWikiName = wikis.find((item) => item.id === selectedWikiId)?.name ?? selectedWikiId;

  return <><section className="wiki-space-manager" aria-label={text('Wiki spaces', 'Wiki一覧')}>
    <div><label>{text('Active wiki', '選択中のWiki')}<select value={selectedWikiId} onChange={(event) => selectWiki(event.target.value)}><option value="">{text('Select a wiki', 'Wikiを選択')}</option>{wikis.map((wiki) => <option key={wiki.id} value={wiki.id}>{wiki.name}</option>)}</select></label><button type="button" className="ghost" onClick={newWiki}>{text('New wiki', '新しいWiki')}</button><button type="button" className="ghost danger" disabled={selectedWikiId === '' || busy} onClick={() => setPendingSpaceDelete(true)}>{text('Delete wiki', 'Wikiを削除')}</button></div>
    <div className="wiki-space-editor"><label>{text('Wiki ID', 'Wiki ID')}<input value={wikiDraft.id} disabled={wikis.some((wiki) => wiki.id === wikiDraft.id)} onChange={(event) => setWikiDraft((current) => ({ ...current, id: event.target.value }))} /></label><label>{text('Wiki name', 'Wiki名')}<input value={wikiDraft.name} onChange={(event) => setWikiDraft((current) => ({ ...current, name: event.target.value }))} /></label><label>{text('Description', '説明')}<input value={wikiDraft.description} onChange={(event) => setWikiDraft((current) => ({ ...current, description: event.target.value }))} /></label><button type="button" className="primary" disabled={!canSaveWiki} onClick={() => void saveSpace()}>{text('Save wiki', 'Wikiを保存')}</button></div>
    {wikiError !== null && <InlineFeedback kind="error">{wikiError}</InlineFeedback>}
  </section>
  <ConfirmDialog
    open={pendingSpaceDelete}
    title={text('Delete wiki', 'Wikiを削除')}
    message={text(`Delete "${selectedWikiName}"? All of its pages will also be removed.`, `"${selectedWikiName}" を削除しますか？配下のページもすべて削除されます。`)}
    confirmLabel={text('Delete', '削除')}
    cancelLabel={text('Cancel', 'キャンセル')}
    danger
    busy={busy}
    onConfirm={() => { void removeSpace().then(() => setPendingSpaceDelete(false)); }}
    onCancel={() => setPendingSpaceDelete(false)}
  />
  <div className="mem-layout">
    <section className="mem-list-pane">
      <form className="mem-search" onSubmit={(e) => { e.preventDefault(); void refresh(query); }}>
        <input aria-label={text('Search wiki', 'Wiki を検索')} placeholder={text('Search wiki…', 'Wiki を検索…')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit">{text('Search', '検索')}</button>
      </form>
      <ul className="mem-list">
        {selectedWikiId === '' ? <li className="mem-empty">{text('Create or select a wiki first.', '先にWikiを作成または選択してください。')}</li> : pages.length === 0 ? <li className="mem-empty">{text('No wiki pages yet.', 'Wiki ページはまだありません。')}</li>
          : pages.map((page) => <li key={page.id}>
            <button type="button" className={editor.id === page.id ? 'active' : ''} onClick={() => void open(page.id)}>
              <strong>{page.title}</strong>
              <span className="mem-badges">{page.tags.map((tag) => <span key={tag} className="mem-tag">{tag}</span>)}</span>
              <small>v{page.version}</small>
            </button>
            <button type="button" className="ghost danger" disabled={busy} onClick={() => setPendingPageDelete({ id: page.id, title: page.title })}>{text('Delete', '削除')}</button>
          </li>)}
      </ul>
    </section>
    <section className="mem-editor">
      <div className="mem-editor-head">
        <h2>{editor.id !== undefined ? `${text('Edit page', 'ページ編集')} · v${editor.version ?? 1}` : text('New page', '新規ページ')}</h2>
        <button type="button" className="ghost" onClick={() => { setEditor(EMPTY_EDITOR); setSavedTitle(undefined); }}>{text('New', '新規')}</button>
      </div>
      <label>{text('Title', 'タイトル')}<input value={editor.title} onChange={(e) => setEditor((s) => ({ ...s, title: e.target.value }))} /></label>
      <label>{text('Tags (comma-separated)', 'タグ（カンマ区切り）')}<input value={editor.tags} onChange={(e) => setEditor((s) => ({ ...s, tags: e.target.value }))} /></label>
      <label>{text('Body', '本文')}<textarea rows={12} value={editor.body} onChange={(e) => setEditor((s) => ({ ...s, body: e.target.value }))} /></label>
      {savedTitle !== undefined && <InlineFeedback kind="success" autoHideMs={4000} onDismiss={() => setSavedTitle(undefined)}>{text(`Saved "${savedTitle}".`, `"${savedTitle}" を保存しました`)}</InlineFeedback>}
      {pageError !== null ? <p className="mem-error" role="alert">{pageError}</p> : null}
      <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>{busy ? text('Saving…', '保存中…') : text('Save page', 'ページを保存')}</button>
    </section>
  </div>
  <ConfirmDialog
    open={pendingPageDelete !== undefined}
    title={text('Delete page', 'ページを削除')}
    message={text(`Delete "${pendingPageDelete?.title ?? ''}"? This cannot be undone.`, `"${pendingPageDelete?.title ?? ''}" を削除しますか？この操作は元に戻せません。`)}
    confirmLabel={text('Delete', '削除')}
    cancelLabel={text('Cancel', 'キャンセル')}
    danger
    busy={busy}
    onConfirm={() => { if (pendingPageDelete === undefined) return; void removePage(pendingPageDelete.id).then(() => setPendingPageDelete(undefined)); }}
    onCancel={() => setPendingPageDelete(undefined)}
  />
  </>;
}

const STATES: readonly (MemoryProposalStateDto | 'all')[] = ['draft', 'approved', 'rejected', 'all'];

function ProposalsTab({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [filter, setFilter] = useState<MemoryProposalStateDto | 'all'>('draft');
  const [proposals, setProposals] = useState<readonly MemoryProposalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<{ readonly id: string; readonly decision: 'approve' | 'reject' }>();

  const refresh = useCallback(async (state: MemoryProposalStateDto | 'all') => {
    setError(null);
    try { setProposals(await client.listProposals(scope, state === 'all' ? undefined : state)); }
    catch (err) { setError(err instanceof Error ? err.message : 'load failed'); }
  }, [client]);

  useEffect(() => { void refresh(filter); }, [refresh, filter]);

  const decide = useCallback(async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id); setError(null);
    try {
      if (decision === 'approve') await client.approveProposal(id, scope); else await client.rejectProposal(id, scope);
      await refresh(filter);
    } catch (err) { setError(err instanceof Error ? err.message : 'decision failed'); }
    finally { setBusyId(null); }
  }, [client, filter, refresh]);

  const stateLabel = (state: MemoryProposalStateDto | 'all'): string =>
    state === 'all' ? text('All', 'すべて') : state === 'draft' ? text('Draft', '未決') : state === 'approved' ? text('Approved', '承認済み') : text('Rejected', '却下');

  return <div className="mem-proposals">
    <div className="mem-filter" role="group" aria-label={text('Filter proposals', '提案を絞り込み')}>
      {STATES.map((state) => <button type="button" key={state} className={filter === state ? 'active' : ''} onClick={() => setFilter(state)}>{stateLabel(state)}</button>)}
    </div>
    {error !== null ? <InlineFeedback kind="error">{error}</InlineFeedback> : null}
    {proposals.length === 0 ? <p className="mem-empty">{text('No proposals.', '提案はありません。')}</p>
      : <ul className="mem-proposal-list">
        {proposals.map((proposal) => <li key={proposal.id} className={`mem-card mem-card-${proposal.state}`}>
          <div className="mem-card-head">
            <span className={`mem-kind mem-kind-${proposal.target.kind}`}>{proposal.target.kind === 'wiki' ? text('Wiki', 'Wiki') : text('Skill', 'Skill')}</span>
            <span className={`mem-state mem-state-${proposal.state}`}>{stateLabel(proposal.state)}</span>
          </div>
          <p className="mem-summary">{proposal.summary}</p>
          {proposal.target.kind === 'wiki'
            ? <div className="mem-preview"><strong>{proposal.target.isNewPage ? text('New page', '新規ページ') : text('Revision', '改訂')}: {proposal.target.title} · Wiki {proposal.target.wikiId ?? 'default'}</strong><pre>{proposal.target.body}</pre></div>
            : <div className="mem-preview"><strong>{text('Skill', 'Skill')}: {proposal.target.skillId}</strong><pre>{proposal.target.instructions}</pre></div>}
          {proposal.state === 'draft' ? <div className="mem-actions">
            <button type="button" className="primary" disabled={busyId === proposal.id} onClick={() => setPendingDecision({ id: proposal.id, decision: 'approve' })}>{text('Approve', '承認')}</button>
            <button type="button" className="ghost" disabled={busyId === proposal.id} onClick={() => setPendingDecision({ id: proposal.id, decision: 'reject' })}>{text('Reject', '却下')}</button>
          </div> : null}
        </li>)}
      </ul>}
    <ConfirmDialog
      open={pendingDecision !== undefined}
      title={pendingDecision?.decision === 'approve' ? text('Approve proposal', '提案を承認') : text('Reject proposal', '提案を却下')}
      message={pendingDecision?.decision === 'approve' ? text('Approve this memory proposal and write it to the wiki?', 'この記憶提案を承認してWikiに書き込みますか？') : text('Reject this memory proposal?', 'この記憶提案を却下しますか？')}
      confirmLabel={pendingDecision?.decision === 'approve' ? text('Approve', '承認') : text('Reject', '却下')}
      cancelLabel={text('Cancel', 'キャンセル')}
      busy={pendingDecision !== undefined && busyId === pendingDecision.id}
      onConfirm={() => { if (pendingDecision === undefined) return; void decide(pendingDecision.id, pendingDecision.decision).then(() => setPendingDecision(undefined)); }}
      onCancel={() => setPendingDecision(undefined)}
    />
  </div>;
}
