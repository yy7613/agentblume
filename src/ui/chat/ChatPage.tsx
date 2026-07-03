import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, AgentSummaryDto } from '../api/types';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

export function ChatPage({ client }: { readonly client: ToolApiClient }) {
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('Use the available capabilities and explain the result.');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { let active = true; setBusy(true); void client.listAgents(scope).then((items) => { if (!active) return; setAgents(items); setSelectedId((current) => current || items[0]?.internalId || ''); }).catch((cause: unknown) => { if (active) setError(messageOf(cause)); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [client]);
  const agent = useMemo(() => agents.find((item) => item.internalId === selectedId), [agents, selectedId]);
  async function send() { if (agent === undefined || message.trim() === '') return; setBusy(true); setError(undefined); setRun(undefined); try { setRun(await client.runSavedAgent({ scope, agent: { internalId: agent.internalId, version: agent.latestVersion }, message, mode: 'preview' })); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } }
  return <main className="workspace-page"><header className="workspace-header"><div><span className="eyebrow">Chat</span><h1>Agent playground</h1><p>保存済みAgent versionを固定してpreview実行します。</p></div>{run !== undefined && <span className="version-chip">run {run.runId}</span>}</header>{error !== undefined && <div className="api-error">{error}</div>}<div className="chat-workspace"><section className="workspace-card"><label>Agent<select aria-label="Chat agent" value={selectedId} disabled={busy || agents.length === 0} onChange={(event) => setSelectedId(event.target.value)}><option value="">Select an agent</option>{agents.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName} · {item.latestVersion}</option>)}</select></label>{agents.length === 0 && !busy && <p className="empty-state">Agent BuilderでAgentを保存してください。</p>}<label>Message<textarea aria-label="Chat message" rows={7} value={message} onChange={(event) => setMessage(event.target.value)} /></label><button type="button" className="primary" disabled={busy || agent === undefined || message.trim() === ''} onClick={() => void send()}>{busy ? 'Running…' : 'Send'}</button></section><section className="workspace-card" aria-label="Chat response"><h2>Response</h2>{run === undefined ? <p className="empty-state">実行結果とtraceがここに表示されます。</p> : <><div className="chat-response"><span>Assistant</span>{run.structuredResponse === undefined ? <p>{run.response}</p> : <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>}</div><div className="trace-list">{run.trace.map((event) => <div className={`trace-event ${event.kind.startsWith('tool-') ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind}</p></div>)}</div></>}</section></div></main>;
}
function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : 'Request failed'; }
