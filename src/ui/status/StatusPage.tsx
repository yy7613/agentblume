import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { RunRecordDto, RunSummaryDto, RunTraceEventDto } from '../api/types';
import { useToolBuilderStore } from '../tool-builder/store';

export function StatusPage({ client }: { readonly client: ToolApiClient }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const scope = { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId };
  const [runs, setRuns] = useState<readonly RunSummaryDto[]>([]);
  const [selected, setSelected] = useState<RunRecordDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

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
    <header className="status-header"><div><span className="eyebrow">Observability</span><h1>Run status</h1><p>{scope.tenantId} / {scope.workspaceId}</p></div><button type="button" className="secondary" onClick={() => void refresh()}>{loading ? 'Loading…' : 'Refresh'}</button></header>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <div className="status-workspace">
      <section className="run-list" aria-label="Run history">
        {runs.length === 0 && !loading ? <p className="empty-state">保存済みrunはありません。</p> : runs.map((run) => <button type="button" key={run.runId} className={selected?.runId === run.runId ? 'selected' : ''} onClick={() => void select(run.runId)}>
          <span className={`run-status ${run.status}`}>{run.status}</span><strong>{run.tool.publishName ?? run.tool.internalId}</strong><code>{run.tool.version ?? 'latest'} · {run.traceEventCount} events</code><time>{new Date(run.startedAt).toLocaleString()}</time>
        </button>)}
      </section>
      <section className="run-detail" aria-label="Run trace">
        {selected === undefined ? <p className="empty-state">runを選択するとtraceを表示します。</p> : <>
          <div className="run-detail-title"><div><span className={`run-status ${selected.status}`}>{selected.status}</span><h2>{selected.runId}</h2></div><code>{selected.tool.internalId}@{selected.tool.version ?? 'latest'}</code></div>
          {selected.response !== undefined && <div className="chat-response"><span>Response</span><p>{selected.response}</p></div>}
          {selected.failure !== undefined && <div className="api-error"><strong>{selected.failure.code}</strong> {selected.failure.message}</div>}
          <div className="trace-list">{selected.trace.map((event) => <StatusTraceEvent key={event.sequence} event={event} />)}</div>
        </>}
      </section>
    </div>
  </main>;
}
function StatusTraceEvent({ event }: { readonly event: RunTraceEventDto }) {
  if (event.kind === 'model-request') return <div className="trace-event"><span>{event.sequence}</span><p>Model request · step {event.step}</p></div>;
  if (event.kind === 'tool-call') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>{event.name}</strong> {JSON.stringify(event.arguments)}</p></div>;
  if (event.kind === 'tool-result') return <div className="trace-event tool"><span>{event.sequence}</span><div><strong>{event.name}</strong>{event.nodes.map((node) => <code key={node.nodeId}>{node.nodeId}: {node.rowCount} row(s){node.truncated ? ' · truncated' : ''}</code>)}</div></div>;
  if (event.kind === 'error') return <div className="trace-event error"><span>{event.sequence}</span><p><strong>{event.code}</strong> {event.message}</p></div>;
  return <div className="trace-event"><span>{event.sequence}</span><p>{event.content}</p></div>;
}
