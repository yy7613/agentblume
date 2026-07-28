import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { BackupSummaryDto, OperationsStatusDto, RunFeedbackDto, RunRecordDto, RunSummaryDto, RunTraceEventDto, TenantScopeDto } from '../api/types';
import { useI18n } from '../i18n';
import { InlineFeedback } from '../components/InlineFeedback';
import { scope } from '../scope';

export function StatusPage({ client }: { readonly client: ToolApiClient }) {
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
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function select(runId: string): Promise<void> {
    setError(undefined);
    try {
      const run = await client.getRunTrace(runId, scope); setSelected(run); setFeedbackSaved(false);
      if (typeof client.getRunFeedback === 'function') {
        const existing = await client.getRunFeedback(runId, scope); setFeedback(existing ?? undefined);
        setThumb(existing?.thumb ?? 'up'); setRating(existing?.rating ?? 5); setComment(existing?.comment ?? ''); setIssueTags(existing?.issueTags.join(', ') ?? '');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Trace lookup failed'); }
  }

  function editThumb(next: 'up' | 'down'): void { setThumb(next); setFeedbackSaved(false); }
  function editRating(next: number): void { setRating(next); setFeedbackSaved(false); }
  function editComment(next: string): void { setComment(next); setFeedbackSaved(false); }
  function editIssueTags(next: string): void { setIssueTags(next); setFeedbackSaved(false); }

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
    <MaintenancePanel client={client} scope={scope} />

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
          {selected.agent?.version !== undefined && <section className="run-feedback" aria-label={text('Run feedback', '実行フィードバック')}><h3>{text('Feedback', 'フィードバック')}</h3><div className="feedback-thumbs"><button type="button" className={thumb === 'up' ? 'selected' : 'secondary'} onClick={() => editThumb('up')}>👍 {text('Good', '良い')}</button><button type="button" className={thumb === 'down' ? 'selected' : 'secondary'} onClick={() => editThumb('down')}>👎 {text('Needs work', '要改善')}</button></div><label>{text('Rating', '評価')}<select value={rating} onChange={(event) => editRating(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>{text('Issue tags (comma separated)', '課題タグ（カンマ区切り）')}<input value={issueTags} onChange={(event) => editIssueTags(event.target.value)} placeholder="incorrect, unsafe, slow" /></label><label>{text('Comment', 'コメント')}<textarea value={comment} maxLength={2000} onChange={(event) => editComment(event.target.value)} /></label><button type="button" onClick={() => void saveFeedback()}>{feedback === undefined ? text('Save feedback', 'フィードバックを保存') : text('Update feedback', 'フィードバックを更新')}</button>{feedbackSaved && <InlineFeedback kind="success" autoHideMs={3000} onDismiss={() => setFeedbackSaved(false)}>{text('Saved', '保存しました')}</InlineFeedback>}</section>}
          <div className="trace-list">{selected.trace.map((event) => <StatusTraceEvent key={event.sequence} event={event} onOpenChild={(runId) => void select(runId)} />)}</div>
        </>}
      </section>
    </div>
  </main>;
}

/** バイト数を人が読める単位へ（バックアップの規模感が分かればよいので小数1桁）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * バックアップの失敗は原因ごとに**利用者がやることが違う**ので、原因を推定して次の一手を添える。
 * 例外メッセージだけ出すと `ENOSPC: no space left on device, write` のままで、
 * 「どこの空きが足りないのか」「何をすればよいのか」が伝わらない。
 */
export function backupFailureHint(message: string, text: (en: string, ja: string) => string): string | undefined {
  if (/ENOSPC|no space left/i.test(message)) return text('The disk holding the backup directory is full. Free up space or point AGENTCONTEXT_BACKUP_DIR at another drive.', 'バックアップ先のディスクに空きがありません。空き容量を作るか、AGENTCONTEXT_BACKUP_DIR で別のドライブを指定してください。');
  if (/EACCES|EPERM|permission denied/i.test(message)) return text('The server process cannot write to the backup directory. Check its permissions, or set AGENTCONTEXT_BACKUP_DIR to a writable path.', 'サーバープロセスがバックアップ先へ書き込めません。権限を確認するか、AGENTCONTEXT_BACKUP_DIR に書き込み可能なパスを指定してください。');
  if (/EROFS|read-only file system/i.test(message)) return text('The backup directory is on a read-only filesystem. Set AGENTCONTEXT_BACKUP_DIR to a writable path.', 'バックアップ先が読み取り専用です。AGENTCONTEXT_BACKUP_DIR に書き込み可能なパスを指定してください。');
  if (/in-memory|:memory:/i.test(message)) return text('This server runs on an in-memory database, so there is nothing to back up. Set AGENTCONTEXT_DB_PATH to a file and restart.', 'このサーバーは揮発DB（:memory:）で動いているためバックアップできません。AGENTCONTEXT_DB_PATH にファイルを指定して再起動してください。');
  return undefined;
}

interface MaintenanceNotice { readonly kind: 'ok' | 'error'; readonly message: string; readonly details: readonly string[] }

/**
 * 運用操作（バックアップ・保持期限の手動適用）。
 *
 * バックアップは**サーバーのファイルシステムへ書く**ためブラウザのダウンロードにはならない。
 * ローカル実行のIDEではサーバー＝利用者のPCなので、保存先パスを見せるほうが実態に合う
 * （別マシンへ持ち出すときはそのディレクトリをコピーする）。
 */
function MaintenancePanel({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  const [root, setRoot] = useState<string>();
  const [backups, setBackups] = useState<readonly BackupSummaryDto[]>([]);
  const [includeSecretKey, setIncludeSecretKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MaintenanceNotice>();

  const supported = typeof client.listBackups === 'function' && typeof client.createBackup === 'function';

  const refresh = useCallback(async () => {
    if (typeof client.listBackups !== 'function') return;
    try {
      const list = await client.listBackups();
      setRoot(list.root); setBackups(list.backups);
    } catch (cause) {
      setNotice({ kind: 'error', message: cause instanceof Error ? cause.message : 'Backup lookup failed', details: [] });
    }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);

  function fail(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : 'Operation failed';
    const hint = backupFailureHint(message, text);
    setNotice({ kind: 'error', message, details: hint === undefined ? [] : [hint] });
  }

  async function createBackup(): Promise<void> {
    if (typeof client.createBackup !== 'function') return;
    setBusy(true); setNotice(undefined);
    try {
      const created = await client.createBackup(includeSecretKey);
      setNotice({ kind: 'ok', message: text(`Backup created at ${created.path}`, `バックアップを作成しました: ${created.path}`), details: created.warnings });
      await refresh();
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }

  async function applyRetention(): Promise<void> {
    if (typeof client.applyRetention !== 'function') return;
    setBusy(true); setNotice(undefined);
    try {
      const result = await client.applyRetention(scope);
      setNotice({
        kind: 'ok',
        message: text(
          `Retention applied: ${result.deleted} run(s) deleted, ${result.payloadRedacted} payload(s) redacted, ${result.traceRedacted} trace(s) redacted, ${result.feedbackDeleted} feedback deleted, ${result.aggregateBucketsDeleted} daily bucket(s) deleted.`,
          `保持期限を適用しました: Run削除 ${result.deleted} 件 / payload伏せ字 ${result.payloadRedacted} 件 / trace伏せ字 ${result.traceRedacted} 件 / feedback削除 ${result.feedbackDeleted} 件 / 日次集計削除 ${result.aggregateBucketsDeleted} 件。`,
        ),
        details: [],
      });
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }

  if (!supported) return null;
  return <section className="workspace-card maintenance-panel" aria-label={text('Maintenance', 'メンテナンス')}>
    <h2>{text('Backup and cleanup', 'バックアップと掃除')}</h2>
    <p className="empty-state">{text('A backup copies the database and the session artifact files into a folder on the machine running the server. Copy that folder to another drive to keep it safe. Restoring is done from the command line while the server is stopped.', 'バックアップはDBとセッションアーティファクトの実ファイルを、サーバーが動いているマシン上のフォルダへコピーします。安全のため別ドライブへコピーしてください。復元はサーバーを停止した状態でコマンドラインから行います。')}</p>
    {root !== undefined && <dl className="settings-list"><div><dt>{text('Backup folder', 'バックアップ先')}</dt><dd><code>{root}</code></dd></div></dl>}
    <label className="structured-output-toggle">
      <input type="checkbox" checked={includeSecretKey} onChange={(event) => setIncludeSecretKey(event.target.checked)} />
      {text('Include the secret key file', '暗号鍵ファイルも含める')}
    </label>
    {includeSecretKey && <p className="field-error" role="status">{text('The backup will then be able to decrypt every stored API key. Store it exactly as carefully as the keys themselves.', 'このバックアップは保存済みAPIキーをすべて復号できるようになります。APIキーそのものと同じ厳重さで保管してください。')}</p>}
    <div className="save-actions">
      <button type="button" className="primary" disabled={busy} onClick={() => void createBackup()}>{busy ? text('Working…', '実行中…') : text('Create backup', 'バックアップを作成')}</button>
      <button type="button" className="secondary" disabled={busy || typeof client.applyRetention !== 'function'} onClick={() => void applyRetention()}>{text('Apply retention now', '保持期限をいま適用')}</button>
    </div>
    {notice !== undefined && <div className={notice.kind === 'error' ? 'api-error' : 'model-slot-ok'} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <p>{notice.message}</p>
      {notice.details.map((detail) => <p key={detail} className="model-slot-note">{detail}</p>)}
    </div>}
    {backups.length === 0
      ? <p className="empty-state">{text('No backups yet.', 'バックアップはまだありません。')}</p>
      : <ul className="backup-list">{backups.slice(0, 10).map((backup) => <li key={backup.name}>
        <code>{backup.name}</code>
        {backup.manifest === undefined
          ? <span className="field-error">{text('Incomplete backup (no manifest) — safe to delete.', '未完成のバックアップ（manifestなし）。削除して構いません。')}</span>
          : <span>{new Date(backup.manifest.createdAt).toLocaleString()} · {formatBytes(backup.manifest.database.bytes + backup.manifest.artifacts.bytes)} · schema v{backup.manifest.schemaVersion} · {backup.manifest.secretKey.included ? text('key included', '鍵あり') : text('no key', '鍵なし')}</span>}
      </li>)}</ul>}
  </section>;
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
  if (event.kind === 'compaction') return <div className="trace-event"><span>{event.sequence}</span><p>Compaction · {event.beforeChars} → {event.afterChars} chars</p></div>;
  if (event.kind === 'approval-requested') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>Approval requested</strong> {event.tool} ({event.sideEffect})</p></div>;
  if (event.kind === 'approval-resolved') return <div className="trace-event tool"><span>{event.sequence}</span><p><strong>Approval</strong> {event.decision}</p></div>;
  return <div className="trace-event"><span>{event.sequence}</span><p>{event.content}</p></div>;
}
