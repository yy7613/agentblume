import { useEffect, useMemo, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, AgentSummaryDto } from '../api/types';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

export function ChatPage({ client }: { readonly client: ToolApiClient }) {
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('Use the available capabilities and explain the result.');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { text } = useI18n();
  useEffect(() => { let active = true; setBusy(true); void client.listAgents(scope).then((items) => { if (!active) return; setAgents(items); setSelectedId((current) => current || items[0]?.internalId || ''); }).catch((cause: unknown) => { if (active) setError(messageOf(cause)); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [client]);
  const agent = useMemo(() => agents.find((item) => item.internalId === selectedId), [agents, selectedId]);
  async function send() { if (agent === undefined || message.trim() === '') return; setBusy(true); setError(undefined); setRun(undefined); try { setRun(await client.runSavedAgent({ scope, agent: { internalId: agent.internalId, version: agent.latestVersion }, message, mode: 'preview' })); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); } }
  return <main className="workspace-page"><header className="workspace-header"><div><span className="eyebrow">{text('Chat', 'チャット')}</span><h1>{text('Agent playground', 'エージェント実行')}</h1><p>{text('Run a fixed version of a saved Agent in preview mode.', '保存済みエージェントのバージョンを固定してプレビュー実行します。')}</p></div>{run !== undefined && <span className="version-chip">run {run.runId}</span>}</header>{error !== undefined && <div className="api-error">{error}</div>}<div className="chat-workspace"><section className="workspace-card"><label>{text('Agent', 'エージェント')}<select aria-label={text('Chat agent', 'チャット対象エージェント')} value={selectedId} disabled={busy || agents.length === 0} onChange={(event) => setSelectedId(event.target.value)}><option value="">{text('Select an agent', 'エージェントを選択')}</option>{agents.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName} · {item.latestVersion}</option>)}</select></label>{agents.length === 0 && !busy && <p className="empty-state">{text('Save an Agent in Agent Builder first.', '先にエージェント画面でエージェントを保存してください。')}</p>}<label>{text('Message', 'メッセージ')}<textarea aria-label={text('Chat message', 'チャットメッセージ')} rows={7} value={message} onChange={(event) => setMessage(event.target.value)} /></label><button type="button" className="primary" disabled={busy || agent === undefined || message.trim() === ''} onClick={() => void send()}>{busy ? text('Running…', '実行中…') : text('Send', '送信')}</button></section><section className="workspace-card" aria-label={text('Chat response', 'チャット応答')}><h2>{text('Response', '応答')}</h2>{run === undefined ? <p className="empty-state">{text('The response and trace will appear here.', '実行結果とトレースがここに表示されます。')}</p> : <><div className="chat-response"><span>{text('Assistant', 'アシスタント')}</span>{run.structuredResponse === undefined ? <p>{run.response}</p> : <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>}</div><div className="trace-list">{run.trace.map((event) => <div className={`trace-event ${event.kind.startsWith('tool-') ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind}</p></div>)}</div></>}</section></div></main>;
}
function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : 'Request failed'; }
