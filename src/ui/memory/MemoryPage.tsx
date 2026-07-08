import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { MemoryProposalDto, MemoryProposalStateDto, WikiPageSummaryDto } from '../api/types';
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
  const [pages, setPages] = useState<readonly WikiPageSummaryDto[]>([]);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (q: string) => {
    setError(null);
    try { setPages(await client.listWiki(scope, q)); }
    catch (err) { setError(err instanceof Error ? err.message : 'load failed'); }
  }, [client]);

  useEffect(() => { void refresh(''); }, [refresh]);

  const open = useCallback(async (id: string) => {
    setError(null);
    try {
      const page = await client.getWiki(id, scope);
      setEditor({ id: page.id, title: page.title, tags: page.tags.join(', '), body: page.body, version: page.version });
    } catch (err) { setError(err instanceof Error ? err.message : 'open failed'); }
  }, [client]);

  const save = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const tags = editor.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      const page = await client.saveWiki({ scope, ...(editor.id !== undefined ? { id: editor.id } : {}), title: editor.title, tags, body: editor.body });
      setEditor({ id: page.id, title: page.title, tags: page.tags.join(', '), body: page.body, version: page.version });
      await refresh(query);
    } catch (err) { setError(err instanceof Error ? err.message : 'save failed'); }
    finally { setBusy(false); }
  }, [client, editor, query, refresh]);

  const canSave = editor.title.trim().length > 0 && editor.body.trim().length > 0 && !busy;

  return <div className="mem-layout">
    <section className="mem-list-pane">
      <form className="mem-search" onSubmit={(e) => { e.preventDefault(); void refresh(query); }}>
        <input aria-label={text('Search wiki', 'Wiki を検索')} placeholder={text('Search wiki…', 'Wiki を検索…')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit">{text('Search', '検索')}</button>
      </form>
      <ul className="mem-list">
        {pages.length === 0 ? <li className="mem-empty">{text('No wiki pages yet.', 'Wiki ページはまだありません。')}</li>
          : pages.map((page) => <li key={page.id}>
            <button type="button" className={editor.id === page.id ? 'active' : ''} onClick={() => void open(page.id)}>
              <strong>{page.title}</strong>
              <span className="mem-badges">{page.tags.map((tag) => <span key={tag} className="mem-tag">{tag}</span>)}</span>
              <small>v{page.version}</small>
            </button>
          </li>)}
      </ul>
    </section>
    <section className="mem-editor">
      <div className="mem-editor-head">
        <h2>{editor.id !== undefined ? `${text('Edit page', 'ページ編集')} · v${editor.version ?? 1}` : text('New page', '新規ページ')}</h2>
        <button type="button" className="ghost" onClick={() => setEditor(EMPTY_EDITOR)}>{text('New', '新規')}</button>
      </div>
      <label>{text('Title', 'タイトル')}<input value={editor.title} onChange={(e) => setEditor((s) => ({ ...s, title: e.target.value }))} /></label>
      <label>{text('Tags (comma-separated)', 'タグ（カンマ区切り）')}<input value={editor.tags} onChange={(e) => setEditor((s) => ({ ...s, tags: e.target.value }))} /></label>
      <label>{text('Body', '本文')}<textarea rows={12} value={editor.body} onChange={(e) => setEditor((s) => ({ ...s, body: e.target.value }))} /></label>
      {error !== null ? <p className="mem-error" role="alert">{error}</p> : null}
      <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>{busy ? text('Saving…', '保存中…') : text('Save page', 'ページを保存')}</button>
    </section>
  </div>;
}

const STATES: readonly (MemoryProposalStateDto | 'all')[] = ['draft', 'approved', 'rejected', 'all'];

function ProposalsTab({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();
  const [filter, setFilter] = useState<MemoryProposalStateDto | 'all'>('draft');
  const [proposals, setProposals] = useState<readonly MemoryProposalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
    {error !== null ? <p className="mem-error" role="alert">{error}</p> : null}
    {proposals.length === 0 ? <p className="mem-empty">{text('No proposals.', '提案はありません。')}</p>
      : <ul className="mem-proposal-list">
        {proposals.map((proposal) => <li key={proposal.id} className={`mem-card mem-card-${proposal.state}`}>
          <div className="mem-card-head">
            <span className={`mem-kind mem-kind-${proposal.target.kind}`}>{proposal.target.kind === 'wiki' ? text('Wiki', 'Wiki') : text('Skill', 'Skill')}</span>
            <span className={`mem-state mem-state-${proposal.state}`}>{stateLabel(proposal.state)}</span>
          </div>
          <p className="mem-summary">{proposal.summary}</p>
          {proposal.target.kind === 'wiki'
            ? <div className="mem-preview"><strong>{proposal.target.isNewPage ? text('New page', '新規ページ') : text('Revision', '改訂')}: {proposal.target.title}</strong><pre>{proposal.target.body}</pre></div>
            : <div className="mem-preview"><strong>{text('Skill', 'Skill')}: {proposal.target.skillId}</strong><pre>{proposal.target.instructions}</pre></div>}
          {proposal.state === 'draft' ? <div className="mem-actions">
            <button type="button" className="primary" disabled={busyId === proposal.id} onClick={() => void decide(proposal.id, 'approve')}>{text('Approve', '承認')}</button>
            <button type="button" className="ghost" disabled={busyId === proposal.id} onClick={() => void decide(proposal.id, 'reject')}>{text('Reject', '却下')}</button>
          </div> : null}
        </li>)}
      </ul>}
  </div>;
}
