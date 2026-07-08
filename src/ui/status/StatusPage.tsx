import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { RunRecordDto, RunSummaryDto, RunTraceEventDto } from '../api/types';
import { useToolBuilderStore } from '../tool-builder/store';
import { useI18n } from '../i18n';

export function StatusPage({ client }: { readonly client: ToolApiClient }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const scope = { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId };
  const [runs, setRuns] = useState<readonly RunSummaryDto[]>([]);
  const [selected, setSelected] = useState<RunRecordDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const { language, text } = useI18n();

  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setRuns(await client.listRuns(scope, { limit: 50 })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Run lookup failed'); }
    finally { setLoading(false); }
  }, [client, metadata.tenantId, metadata.workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function select(runId: string): Promise<void> {
    try { setSelected(await client.getRunTrace(runId, scope)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Trace lookup failed'); }
  }

  return <main className="status-page">
    <header className="status-header"><div><span className="eyebrow">{text('Observability', 'オブザーバビリティ')}</span><h1>{text('Run status', '実行ステータス')}</h1><p>{scope.tenantId} / {scope.workspaceId}</p></div><button type="button" className="secondary" onClick={() => void refresh()}>{loading ? text('Loading…', '読み込み中…') : text('Refresh', '更新')}</button></header>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <div className="status-workspace">
      <section className="run-list" aria-label={text('Run history', '実行履歴')}>
        {runs.length === 0 && !loading ? <p className="empty-state">{text('No saved runs.', '保存済みの実行はありません。')}</p> : runs.map((run) => <button type="button" key={run.runId} className={selected?.runId === run.runId ? 'selected' : ''} onClick={() => void select(run.runId)}>
          <span className={`run-status ${run.status}`}>{run.status}</span><strong>{run.agent?.publishName ?? run.agent?.internalId ?? run.tool?.publishName ?? run.tool?.internalId ?? text('unknown', '不明')}</strong><code>{run.agent?.version ?? run.tool?.version ?? 'latest'} · {run.traceEventCount} {text('events', 'イベント')}</code><time>{new Date(run.startedAt).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}</time>
        </button>)}
      </section>
      <section className="run-detail" aria-label={text('Run trace', '実行トレース')}>
        {selected === undefined ? <p className="empty-state">{text('Select a run to view its trace.', '実行を選択するとトレースを表示します。')}</p> : <>
          <div className="run-detail-title"><div><span className={`run-status ${selected.status}`}>{selected.status}</span><h2>{selected.runId}</h2></div><code>{selected.agent?.internalId ?? selected.tool?.internalId ?? 'unknown'}@{selected.agent?.version ?? selected.tool?.version ?? 'latest'}</code></div>
          {selected.response !== undefined && <div className="chat-response"><span>{text('Response', '応答')}</span>{selected.structuredResponse === undefined ? <p>{selected.response}</p> : <pre>{JSON.stringify(selected.structuredResponse, null, 2)}</pre>}</div>}
          {selected.failure !== undefined && <div className="api-error"><strong>{selected.failure.code}</strong> {selected.failure.message}</div>}
          <div className="trace-list">{selected.trace.map((event) => <StatusTraceEvent key={event.sequence} event={event} onOpenChild={(runId) => void select(runId)} />)}</div>
        </>}
      </section>
    </div>
  </main>;
}
function StatusTraceEvent({ event, onOpenChild }: { readonly event: RunTraceEventDto; readonly onOpenChild: (runId: string) => void }) {
  if (event.kind === 'model-request') return <div className="trace-event"><span>{event.sequence}</span><p>Model request · step {event.step}</p></div>;
  if (event.kind === 'tool-call') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>{event.name}</strong> {JSON.stringify(event.arguments)}</p></div>;
  if (event.kind === 'tool-result') return <div className="trace-event tool"><span>{event.sequence}</span><div><strong>{event.name}</strong>{event.nodes.map((node) => <code key={node.nodeId}>{node.nodeId}: {node.rowCount} row(s){node.truncated ? ' · truncated' : ''}</code>)}</div></div>;
  if (event.kind === 'agent_call') return <div className={`trace-event agent ${event.ok ? '' : 'error'}`}><span>{event.sequence}</span><div><strong>{event.toolName}</strong> → {event.agentRef.internalId}@{event.agentRef.version} {event.ok ? '✓' : '✗'}<small>{event.summary}</small>{event.childRunId !== '' && <button type="button" className="run-link secondary" onClick={() => onOpenChild(event.childRunId)}>child run</button>}</div></div>;
  if (event.kind === 'error') return <div className="trace-event error"><span>{event.sequence}</span><p><strong>{event.code}</strong> {event.message}</p></div>;
  return <div className="trace-event"><span>{event.sequence}</span><p>{event.content}</p></div>;
}
