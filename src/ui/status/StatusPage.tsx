import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { OperationsStatusDto, RunFeedbackDto, RunRecordDto, RunSummaryDto, RunTraceEventDto } from '../api/types';
import { useToolBuilderStore } from '../tool-builder/store';
import { useI18n } from '../i18n';

export function StatusPage({ client }: { readonly client: ToolApiClient }) {
  const metadata = useToolBuilderStore((state) => state.metadata);
  const scope = { tenantId: metadata.tenantId, workspaceId: metadata.workspaceId };
  const [runs, setRuns] = useState<readonly RunSummaryDto[]>([]);
  const [status, setStatus] = useState<OperationsStatusDto>();
  const [selected, setSelected] = useState<RunRecordDto>();
  const [feedback, setFeedback] = useState<RunFeedbackDto>();
  const [thumb, setThumb] = useState<'up' | 'down'>('up');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [issueTags, setIssueTags] = useState('');
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const { language, text } = useI18n();

  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const runList = await client.listRuns(scope, { limit: 50 });
      setRuns(runList);
      if (typeof client.getOperationsStatus === 'function') setStatus(await client.getOperationsStatus(scope, 30));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Run lookup failed'); }
    finally { setLoading(false); }
  }, [client, metadata.tenantId, metadata.workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function select(runId: string): Promise<void> {
    try {
      const run = await client.getRunTrace(runId, scope); setSelected(run); setFeedbackSaved(false);
      if (typeof client.getRunFeedback === 'function') {
        const existing = await client.getRunFeedback(runId, scope); setFeedback(existing ?? undefined);
        setThumb(existing?.thumb ?? 'up'); setRating(existing?.rating ?? 5); setComment(existing?.comment ?? ''); setIssueTags(existing?.issueTags.join(', ') ?? '');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Trace lookup failed'); }
  }

  async function saveFeedback(): Promise<void> {
    if (selected === undefined || typeof client.submitRunFeedback !== 'function') return;
    try {
      const saved = await client.submitRunFeedback(selected.runId, { scope, thumb, rating, comment, issueTags: issueTags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      setFeedback(saved); setFeedbackSaved(true); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Feedback save failed'); }
  }

  return <main className="status-page">
    <header className="status-header"><div><span className="eyebrow">{text('Observability', 'オブザーバビリティ')}</span><h1>{text('Run status', '実行ステータス')}</h1><p>{scope.tenantId} / {scope.workspaceId}</p></div><button type="button" className="secondary" onClick={() => void refresh()}>{loading ? text('Loading…', '読み込み中…') : text('Refresh', '更新')}</button></header>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    {status !== undefined && <OperationsSummary status={status} text={text} />}
    <div className="status-workspace">
      <section className="run-list" aria-label={text('Run history', '実行履歴')}>
        {runs.length === 0 && !loading ? <p className="empty-state">{text('No saved runs.', '保存済みの実行はありません。')}</p> : runs.map((run) => <button type="button" key={run.runId} className={selected?.runId === run.runId ? 'selected' : ''} onClick={() => void select(run.runId)}>
          <span className={`run-status ${run.status}`}>{run.status}</span><strong>{run.agent?.publishName ?? run.agent?.internalId ?? run.tool?.publishName ?? run.tool?.internalId ?? text('unknown', '不明')}</strong><code>{run.agent?.version ?? run.tool?.version ?? 'latest'} · {run.purpose ?? 'interactive'} · {run.traceEventCount} {text('events', 'イベント')}</code><time>{new Date(run.startedAt).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}</time>
        </button>)}
      </section>
      <section className="run-detail" aria-label={text('Run trace', '実行トレース')}>
        {selected === undefined ? <p className="empty-state">{text('Select a run to view its trace.', '実行を選択するとトレースを表示します。')}</p> : <>
          <div className="run-detail-title"><div><span className={`run-status ${selected.status}`}>{selected.status}</span><h2>{selected.runId}</h2></div><code>{selected.agent?.internalId ?? selected.tool?.internalId ?? 'unknown'}@{selected.agent?.version ?? selected.tool?.version ?? 'latest'}</code></div>
          <dl className="run-observation"><div><dt>{text('Purpose', '目的')}</dt><dd>{selected.purpose ?? 'interactive'}</dd></div><div><dt>{text('Model', 'モデル')}</dt><dd>{selected.model === undefined ? text('unknown', '不明') : `${selected.model.provider} / ${selected.model.model}`}</dd></div><div><dt>{text('Latency', 'レイテンシ')}</dt><dd>{selected.latency === undefined ? '—' : `${selected.latency.totalMs.toFixed(1)} ms (model ${selected.latency.modelMs.toFixed(1)} / tool ${selected.latency.toolMs.toFixed(1)})`}</dd></div><div><dt>{text('Estimated cost', '推定コスト')}</dt><dd>{selected.estimatedCost === undefined ? text('unavailable', '未算出') : `$${selected.estimatedCost.amount.toFixed(6)} ${selected.estimatedCost.currency}`}</dd></div></dl>
          {selected.response !== undefined && <div className="chat-response"><span>{text('Response', '応答')}</span>{selected.structuredResponse === undefined ? <p>{selected.response}</p> : <pre>{JSON.stringify(selected.structuredResponse, null, 2)}</pre>}</div>}
          {selected.failure !== undefined && <div className="api-error"><strong>{selected.failure.code}</strong> {selected.failure.message}</div>}
          {selected.agent?.version !== undefined && <section className="run-feedback" aria-label={text('Run feedback', '実行フィードバック')}><h3>{text('Feedback', 'フィードバック')}</h3><div className="feedback-thumbs"><button type="button" className={thumb === 'up' ? 'selected' : 'secondary'} onClick={() => setThumb('up')}>👍 {text('Good', '良い')}</button><button type="button" className={thumb === 'down' ? 'selected' : 'secondary'} onClick={() => setThumb('down')}>👎 {text('Needs work', '要改善')}</button></div><label>{text('Rating', '評価')}<select value={rating} onChange={(event) => setRating(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>{text('Issue tags (comma separated)', '課題タグ（カンマ区切り）')}<input value={issueTags} onChange={(event) => setIssueTags(event.target.value)} placeholder="incorrect, unsafe, slow" /></label><label>{text('Comment', 'コメント')}<textarea value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} /></label><button type="button" onClick={() => void saveFeedback()}>{feedback === undefined ? text('Save feedback', 'フィードバックを保存') : text('Update feedback', 'フィードバックを更新')}</button>{feedbackSaved && <span role="status">{text('Saved', '保存しました')}</span>}</section>}
          <div className="trace-list">{selected.trace.map((event) => <StatusTraceEvent key={event.sequence} event={event} onOpenChild={(runId) => void select(runId)} />)}</div>
        </>}
      </section>
    </div>
  </main>;
}

function OperationsSummary({ status, text }: { readonly status: OperationsStatusDto; readonly text: (en: string, ja: string) => string }) {
  const summary = status.summary;
  return <section className="operations-overview" aria-label={text('Operations metrics', '運用メトリクス')}><div className="metric-cards"><Metric label="p50" value={`${summary.p50LatencyMs.toFixed(1)} ms`} /><Metric label="p95" value={`${summary.p95LatencyMs.toFixed(1)} ms`} /><Metric label={text('Failure rate', '失敗率')} value={`${(summary.failureRate * 100).toFixed(1)}%`} /><Metric label={text('Tokens', 'トークン')} value={summary.totalTokens.toLocaleString()} /><Metric label={text('Estimated cost', '推定コスト')} value={`$${summary.estimatedCost.toFixed(6)}`} /><Metric label={text('Feedback rate', 'Feedback率')} value={`${(summary.feedbackRate * 100).toFixed(1)}%`} /></div><div className="metric-timeline">{status.points.map((point) => <div key={point.bucketStart}><time>{point.bucketStart.slice(0, 10)}</time><span>{point.runCount} runs</span><span>p95 {point.p95LatencyMs.toFixed(1)} ms</span><span>{(point.failureRate * 100).toFixed(1)}% fail</span><span>${point.estimatedCost.toFixed(6)}</span></div>)}</div></section>;
}
function Metric({ label, value }: { readonly label: string; readonly value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function StatusTraceEvent({ event, onOpenChild }: { readonly event: RunTraceEventDto; readonly onOpenChild: (runId: string) => void }) {
  if (event.kind === 'model-request') return <div className="trace-event"><span>{event.sequence}</span><p>Model request · step {event.step}</p></div>;
  if (event.kind === 'tool-call') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>{event.name}</strong> {JSON.stringify(event.arguments)}</p></div>;
  if (event.kind === 'tool-result') return <div className="trace-event tool"><span>{event.sequence}</span><div><strong>{event.name}</strong>{event.nodes.map((node) => <code key={node.nodeId}>{node.nodeId}: {node.rowCount} row(s){node.truncated ? ' · truncated' : ''}</code>)}</div></div>;
  if (event.kind === 'agent_call') return <div className={`trace-event agent ${event.ok ? '' : 'error'}`}><span>{event.sequence}</span><div><strong>{event.toolName}</strong> → {event.agentRef.internalId}@{event.agentRef.version} {event.ok ? '✓' : '✗'}<small>{event.summary}</small>{event.childRunId !== '' && <button type="button" className="run-link secondary" onClick={() => onOpenChild(event.childRunId)}>child run</button>}</div></div>;
  if (event.kind === 'error') return <div className="trace-event error"><span>{event.sequence}</span><p><strong>{event.code}</strong> {event.message}</p></div>;
  return <div className="trace-event"><span>{event.sequence}</span><p>{event.content}</p></div>;
}
