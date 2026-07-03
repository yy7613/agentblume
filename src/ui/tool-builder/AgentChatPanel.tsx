import { useEffect, useRef, useState } from 'react';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, RunRecordDto, RunTraceEventDto } from '../api/types';
import { useToolBuilderStore } from './store';

export function AgentChatPanel({ client }: { readonly client: ToolApiClient }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const currentVersion = useToolBuilderStore((state) => state.currentVersion);
  const [systemPrompt, setSystemPrompt] = useState('Use the connected tool when it can answer the request.');
  const [message, setMessage] = useState('Use this tool and explain the result.');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [failedRun, setFailedRun] = useState<RunRecordDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => controller.current?.abort(), []);

  async function send(): Promise<void> {
    if (currentVersion === undefined || message.trim() === '') return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true); setError(undefined);
    try {
      const result = await client.runAgent({
        scope: { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId },
        tool: { internalId: metadata.internalId, version: currentVersion },
        systemPrompt, message, mode: 'preview',
      }, request.signal);
      setRun(result);
      setFailedRun(undefined);
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof ApiError && cause.runId !== undefined) {
        try { setFailedRun(await client.getRunTrace(cause.runId, { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId })); }
        catch { setFailedRun(undefined); }
        setError(`${cause.message} · run ${cause.runId}`);
      } else setError(cause instanceof Error ? cause.message : 'Agent run failed');
    } finally {
      if (controller.current === request) setLoading(false);
    }
  }

  return <section className="agent-chat-panel" aria-label="Agent chat">
    <div className="panel-title"><div><span className="eyebrow">Agent preview</span><h2>LM Studio chat</h2></div><span className="version-chip">{currentVersion === undefined ? 'Save first' : `Tool v${currentVersion}`}</span></div>
    <label>System prompt<textarea rows={2} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} /></label>
    <div className="chat-compose"><textarea aria-label="Chat message" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} /><button type="button" className="primary" disabled={currentVersion === undefined || loading || message.trim() === ''} onClick={() => void send()}>{loading ? 'Running…' : 'Run agent'}</button></div>
    {currentVersion === undefined && <p className="empty-state">検証済みToolを保存するとAgentへ接続できます。</p>}
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    {run !== undefined && <>
      <div className="chat-response"><span>Assistant</span><p>{run.response}</p></div>
      <div className="trace-list"><strong>Trace · {run.runId}</strong>{run.trace.map((event) => <TraceEvent key={event.sequence} event={event} />)}</div>
    </>}
    {failedRun !== undefined && <div className="trace-list"><strong>Failed trace · {failedRun.runId}</strong>{failedRun.trace.map((event) => <TraceEvent key={event.sequence} event={event} />)}</div>}
  </section>;
}

function TraceEvent({ event }: { readonly event: RunTraceEventDto }) {
  if (event.kind === 'model-request') return <div className="trace-event"><span>{event.sequence}</span><p>Model request · step {event.step}{event.toolNames.length > 0 ? ` · ${event.toolNames.join(', ')}` : ''}</p></div>;
  if (event.kind === 'tool-call') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>{event.name}</strong> {JSON.stringify(event.arguments)}</p></div>;
  if (event.kind === 'tool-result') return <div className="trace-event tool"><span>{event.sequence}</span><div><strong>Node outputs</strong>{event.nodes.map((node) => <code key={node.nodeId}>{node.nodeId}: {node.rowCount} row(s){node.truncated ? ' · truncated' : ''}</code>)}</div></div>;
  if (event.kind === 'error') return <div className="trace-event error"><span>{event.sequence}</span><p><strong>{event.code}</strong> {event.message}</p></div>;
  return <div className="trace-event"><span>{event.sequence}</span><p>Model response</p></div>;
}
