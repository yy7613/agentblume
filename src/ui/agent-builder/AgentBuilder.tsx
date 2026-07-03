import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentKindDto, AgentPreviewRunDto, ToolSummaryDto } from '../api/types';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

export function AgentBuilder({ client }: { readonly client: ToolApiClient }) {
  const [tools, setTools] = useState<readonly ToolSummaryDto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [internalId, setInternalId] = useState('assistant-agent');
  const [workingName, setWorkingName] = useState('Assistant Agent');
  const [displayName, setDisplayName] = useState('Assistant Agent');
  const [publishName, setPublishName] = useState('assistant_agent');
  const [owner, setOwner] = useState('local-user');
  const [kind, setKind] = useState<AgentKindDto>('normal');
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful assistant.');
  const [savedVersion, setSavedVersion] = useState<string>();
  const [chatMessage, setChatMessage] = useState('Use the available tools and explain the result.');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [busy, setBusy] = useState<'load' | 'generate' | 'save' | 'run'>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setBusy('load');
    void client.listTools(scope).then((items) => { if (active) setTools(items); })
      .catch((cause: unknown) => { if (active) setError(message(cause)); })
      .finally(() => { if (active) setBusy(undefined); });
    return () => { active = false; };
  }, [client]);

  const refs = useMemo(() => tools.filter((tool) => selected.has(key(tool))).map((tool) => ({ internalId: tool.internalId, version: tool.latestVersion })), [selected, tools]);

  function toggle(tool: ToolSummaryDto): void {
    const id = key(tool);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function generate(): Promise<void> {
    setBusy('generate'); setError(undefined);
    try {
      const draft = await client.generateAgentPrompt({ scope, displayName, kind, tools: refs });
      setSystemPrompt(draft.systemPromptDraft);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  async function save(): Promise<void> {
    setBusy('save'); setError(undefined);
    try {
      const agent = await client.saveAgent({ scope, internalId, workingName, displayName, publishName, owner, kind, systemPrompt, tools: refs });
      setSavedVersion(agent.metadata.version);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  async function runSaved(): Promise<void> {
    if (savedVersion === undefined || chatMessage.trim() === '') return;
    setBusy('run'); setError(undefined); setRun(undefined);
    try {
      setRun(await client.runSavedAgent({
        scope,
        agent: { internalId, version: savedVersion },
        message: chatMessage,
        mode: 'preview',
      }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  return <main className="agent-builder">
    <header className="agent-builder-header">
      <div><span className="eyebrow">Agent Builder</span><h1>{displayName}</h1><p>Tool metadataからsystem promptを生成し、編集後の定義をversion保存します。</p></div>
      <div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">saved {savedVersion}</span>}
        <button type="button" className="secondary" disabled={busy !== undefined} onClick={() => void generate()}>{busy === 'generate' ? 'Generating…' : 'Generate draft'}</button>
        <button type="button" className="primary" disabled={busy !== undefined || systemPrompt.trim() === ''} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save version'}</button>
      </div>
    </header>
    {error !== undefined && <div className="api-error">{error}</div>}
    <div className="agent-builder-grid">
      <section className="agent-definition-card">
        <h2>Definition</h2>
        <div className="agent-fields">
          <label>Internal ID<input aria-label="Agent internal ID" value={internalId} onChange={(event) => setInternalId(event.target.value)} /></label>
          <label>Working name<input value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
          <label>Display name<input aria-label="Agent display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label>Publish name<input value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
          <label>Owner<input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <label>Kind<select aria-label="Agent kind" value={kind} onChange={(event) => setKind(event.target.value as AgentKindDto)}><option value="normal">Normal</option><option value="pseudo-user">Pseudo user</option><option value="evaluator">Evaluator</option></select></label>
        </div>
        <h2>Tools <small>{refs.length} selected</small></h2>
        <div className="agent-tool-list">
          {busy === 'load' && <p className="empty-state">Loading tools…</p>}
          {busy !== 'load' && tools.length === 0 && <p className="empty-state">保存済みToolがありません。</p>}
          {tools.map((tool) => <label key={key(tool)} className="agent-tool-option"><input type="checkbox" checked={selected.has(key(tool))} onChange={() => toggle(tool)} /><span><strong>{tool.displayName}</strong><code>{tool.publishName}@{tool.latestVersion}</code></span><small>{tool.state}</small></label>)}
        </div>
      </section>
      <section className="prompt-editor-card">
        <div className="panel-title"><div><span className="eyebrow">Editable escape hatch</span><h2>System prompt</h2></div><span className="version-chip">{systemPrompt.length} chars</span></div>
        <textarea aria-label="System prompt" rows={28} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
        <p>Generate draftは保存を行いません。草案をレビュー・編集してからSave versionを実行してください。</p>
        <div className="agent-run-panel">
          <div className="panel-title"><div><span className="eyebrow">Saved Agent preview</span><h2>Chat</h2></div><span className="version-chip">{savedVersion === undefined ? 'Save first' : `Agent v${savedVersion}`}</span></div>
          <div className="chat-compose"><textarea aria-label="Agent chat message" rows={2} value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} /><button type="button" className="primary" disabled={savedVersion === undefined || busy !== undefined || chatMessage.trim() === ''} onClick={() => void runSaved()}>{busy === 'run' ? 'Running…' : 'Run saved agent'}</button></div>
          {run !== undefined && <><div className="chat-response"><span>Assistant</span><p>{run.response}</p></div><div className="trace-list"><strong>Trace · {run.runId}</strong>{run.trace.map((event) => <div className={`trace-event ${event.kind === 'tool-call' || event.kind === 'tool-result' ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind}</p></div>)}</div></>}
        </div>
      </section>
    </div>
  </main>;
}

function key(tool: ToolSummaryDto): string { return `${tool.internalId}@${tool.latestVersion}`; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
