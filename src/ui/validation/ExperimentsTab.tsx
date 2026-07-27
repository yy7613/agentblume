import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, EvaluationDatasetSummaryDto, EvaluatorProfileSummaryDto, ExperimentCaseResultDto, ExperimentDto, RunRecordDto, TenantScopeDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

const message = (cause: unknown): string => cause instanceof Error ? cause.message : 'Request failed';

export function ExperimentsTab({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { text } = useI18n();
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [datasets, setDatasets] = useState<readonly EvaluationDatasetSummaryDto[]>([]);
  const [profiles, setProfiles] = useState<readonly EvaluatorProfileSummaryDto[]>([]);
  const [experiments, setExperiments] = useState<readonly ExperimentDto[]>([]);
  const [agentId, setAgentId] = useState(''); const [agentVersion, setAgentVersion] = useState(''); const [agentVersions, setAgentVersions] = useState<readonly string[]>([]);
  const [datasetId, setDatasetId] = useState(''); const [datasetVersion, setDatasetVersion] = useState(''); const [datasetVersions, setDatasetVersions] = useState<readonly string[]>([]);
  const [profileId, setProfileId] = useState(''); const [profileVersion, setProfileVersion] = useState(''); const [profileVersions, setProfileVersions] = useState<readonly string[]>([]);
  const [repetitions, setRepetitions] = useState(1);
  const [selected, setSelected] = useState<ExperimentDto>();
  const [results, setResults] = useState<readonly ExperimentCaseResultDto[]>([]);
  const [trace, setTrace] = useState<RunRecordDto>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [pendingCancel, setPendingCancel] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([client.listAgents(scope), client.listEvaluationDatasets(scope), client.listEvaluatorProfiles(scope), client.listExperiments(scope)])
      .then(([agentItems, datasetItems, profileItems, experimentItems]) => {
        if (!active) return;
        const targets = agentItems.filter((item) => item.kind !== 'pseudo-user');
        setAgents(targets); setDatasets(datasetItems); setProfiles(profileItems); setExperiments(experimentItems);
        const agent = targets[0]; if (agent !== undefined) { setAgentId(agent.internalId); setAgentVersion(agent.latestVersion); setAgentVersions([agent.latestVersion]); }
        const dataset = datasetItems[0]; if (dataset !== undefined) { setDatasetId(dataset.internalId); setDatasetVersion(dataset.latestVersion); setDatasetVersions([dataset.latestVersion]); }
        const profile = profileItems[0]; if (profile !== undefined) { setProfileId(profile.internalId); setProfileVersion(profile.latestVersion); setProfileVersions([profile.latestVersion]); }
      }).catch((cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [client, scope]);

  useEffect(() => {
    if (selected === undefined || (selected.status !== 'queued' && selected.status !== 'running')) return;
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const [next, nextResults] = await Promise.all([client.getExperiment(selected.id, scope), client.listExperimentResults(selected.id, scope)]);
        // 750msポーリングは自動実行のため、成功したら一時的な通信エラーの赤バナーをクリアする。
        if (active) { setError(undefined); setSelected(next); setResults(nextResults); if (next.status !== 'queued' && next.status !== 'running') setExperiments(await client.listExperiments(scope)); }
      } catch (cause) { if (active) setError(message(cause)); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 750);
    return () => { active = false; clearInterval(timer); };
  }, [client, scope, selected?.id, selected?.status]);

  async function selectAgent(id: string): Promise<void> { setAgentId(id); const summary = agents.find((item) => item.internalId === id); const versions = id === '' ? [] : await client.listAgentVersions(id, scope); setAgentVersions(versions); setAgentVersion(summary?.latestVersion ?? versions.at(-1) ?? ''); }
  async function selectDataset(id: string): Promise<void> { setDatasetId(id); const summary = datasets.find((item) => item.internalId === id); const versions = id === '' ? [] : await client.listEvaluationDatasetVersions(id, scope); setDatasetVersions(versions); setDatasetVersion(summary?.latestVersion ?? versions.at(-1) ?? ''); }
  async function selectProfile(id: string): Promise<void> { setProfileId(id); const summary = profiles.find((item) => item.internalId === id); const versions = id === '' ? [] : await client.listEvaluatorProfileVersions(id, scope); setProfileVersions(versions); setProfileVersion(summary?.latestVersion ?? versions.at(-1) ?? ''); }

  async function create(): Promise<void> {
    setBusy(true); setError(undefined);
    try { const experiment = await client.createExperiment({ scope, target: { agentId, version: agentVersion }, dataset: { id: datasetId, version: datasetVersion }, evaluatorProfile: { id: profileId, version: profileVersion }, repetitions }); setSelected(experiment); setResults([]); setExperiments(await client.listExperiments(scope)); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function open(experiment: ExperimentDto): Promise<void> { setSelected(experiment); setTrace(undefined); setError(undefined); try { setResults(await client.listExperimentResults(experiment.id, scope)); } catch (cause) { setError(message(cause)); } }
  async function cancel(): Promise<void> { if (selected === undefined) return; setBusy(true); setError(undefined); try { setSelected(await client.cancelExperiment(selected.id, scope)); setExperiments(await client.listExperiments(scope)); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  async function resume(): Promise<void> { if (selected === undefined) return; setBusy(true); setError(undefined); try { setSelected(await client.resumeExperiment(selected.id, scope)); setExperiments(await client.listExperiments(scope)); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } }
  async function openTrace(runId: string): Promise<void> { setError(undefined); try { setTrace(await client.getRunTrace(runId, scope)); } catch (cause) { setError(message(cause)); } }

  const valid = agentId !== '' && agentVersion !== '' && datasetId !== '' && datasetVersion !== '' && profileId !== '' && profileVersion !== '' && Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10;
  const percent = selected === undefined ? 0 : Math.round(selected.progress.completed / selected.progress.total * 100);
  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <section className="workspace-card experiment-create" aria-label={text('Create experiment', '実験作成')}>
      <div className="panel-title"><h2>{text('Batch experiment', 'バッチ実験')}</h2><button type="button" className="primary" disabled={!valid || busy} onClick={() => void create()}>{busy ? text('Working…', '処理中…') : text('Run experiment', '実験を開始')}</button></div>
      <div className="experiment-fields">
        <label>{text('Target agent', '対象Agent')}<select aria-label="Experiment target agent" value={agentId} onChange={(event) => void selectAgent(event.target.value)}><option value="">—</option>{agents.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label>
        <label>{text('Agent version', 'Agent版')}<select aria-label="Experiment agent version" value={agentVersion} onChange={(event) => setAgentVersion(event.target.value)}>{agentVersions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Dataset<select aria-label="Experiment dataset" value={datasetId} onChange={(event) => void selectDataset(event.target.value)}><option value="">—</option>{datasets.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label>
        <label>{text('Dataset version', 'Dataset版')}<select aria-label="Experiment dataset version" value={datasetVersion} onChange={(event) => setDatasetVersion(event.target.value)}>{datasetVersions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{text('Evaluator profile', '評価プロファイル')}<select aria-label="Experiment evaluator profile" value={profileId} onChange={(event) => void selectProfile(event.target.value)}><option value="">—</option>{profiles.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label>
        <label>{text('Profile version', 'Profile版')}<select aria-label="Experiment profile version" value={profileVersion} onChange={(event) => setProfileVersion(event.target.value)}>{profileVersions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{text('Repetitions', '反復回数')}<input aria-label="Experiment repetitions" type="number" min={1} max={10} value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))} /></label>
      </div>
      {(agents.length === 0 || datasets.length === 0 || profiles.length === 0) && <p className="empty-state">{text('An Agent, Dataset, and Evaluator Profile are required.', 'Agent、Dataset、Evaluator Profileが必要です。')}</p>}
    </section>
    <div className="two-column-workspace experiment-workspace">
      <section className="workspace-card"><h2>{text('Experiments', '実験一覧')}</h2><div className="validation-list">{experiments.length === 0 && <p className="empty-state">{text('No experiments yet.', '実験はまだありません。')}</p>}{experiments.map((item) => <button type="button" key={item.id} className={selected?.id === item.id ? 'selected' : ''} onClick={() => void open(item)}><strong>{item.target.agentId}@{item.target.version}</strong><span className={`experiment-status ${item.status}`}>{item.status}</span><span className="run-meta">{item.progress.completed}/{item.progress.total} · {item.dataset.id}@{item.dataset.version}</span></button>)}</div></section>
      <section className="workspace-card" aria-label={text('Experiment detail', '実験詳細')}>
        {selected === undefined ? <p className="empty-state">{text('Select or run an experiment.', '実験を選択または開始してください。')}</p> : <>
          <div className="panel-title"><h2>{selected.target.agentId}@{selected.target.version}</h2><div className="save-actions">{(selected.status === 'queued' || selected.status === 'running') && <button type="button" className="secondary" disabled={busy} onClick={() => setPendingCancel(true)}>{text('Cancel', '取消')}</button>}{(selected.status === 'interrupted' || selected.status === 'failed') && <button type="button" className="primary" disabled={busy} onClick={() => void resume()}>{text('Resume', '再開')}</button>}</div></div>
          {/* モデル設定を解決できないまま起票された実験は provider/model が 'unresolved' で残る（起票は通す仕様）。 */}
          <p><span className={`experiment-status ${selected.status}`}>{selected.status}</span> · {selected.snapshot.provider === 'unresolved'
            ? text('model settings unresolved (check model settings)', 'モデル設定を解決できませんでした（設定画面のモデル設定を確認してください）')
            : `${selected.snapshot.provider}/${selected.snapshot.model}`}</p>
          <div className="experiment-progress" role="progressbar" aria-label="Experiment progress" aria-valuemin={0} aria-valuemax={selected.progress.total} aria-valuenow={selected.progress.completed}><div style={{ width: `${percent}%` }} /></div><p>{selected.progress.completed}/{selected.progress.total} ({percent}%)</p>
          {selected.error !== undefined && <div className="api-error">{selected.error.code}: {selected.error.message}</div>}
          <div className="table-wrap"><table><thead><tr><th>Case</th><th>Status</th><th>Scores / Judge snapshot</th><th>Latency</th><th>Tokens</th><th>Runs</th></tr></thead><tbody>{results.map((result) => <tr key={`${result.caseId}-${result.repetition}`}><td>{result.caseId} #{result.repetition}</td><td>{result.status}{result.error !== undefined && <small> · {result.error.code}</small>}</td><td><div>{result.scores.map((score) => `${score.metric} ${score.score.toFixed(2)}${score.reason === undefined ? '' : ` (${score.reason})`}`).join(', ') || '—'}</div>{result.judgeEvaluations?.map((judge) => <small className={`judge-record ${judge.status}`} key={judge.metricId}>{judge.metricId} · {judge.status} · {judge.rubric.id}@{judge.rubric.version} · {judge.model.provider}/{judge.model.model}{judge.reason !== undefined ? ` · ${judge.reason}` : ''}{judge.error !== undefined ? ` · ${judge.error.code}: ${judge.error.message}` : ''}</small>)}</td><td>{result.latencyMs} ms</td><td>{result.usage.totalTokens ?? '—'}</td><td>{result.runIds.map((runId) => <button type="button" className="run-link" key={runId} onClick={() => void openTrace(runId)}>{runId}</button>)}</td></tr>)}</tbody></table></div>
          {trace !== undefined && <details open className="ins-trace"><summary>Run trace · {trace.runId}</summary><div className="trace-list">{trace.trace.map((event) => <div className="trace-event" key={event.sequence}>{event.sequence} · {event.kind}</div>)}</div></details>}
        </>}
      </section>
    </div>
    <ConfirmDialog
      open={pendingCancel}
      title={text('Cancel experiment', '実験を取消')}
      message={text('Cancel this running experiment? Completed results are kept, but the run will stop.', 'この実行中の実験を取り消しますか？完了済みの結果は保持されますが、実行は停止します。')}
      confirmLabel={text('Cancel experiment', '実験を取消')}
      cancelLabel={text('Keep running', '続行する')}
      danger
      busy={busy}
      onConfirm={() => { void cancel().then(() => setPendingCancel(false)); }}
      onCancel={() => setPendingCancel(false)}
    />
  </>;
}
