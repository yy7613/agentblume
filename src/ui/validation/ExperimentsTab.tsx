import { useEffect, useState } from 'react';
import { describeMcpServerSkipped, isJudgeModelNotConfigured, localizeJudgeFailure, localizeRunTraceError } from '../api/error-messages';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, EvaluationDatasetSummaryDto, EvaluatorProfileSummaryDto, ExperimentCaseResultDto, ExperimentDto, JudgeEvaluationRecordDto, JudgeReadinessDto, RunRecordDto, TenantScopeDto } from '../api/types';
import type { Language } from '../i18n';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';
import { useOpenInScreen } from '../navigation';

const message = (cause: unknown): string => cause instanceof Error ? cause.message : 'Request failed';
/** 判定サンプル数の許容範囲（サーバー契約 1〜5）。範囲外は丸め、数値でない入力は無視する。 */
export const JUDGE_SAMPLES_MIN = 1;
export const JUDGE_SAMPLES_MAX = 5;
export function clampJudgeSamples(raw: string, previous: number): number {
  if (raw.trim() === '') return previous;
  const value = Number(raw);
  if (!Number.isFinite(value)) return previous;
  return Math.min(JUDGE_SAMPLES_MAX, Math.max(JUDGE_SAMPLES_MIN, Math.trunc(value)));
}
type Translate = (english: string, japanese: string) => string;

/** 設定画面の judge スロット（モデル設定カード）を開く。判定モデル未設定の通知・失敗行から共通で使う。 */
function JudgeSettingsButton({ text, small = false }: { readonly text: Translate; readonly small?: boolean }) {
  const openInScreen = useOpenInScreen();
  return <button type="button" className={small ? 'secondary judge-fix' : 'secondary'} onClick={() => openInScreen('Settings', { internalId: 'judge', section: 'model-slot' })}>{text('Set the judge model in Settings', '設定で判定モデルを設定')}</button>;
}

/**
 * 起票前・起票失敗時の「判定モデルが未設定」通知。原因 → 次の一手 → 直す場所へのボタン、の順。
 * 起票前は注意（amber）、サーバーに 409 で拒否された後は失敗（red）として同じ内容を出す。
 */
function JudgeNotConfiguredNotice({ text, failed }: { readonly text: Translate; readonly failed: boolean }) {
  return <div className={failed ? 'api-error run-failure judge-notice' : 'notice-card judge-notice'} role={failed ? 'alert' : 'status'} data-judge-notice={failed ? 'rejected' : 'preflight'}>
    <p><strong>{text('The judge model is not configured', '判定モデルが未設定です')}</strong></p>
    <p>{failed
      ? text('The experiment was rejected because the evaluator profile uses a judge rubric. Set a model in the judge slot, then start the experiment again.', '評価プロファイルが審査ルーブリックを使うため、実験は起票されませんでした。judge スロットにモデルを設定してから、もう一度実験を開始してください。')
      : text('The selected evaluator profile uses a judge rubric, so the experiment will be rejected until a model is set in the judge slot.', '選択中の評価プロファイルは審査ルーブリックを使うため、judge スロットにモデルを設定するまで実験は起票できません。')}</p>
    <div className="save-actions"><JudgeSettingsButton text={text} /></div>
  </div>;
}

/**
 * 判定 1 件の表示。1 行目は従来どおり（metric · status · rubric · model · reason）、その下に P1〜P4 の追加情報を
 * チップで出す。旧実験の記録（criteria / samples / usage / contract が無い）はチップ行が空のまま従来表示になる。
 * 失敗は code だけで終わらせず、原因と次の一手（ポリシー変更・基準の具体化・モデル変更）を言語化する。
 */
function JudgeRecord({ judge, language, text }: { readonly judge: JudgeEvaluationRecordDto; readonly language: Language; readonly text: Translate }) {
  const unassessable = text('cannot assess', '判定不能');
  const hasMeta = judge.samples !== undefined || judge.usage?.totalTokens !== undefined || judge.contract !== undefined;
  return <div className={`judge-record ${judge.status}`}>
    <small>{judge.metricId} · {judge.status} · {judge.rubric.id}@{judge.rubric.version} · {judge.model.provider}/{judge.model.model}{judge.reason !== undefined ? ` · ${judge.reason}` : ''}</small>
    {(judge.score !== undefined || judge.criteria !== undefined || judge.uncertain === true) && <div className="judge-chips">
      {judge.score !== undefined && <span className="judge-chip composite" title={text('Composite score (weighted average of the assessed criteria)', '合成スコア（判定できた基準の重み付き平均）')}>{text('composite', '合成')} {judge.score.toFixed(2)}</span>}
      {judge.criteria?.map((criterion) => <span key={criterion.id} className={`judge-chip criterion ${criterion.score === null ? 'unassessable' : ''}`} title={criterion.reason}>{criterion.id}: {criterion.score === null ? unassessable : criterion.score}</span>)}
      {judge.uncertain === true && <span className="judge-chip uncertain" title={text('The judge samples disagree; treat this score with caution', '判定サンプル間の差が大きいため、このスコアは慎重に扱ってください')}>{text('high dispersion', 'ばらつき大')}{judge.dispersion !== undefined ? ` (${judge.dispersion.min.toFixed(2)}–${judge.dispersion.max.toFixed(2)})` : ''}</span>}
    </div>}
    {hasMeta && <small className="judge-meta">
      {judge.samples !== undefined && <span>{text('samples', 'サンプル')} {judge.samples}</span>}
      {judge.usage?.totalTokens !== undefined && <span>{text(`judge ${judge.usage.totalTokens} tokens`, `判定 ${judge.usage.totalTokens} tokens`)}</span>}
      {judge.contract !== undefined && <span className="judge-contract" title={`${judge.contract.rubricId}@${judge.contract.rubricVersion}`}>{text('prompt', 'プロンプト')} {judge.contract.promptHash.slice(0, 8)}</span>}
    </small>}
    {judge.error !== undefined && <div className="judge-failure" role="note">{judge.error.code}: {localizeJudgeFailure(judge.error, language)}{isJudgeModelNotConfigured(judge.error) && <JudgeSettingsButton text={text} small />}</div>}
  </div>;
}

export function ExperimentsTab({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { language, text } = useI18n();
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [datasets, setDatasets] = useState<readonly EvaluationDatasetSummaryDto[]>([]);
  const [profiles, setProfiles] = useState<readonly EvaluatorProfileSummaryDto[]>([]);
  const [experiments, setExperiments] = useState<readonly ExperimentDto[]>([]);
  const [agentId, setAgentId] = useState(''); const [agentVersion, setAgentVersion] = useState(''); const [agentVersions, setAgentVersions] = useState<readonly string[]>([]);
  const [datasetId, setDatasetId] = useState(''); const [datasetVersion, setDatasetVersion] = useState(''); const [datasetVersions, setDatasetVersions] = useState<readonly string[]>([]);
  const [profileId, setProfileId] = useState(''); const [profileVersion, setProfileVersion] = useState(''); const [profileVersions, setProfileVersions] = useState<readonly string[]>([]);
  const [repetitions, setRepetitions] = useState(1);
  const [judgeSamples, setJudgeSamples] = useState(JUDGE_SAMPLES_MIN);
  const [selected, setSelected] = useState<ExperimentDto>();
  const [results, setResults] = useState<readonly ExperimentCaseResultDto[]>([]);
  const [trace, setTrace] = useState<RunRecordDto>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [pendingCancel, setPendingCancel] = useState(false);
  /** 判定モデルの準備状況。旧サーバー・取得失敗は undefined（= 不明。警告は出さずサーバーの判定に委ねる）。 */
  const [judgeReadiness, setJudgeReadiness] = useState<JudgeReadinessDto>();
  /** 選択中の評価プロファイル版が judge 指標を含むか（版の取得失敗・未選択は false）。 */
  const [profileHasJudge, setProfileHasJudge] = useState(false);
  /** 起票が判定まわりの 409 で拒否されたときの通知（一般のエラーは error に入る）。 */
  const [judgeRejection, setJudgeRejection] = useState<{ readonly kind: 'not-configured' } | { readonly kind: 'trace-unavailable'; readonly message: string; readonly rubric?: { readonly id: string; readonly version: string } }>();
  const openInScreen = useOpenInScreen();

  // 判定モデルの準備状況は表示の補助なので、失敗しても画面は止めない（メソッド未実装のモックでも落ちないよう Promise 内で呼ぶ）。
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => client.runtimeCapabilities()).then((capabilities) => { if (active) setJudgeReadiness(capabilities.judge); }).catch(() => { if (active) setJudgeReadiness(undefined); });
    return () => { active = false; };
  }, [client]);

  // 選択中のプロファイル版の指標を見て judge 指標の有無を判定する（一覧の summary は metricCount しか持たない）。
  useEffect(() => {
    let active = true;
    if (profileId === '' || profileVersion === '') { setProfileHasJudge(false); return; }
    void Promise.resolve().then(() => client.getEvaluatorProfile(profileId, scope, profileVersion)).then((profile) => { if (active) setProfileHasJudge(profile.metrics.some((metric) => metric.kind === 'judge')); }).catch(() => { if (active) setProfileHasJudge(false); });
    return () => { active = false; };
  }, [client, scope, profileId, profileVersion]);

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
    setBusy(true); setError(undefined); setJudgeRejection(undefined);
    try { const experiment = await client.createExperiment({ scope, target: { agentId, version: agentVersion }, dataset: { id: datasetId, version: datasetVersion }, evaluatorProfile: { id: profileId, version: profileVersion }, repetitions, ...(judgeSamples === JUDGE_SAMPLES_MIN ? {} : { judgeSamples }) }); setSelected(experiment); setResults([]); setExperiments(await client.listExperiments(scope)); }
    catch (cause) {
      // 判定まわりの 409 は赤バナーの文字列で終わらせず、直す場所（設定画面 / ルーブリック）へのボタンつき通知にする。
      if (cause instanceof ApiError && cause.code === 'JUDGE_MODEL_NOT_CONFIGURED') setJudgeRejection({ kind: 'not-configured' });
      else if (cause instanceof ApiError && cause.code === 'JUDGE_TRACE_UNAVAILABLE') setJudgeRejection({ kind: 'trace-unavailable', message: cause.message, ...(cause.rubric === undefined ? {} : { rubric: cause.rubric }) });
      else setError(message(cause));
    } finally { setBusy(false); }
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
        {/* aria-label は英語のまま据え置く（テストの参照キー）。表示ラベルだけを翻訳する。 */}
        <label>{text('Dataset', 'データセット')}<select aria-label="Experiment dataset" value={datasetId} onChange={(event) => void selectDataset(event.target.value)}><option value="">—</option>{datasets.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label>
        <label>{text('Dataset version', 'Dataset版')}<select aria-label="Experiment dataset version" value={datasetVersion} onChange={(event) => setDatasetVersion(event.target.value)}>{datasetVersions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{text('Evaluator profile', '評価プロファイル')}<select aria-label="Experiment evaluator profile" value={profileId} onChange={(event) => void selectProfile(event.target.value)}><option value="">—</option>{profiles.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName}</option>)}</select></label>
        <label>{text('Profile version', 'Profile版')}<select aria-label="Experiment profile version" value={profileVersion} onChange={(event) => setProfileVersion(event.target.value)}>{profileVersions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>{text('Repetitions', '反復回数')}<input aria-label="Experiment repetitions" type="number" min={1} max={10} value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))} /></label>
        {/* 判定サンプル数は既定 1 のとき DTO から省く（サーバー既定と同じ・旧サーバーでも起票できる）。 */}
        <label>{text('Judge samples', '判定サンプル数')}<input aria-label="Experiment judge samples" type="number" min={JUDGE_SAMPLES_MIN} max={JUDGE_SAMPLES_MAX} step={1} value={judgeSamples} onChange={(event) => setJudgeSamples((previous) => clampJudgeSamples(event.target.value, previous))} /></label>
      </div>
      <p className="judge-hint">{text('Judge samples: 2 or more judges the same case several times, keeps the median score, and records the dispersion (1–5).', '判定サンプル数: 2 以上で同じ事例を複数回判定し、中央値を採用してばらつきを記録します（1〜5）。')}</p>
      {/* 起票ボタンは塞がない（サーバーの判定が正）。未設定が分かっているときだけ先回りして案内し、拒否されたら同じ内容を失敗として出す。 */}
      {judgeRejection?.kind === 'not-configured' ? <JudgeNotConfiguredNotice text={text} failed />
        : profileHasJudge && judgeReadiness?.configured === false ? <JudgeNotConfiguredNotice text={text} failed={false} /> : null}
      {judgeRejection?.kind === 'trace-unavailable' && <div className="api-error run-failure judge-notice" role="alert" data-judge-notice="trace-unavailable">
        <p><strong>{text('The rubric requires a trace that scenario cases cannot provide', 'ルーブリックが必須にしている軌跡がシナリオ事例では得られません')}</strong></p>
        <p>{judgeRejection.message}</p>
        {judgeRejection.rubric !== undefined && <div className="save-actions"><button type="button" className="secondary" onClick={() => { const rubric = judgeRejection.rubric; if (rubric !== undefined) openInScreen('Validation', { internalId: rubric.id, version: rubric.version, section: 'rubric' }); }}>{text('Open the rubric', 'ルーブリックを開く')}</button></div>}
      </div>}
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
            : `${selected.snapshot.provider}/${selected.snapshot.model}`}{selected.judgeSamples !== undefined && selected.judgeSamples > 1 && <> · <span className="judge-chip composite" title={text('Judge samples per case (median score, dispersion recorded)', '事例ごとの判定サンプル数（中央値を採用し、ばらつきを記録）')}>{text('judge samples', '判定サンプル')} ×{selected.judgeSamples}</span></>}</p>
          <div className="experiment-progress" role="progressbar" aria-label="Experiment progress" aria-valuemin={0} aria-valuemax={selected.progress.total} aria-valuenow={selected.progress.completed}><div style={{ width: `${percent}%` }} /></div><p>{selected.progress.completed}/{selected.progress.total} ({percent}%)</p>
          {selected.error !== undefined && <div className="api-error">{selected.error.code}: {selected.error.message}</div>}
          <div className="table-wrap"><table><thead><tr><th>{text('Case', 'ケース')}</th><th>{text('Status', '状態')}</th><th>{text('Scores / Judge snapshot', 'スコア / Judge記録')}</th><th>{text('Latency', '所要時間')}</th><th>{text('Tokens', 'トークン')}</th><th>{text('Runs', '実行')}</th></tr></thead><tbody>{results.map((result) => <tr key={`${result.caseId}-${result.repetition}`}><td>{result.caseId} #{result.repetition}</td><td>{result.status}{result.error !== undefined && <small> · {result.error.code}</small>}</td><td><div>{result.scores.map((score) => `${score.metric} ${score.score.toFixed(2)}${score.reason === undefined ? '' : ` (${score.reason})`}`).join(', ') || '—'}</div>{result.judgeEvaluations?.map((judge) => <JudgeRecord key={judge.metricId} judge={judge} language={language} text={text} />)}</td><td>{result.latencyMs} ms</td><td>{result.usage.totalTokens ?? '—'}</td><td>{result.runIds.map((runId) => <button type="button" className="run-link" key={runId} onClick={() => void openTrace(runId)}>{runId}</button>)}</td></tr>)}</tbody></table></div>
          {/* 失敗イベントだけは kind 名で終わらせず、言語化した原因と次の一手を出す（他の kind は従来どおり種別だけ）。 */}
          {trace !== undefined && <details open className="ins-trace"><summary>{text('Run trace', '実行トレース')} · {trace.runId}</summary><div className="trace-list">{trace.trace.map((event) => <div className={`trace-event ${event.kind === 'error' || event.kind === 'mcp-server-skipped' ? 'error' : ''}`} key={event.sequence}>{event.sequence} · {event.kind === 'error' ? `${event.code}: ${localizeRunTraceError(event, language)}` : event.kind === 'mcp-server-skipped' ? describeMcpServerSkipped(event, language) : event.kind}</div>)}</div></details>}
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
