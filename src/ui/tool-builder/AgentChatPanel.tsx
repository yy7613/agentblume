import { useEffect, useRef, useState } from 'react';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, RunRecordDto, RunTraceEventDto } from '../api/types';
import { useToolBuilderStore } from './store';
import { useI18n } from '../i18n';

export function AgentChatPanel({ client }: { readonly client: ToolApiClient }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const currentVersion = useToolBuilderStore((state) => state.currentVersion);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [message, setMessage] = useState('');
  const [run, setRun] = useState<AgentPreviewRunDto>();
  const [failedRun, setFailedRun] = useState<RunRecordDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const { text } = useI18n();

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

  return <section className="agent-chat-panel" aria-label={text('Agent chat', 'エージェントチャット')}>
    <div className="panel-title"><div><span className="eyebrow">{text('Agent preview', 'エージェントプレビュー')}</span><h2>{text('Model chat', 'モデルとのチャット')}</h2></div><span className="version-chip">{currentVersion === undefined ? text('Save first', '先に保存してください') : `Tool v${currentVersion}`}</span></div>
    <label>{text('System prompt', 'システムプロンプト')}<textarea rows={2} placeholder={text('Explain how the Agent should use this Tool.', 'エージェントがこのツールを使う方針を記述します。')} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} /></label>
    <div className="chat-compose"><textarea aria-label={text('Chat message', 'チャットメッセージ')} rows={2} placeholder={text('Ask the Agent to use this Tool…', 'このツールを使うようエージェントに依頼…')} value={message} onChange={(event) => setMessage(event.target.value)} /><button type="button" className="primary" disabled={currentVersion === undefined || loading || message.trim() === ''} onClick={() => void send()}>{loading ? text('Running…', '実行中…') : text('Run agent', 'エージェントを実行')}</button></div>
    {currentVersion === undefined && <p className="empty-state">{text('Save a validated Tool before connecting it to an Agent.', '検証済みツールを保存するとエージェントへ接続できます。')}</p>}
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    {run !== undefined && <>
      <div className="chat-response"><span>{text('Assistant', 'アシスタント')}</span><p>{run.response}</p></div>
      <div className="trace-list"><strong>Trace · {run.runId}</strong>{run.trace.map((event) => <TraceEvent key={event.sequence} event={event} />)}</div>
    </>}
    {failedRun !== undefined && <div className="trace-list"><strong>{text('Failed trace', '失敗トレース')} · {failedRun.runId}</strong>{failedRun.trace.map((event) => <TraceEvent key={event.sequence} event={event} />)}</div>}
  </section>;
}

function TraceEvent({ event }: { readonly event: RunTraceEventDto }) {
  const { text } = useI18n();
  if (event.kind === 'model-request') return <div className="trace-event"><span>{event.sequence}</span><p>{text('Model request', 'モデル要求')} · step {event.step}{event.toolNames.length > 0 ? ` · ${event.toolNames.join(', ')}` : ''}</p></div>;
  if (event.kind === 'tool-call') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>{event.name}</strong> {JSON.stringify(event.arguments)}</p></div>;
  if (event.kind === 'tool-result') return <div className="trace-event tool"><span>{event.sequence}</span><div><strong>{text('Node outputs', 'ノード出力')}</strong>{event.nodes.map((node) => <code key={node.nodeId}>{node.nodeId}: {node.rowCount} {text('row(s)', '行')}{node.truncated ? text(' · truncated', ' · 切り詰め') : ''}</code>)}</div></div>;
  if (event.kind === 'error') return <div className="trace-event error"><span>{event.sequence}</span><p><strong>{event.code}</strong> {event.message}</p></div>;
  return <div className="trace-event"><span>{event.sequence}</span><p>{text('Model response', 'モデル応答')}</p></div>;
}
