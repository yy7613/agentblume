import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentSummaryDto, CreateFactoryRunDto, DataSourceDto, FactoryEventDto, FactoryRunDto } from '../api/types';
import { useI18n } from '../i18n';
import { ConfirmDialog } from '../components/ConfirmDialog';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
const TERMINAL_STATUSES: ReadonlySet<FactoryRunDto['status']> = new Set(['succeeded', 'failed', 'cancelled']);
/** APIが受け付けるデータソース数の上限（factoryRunBodySchema と同じ値）。 */
const MAX_DATA_SOURCES = 5;

type Translate = (english: string, japanese: string) => string;
/** 生成モード（0→1で新Agentを作る）と強化モード（既存Agentへ差分を積む）の切替。 */
type FactoryMode = 'create' | 'enhance';

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
function isTerminal(status: FactoryRunDto['status']): boolean { return TERMINAL_STATUSES.has(status); }
/** 強化モードのRunは `input.baseAgent` が設定されている（バックエンドの唯一の見分け方）。 */
function isEnhanceRun(run: FactoryRunDto): boolean { return run.input.baseAgent !== undefined; }

/** 強化対象Agentの表示名。一覧に無ければ internalId をそのまま出す（削除済み・別kindでも壊さない）。 */
function baseAgentLabel(run: FactoryRunDto, agents: readonly AgentSummaryDto[]): string {
  const internalId = run.input.baseAgent?.internalId ?? '';
  const found = agents.find((agent) => agent.internalId === internalId);
  return found === undefined || found.displayName.trim() === '' ? internalId : found.displayName;
}

function runLabel(run: FactoryRunDto, text: Translate, agents: readonly AgentSummaryDto[]): string {
  if (isEnhanceRun(run)) {
    const target = baseAgentLabel(run, agents);
    return text(`Enhance: ${target}`, `強化: ${target}`);
  }
  const name = run.plan?.agentBrief.displayName;
  if (name !== undefined && name.trim() !== '') return name;
  const goal = run.input.goal.goal;
  return goal.length > 48 ? `${goal.slice(0, 48)}…` : goal;
}

function statusLabel(status: FactoryRunDto['status'], text: Translate): string {
  switch (status) {
    case 'queued': return text('Queued', 'キュー待ち');
    case 'running': return text('Running', '実行中');
    case 'waiting-approval': return text('Waiting for approval', '承認待ち');
    case 'succeeded': return text('Succeeded', '成功');
    case 'failed': return text('Failed', '失敗');
    case 'cancelled': return text('Cancelled', '取消済み');
  }
}

function stageLabel(stage: FactoryRunDto['stage'], text: Translate): string {
  switch (stage) {
    case 'profiling': return text('Profiling', 'データ把握');
    case 'planning': return text('Planning', '計画');
    case 'generating-tools': return text('Generating tools', 'ツール生成');
    case 'generating-skills': return text('Generating skills', 'スキル生成');
    case 'assembling-agent': return text('Assembling agent', 'エージェント組み立て');
    case 'generating-validation': return text('Generating validation assets', '検証資産の生成');
    case 'validating': return text('Validating', '検証');
    case 'analyzing': return text('Analyzing', '分析');
    case 'improving': return text('Improving', '改善');
    case 'reporting': return text('Reporting', 'レポート作成');
  }
}

function eventKindLabel(kind: FactoryEventDto['kind'], text: Translate): string {
  switch (kind) {
    case 'stage_started': return text('Stage started', '開始');
    case 'stage_completed': return text('Stage completed', '完了');
    case 'plan_proposed': return text('Plan proposed', '計画案を提示');
    case 'approval_requested': return text('Approval requested', '承認をリクエスト');
    case 'approval_resolved': return text('Approval resolved', '承認結果を反映');
    case 'tool_generated': return text('Tool generated', 'ツールを生成');
    case 'tool_reused': return text('Tool reused', 'ツールを再利用');
    case 'tool_repair_attempted': return text('Tool repair attempted', 'ツールの修復を試行');
    case 'artifact_saved': return text('Artifact saved', '資産を保存');
    case 'scenario_run_completed': return text('Scenario run completed', 'シナリオ実行が完了');
    case 'analysis_completed': return text('Analysis completed', '分析が完了');
    case 'proposal_applied': return text('Proposal applied', '提案を適用');
    case 'proposal_rejected': return text('Proposal rejected', '提案を却下');
    case 'iteration_completed': return text('Iteration completed', 'イテレーションが完了');
    case 'budget_exceeded': return text('Budget exceeded', '予算超過');
    case 'run_completed': return text('Run completed', '実行完了');
    case 'run_failed': return text('Run failed', '実行失敗');
    case 'run_cancelled': return text('Run cancelled', '実行取消');
  }
}

function formatElapsed(ms: number, text: Translate): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? text(`${minutes}m ${seconds}s`, `${minutes}分${seconds}秒`) : text(`${seconds}s`, `${seconds}秒`);
}

/**
 * Agent Factory 画面（v33 M5・docs/16-agent-factory.md §10）。
 * 入力フォームから `POST /factory-runs` を起票し、events をポーリングしてタイムライン・計画承認カード・
 * レポートを表示する。生成資産はすべてdraftのため昇格ボタンは置かず、既存の検証／品質画面へ誘導する。
 */
export function FactoryPage({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();

  const [dataSources, setDataSources] = useState<readonly DataSourceDto[]>([]);
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [runs, setRuns] = useState<readonly FactoryRunDto[]>([]);
  const [loadError, setLoadError] = useState<string>();

  const [mode, setMode] = useState<FactoryMode>('create');
  const [baseAgentId, setBaseAgentId] = useState('');
  const [goal, setGoal] = useState('');
  const [targetUsers, setTargetUsers] = useState('');
  const [language, setLanguage] = useState<'ja' | 'en'>('ja');
  const [selectedSourceIds, setSelectedSourceIds] = useState<ReadonlySet<string>>(new Set());
  const [maxIterations, setMaxIterations] = useState(3);
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [personaCount, setPersonaCount] = useState(2);
  const [scenarioCount, setScenarioCount] = useState(4);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();

  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedRun, setSelectedRun] = useState<FactoryRunDto>();
  const [events, setEvents] = useState<readonly FactoryEventDto[]>([]);
  const [reviseFeedback, setReviseFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    // Agent一覧は強化モードでしか使わない。ここだけが落ちてもデータソース・実行履歴は表示できるよう、
    // 巻き添えにせず空配列へ倒す（強化モードを選ぶと「強化できるエージェントがありません」の案内が出る）。
    void Promise.all([client.listDataSources(scope), client.listFactoryRuns(scope), client.listAgents(scope, 'normal').catch(() => [])])
      .then(([sources, factoryRuns, normalAgents]) => {
        if (!active) return;
        setDataSources(sources); setRuns(factoryRuns); setAgents(normalAgents);
      })
      .catch((cause: unknown) => { if (active) setLoadError(message(cause)); });
    return () => { active = false; };
  }, [client]);

  // waiting-approval を含む非終端状態の間だけ events / run をポーリングする（succeeded/failed/cancelledで停止）。
  useEffect(() => {
    if (selectedRunId === undefined || (selectedRun !== undefined && isTerminal(selectedRun.status))) return;
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const [run, runEvents] = await Promise.all([client.getFactoryRun(scope, selectedRunId), client.getFactoryRunEvents(scope, selectedRunId)]);
        if (!active) return;
        setSelectedRun(run);
        setEvents(runEvents);
        setRuns((current) => current.map((item) => item.id === run.id ? run : item));
        setActionError(undefined);
      } catch (cause) { if (active) setActionError(message(cause)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [client, selectedRunId, selectedRun?.status]);

  // 実行中のrunの「生きているか」を判断できるよう、run開始からの経過時間を1秒毎に更新する。
  useEffect(() => {
    if (selectedRun === undefined || isTerminal(selectedRun.status)) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [selectedRun?.id, selectedRun?.status]);

  function toggleSource(id: string): void {
    setSelectedSourceIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  /** APIは最大5件。上限に達したら未選択のチェックボックスを止め、400で初めて気づく事態を防ぐ。 */
  const sourceLimitReached = selectedSourceIds.size >= MAX_DATA_SOURCES;

  function selectRun(run: FactoryRunDto): void {
    setSelectedRunId(run.id); setSelectedRun(run); setEvents(run.events); setReviseFeedback(''); setActionError(undefined);
  }

  const hasActiveRun = runs.some((run) => !isTerminal(run.status));
  const isEnhanceMode = mode === 'enhance';
  // 強化モードは対象Agentが必須でデータソースは任意、生成モードは従来どおりデータソースが1件以上必要。
  const canStart = goal.trim() !== '' && (isEnhanceMode ? baseAgentId !== '' : selectedSourceIds.size > 0);

  function startDisabledReason(): string | undefined {
    if (starting) return undefined;
    if (hasActiveRun) return text('A factory run is already in progress. Wait for it to finish before starting another.', '実行中のFactory runがあります。完了してから次を開始してください。');
    if (isEnhanceMode) {
      if (goal.trim() === '' && baseAgentId === '') return text('Select the agent to enhance and enter what to improve.', '強化する対象エージェントを選び、どう改善したいかを入力してください。');
      if (goal.trim() === '') return text('Enter what to improve.', 'どう改善したいかを入力してください。');
      if (baseAgentId === '') return text('Select the agent to enhance.', '強化する対象エージェントを選択してください。');
      return undefined;
    }
    if (goal.trim() === '' && selectedSourceIds.size === 0) return text('Enter a goal and select at least one data source.', 'やりたいことを入力し、データソースを1つ以上選択してください。');
    if (goal.trim() === '') return text('Enter a goal.', 'やりたいことを入力してください。');
    if (selectedSourceIds.size === 0) return text('Select at least one data source.', 'データソースを1つ以上選択してください。');
    return undefined;
  }

  async function startRun(): Promise<void> {
    if (!canStart || starting || hasActiveRun) return;
    setStarting(true); setStartError(undefined);
    try {
      const input: CreateFactoryRunDto = {
        scope,
        goal: { goal: goal.trim(), language, ...(targetUsers.trim() === '' ? {} : { targetUsers: targetUsers.trim() }) },
        // versionは指定しない（サーバーが最新版を起点にする）。
        ...(isEnhanceMode ? { baseAgent: { internalId: baseAgentId } } : {}),
        dataSourceIds: [...selectedSourceIds],
        options: { maxIterations, personaCount, scenarioCount, requirePlanApproval },
      };
      const run = await client.createFactoryRun(input);
      setRuns((current) => [run, ...current]);
      selectRun(run);
    } catch (cause) { setStartError(message(cause)); }
    finally { setStarting(false); }
  }

  async function respond(decision: 'approve' | 'reject' | 'revise'): Promise<void> {
    if (selectedRun === undefined || busy) return;
    const feedback = reviseFeedback.trim();
    if (decision === 'revise' && feedback === '') return;
    setBusy(true); setActionError(undefined);
    try {
      const run = await client.respondToFactoryRun(selectedRun.id, { scope, response: { kind: 'plan-approval', decision, ...(feedback === '' ? {} : { feedback }) } });
      setSelectedRun(run); setEvents(run.events); setReviseFeedback('');
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (cause) { setActionError(message(cause)); }
    finally { setBusy(false); }
  }

  /** 失敗Runを同じ入力で再実行する。返るのは新しいRunなので、選択を切り替えたうえで一覧を再読込する。 */
  async function retryRun(): Promise<void> {
    if (selectedRun === undefined || busy) return;
    setBusy(true); setActionError(undefined);
    try {
      const run = await client.retryFactoryRun(selectedRun.id, scope);
      selectRun(run);
      setRuns(await client.listFactoryRuns(scope));
    } catch (cause) { setActionError(message(cause)); }
    finally { setBusy(false); }
  }

  async function cancelRun(): Promise<void> {
    if (selectedRun === undefined || busy) return;
    setBusy(true); setActionError(undefined);
    try {
      const run = await client.cancelFactoryRun(selectedRun.id, scope);
      setSelectedRun(run);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (cause) { setActionError(message(cause)); }
    finally { setBusy(false); }
  }

  const disabledReason = startDisabledReason();

  return <main className="workspace-page factory-page">
    <header className="workspace-header"><div><span className="eyebrow">Factory</span><h1>{text('Agent Factory', 'Agent Factory')}</h1><p>{text(
      'Generate a draft Tool/Skill/Agent set plus persona/scenario validation assets from a goal and data sources, then let the improvement loop run automatically.',
      'やりたいこととデータソースから、ツール・スキル・エージェント一式と検証資産（ペルソナ・シナリオ）をdraftとして自動生成し、改善ループを自動で回します。',
    )}</p></div></header>
    {loadError !== undefined && <div className="api-error" role="alert">{loadError}</div>}
    <div className="two-column-workspace">
      <div className="factory-input-column">
        <section className="workspace-card" aria-label={text('New factory run', '新規Factory実行')}>
          <h2>{text('New factory run', '新規Factory実行')}</h2>
          {startError !== undefined && <div className="api-error" role="alert">{startError}</div>}
          <fieldset className="factory-mode-select">
            <legend>{text('Mode', 'モード')}</legend>
            <label>
              <input type="radio" name="factory-mode" aria-label={text('Create a new agent', '新しいエージェントを作る')}
                checked={!isEnhanceMode} onChange={() => setMode('create')} />
              {text('Create a new agent', '新しいエージェントを作る')}
            </label>
            <label>
              <input type="radio" name="factory-mode" aria-label={text('Enhance an existing agent', '既存のエージェントを強化する')}
                checked={isEnhanceMode} onChange={() => setMode('enhance')} />
              {text('Enhance an existing agent', '既存のエージェントを強化する')}
            </label>
          </fieldset>
          {isEnhanceMode && (agents.length === 0
            ? <p className="empty-state">{text('No agents to enhance. Create one first.', '強化できるエージェントがありません。先に作成してください。')}</p>
            : <label>{text('Agent to enhance', '強化する対象エージェント')}
              <select aria-label={text('Factory base agent', 'Factory強化対象エージェント')} value={baseAgentId} onChange={(event) => setBaseAgentId(event.target.value)}>
                <option value="">{text('Select an agent', 'エージェントを選択')}</option>
                {agents.map((agent) => <option key={agent.internalId} value={agent.internalId}>{agent.displayName} ({agent.latestVersion})</option>)}
              </select>
            </label>)}
          <label>{text('Goal', 'やりたいこと')}<textarea aria-label={text('Factory goal', 'Factoryのやりたいこと')} rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={isEnhanceMode
            ? text('e.g. Improve the accuracy of totals, and support filtering by period.', '例: 集計の精度を上げたい、期間指定に対応させたい')
            : text('e.g. An assistant that answers questions about monthly sales data and summarizes trends.', '例: 月次の売上データについて質問に答え、傾向を要約できるアシスタントが欲しい')} /></label>
          <p className="factory-field-hint">{isEnhanceMode
            ? text('Describe how the existing agent should improve.', 'どう改善したいかを書いてください。')
            : text('Describe what kind of agent you want to create.', 'どんなエージェントを作るかを書いてください。')}</p>
          <label>{text('Target users', '想定利用者')}<input aria-label={text('Factory target users', 'Factory想定利用者')} value={targetUsers} onChange={(event) => setTargetUsers(event.target.value)} placeholder={text('e.g. Accounting staff, cannot write SQL', '例: 経理担当者。SQLは書けない')} /></label>
          <label>{text('Language', '言語')}<select aria-label={text('Factory language', 'Factory言語')} value={language} onChange={(event) => setLanguage(event.target.value as 'ja' | 'en')}><option value="ja">{text('Japanese', '日本語')}</option><option value="en">{text('English', '英語')}</option></select></label>
          <fieldset className="factory-source-select">
            <legend>{text('Data sources', 'データソース')}</legend>
            {isEnhanceMode && <p className="factory-field-hint">{text('Optional — add data sources only if the agent needs new tools.', '任意 — 新しいツールが必要な場合だけ選んでください。')}</p>}
            {dataSources.length === 0 && <p className="empty-state">{text('No data sources yet. Register one in the Data sources screen.', 'データソースがまだありません。データソース画面で登録してください。')}</p>}
            {dataSources.map((source) => <label className="agent-tool-option" key={source.id}>
              <input type="checkbox" checked={selectedSourceIds.has(source.id)} disabled={sourceLimitReached && !selectedSourceIds.has(source.id)} onChange={() => toggleSource(source.id)} />
              <span><strong>{source.name}</strong><code>{source.id}</code></span>
              <small>{source.kind}</small>
            </label>)}
          </fieldset>
          <details>
            <summary>{text('Advanced options', '詳細オプション')}</summary>
            <label>{text('Max iterations', '最大イテレーション数')}<input aria-label={text('Factory max iterations', 'Factory最大イテレーション数')} type="number" min={1} max={10} value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))} /></label>
            <label>{text('Persona count', 'ペルソナ数')}<input aria-label={text('Factory persona count', 'Factoryペルソナ数')} type="number" min={1} max={5} value={personaCount} onChange={(event) => setPersonaCount(Number(event.target.value))} /></label>
            <label>{text('Scenario count', 'シナリオ数')}<input aria-label={text('Factory scenario count', 'Factoryシナリオ数')} type="number" min={1} max={10} value={scenarioCount} onChange={(event) => setScenarioCount(Number(event.target.value))} /></label>
            <label className="checkbox-label"><input type="checkbox" aria-label={text('Factory require plan approval', 'Factory計画承認を必須にする')} checked={requirePlanApproval} onChange={(event) => setRequirePlanApproval(event.target.checked)} /> {text('Require plan approval before generating', '生成前に計画承認を必須にする')}</label>
          </details>
          <button type="button" className="primary" disabled={!canStart || starting || hasActiveRun} onClick={() => void startRun()}>{starting ? text('Starting…', '起票中…') : text('Start factory run', '生成を開始')}</button>
          {disabledReason !== undefined && <p className="empty-state">{disabledReason}</p>}
        </section>
        <section className="workspace-card" aria-label={text('Factory run history', 'Factory実行履歴')}>
          <h2>{text('Run history', '実行履歴')}</h2>
          <div className="validation-list">
            {runs.length === 0 && <p className="empty-state">{text('No factory runs yet.', 'Factory実行はまだありません。')}</p>}
            {runs.map((run) => <button type="button" key={run.id} className={run.id === selectedRunId ? 'selected' : ''} onClick={() => selectRun(run)}>
              <strong>{runLabel(run, text, agents)}</strong><span className={`run-status ${run.status}`}>{statusLabel(run.status, text)}</span><span className="run-meta">{run.id}</span>
            </button>)}
          </div>
        </section>
      </div>

      <section className="workspace-card" aria-label={text('Factory run detail', 'Factory実行詳細')}>
        {selectedRun === undefined ? <p className="empty-state">{text('Select a run, or start a new factory run.', '実行を選択するか、新しいFactory実行を開始してください。')}</p> : <>
          {actionError !== undefined && <div className="api-error" role="alert">{actionError}</div>}
          <div className="panel-title">
            <h2>{runLabel(selectedRun, text, agents)}</h2>
            <div className="save-actions">
              <span className={`factory-mode-badge ${isEnhanceRun(selectedRun) ? 'enhance' : 'create'}`}>{isEnhanceRun(selectedRun) ? text('Enhance', '強化') : text('Create', '新規作成')}</span>
              <span className={`run-status ${selectedRun.status}`}>{statusLabel(selectedRun.status, text)}</span>
              <span className="run-meta">{text('Stage', 'ステージ')}: {stageLabel(selectedRun.stage, text)}</span>
              {!isTerminal(selectedRun.status) && <span className="run-meta">{text('Elapsed', '経過')}: {formatElapsed(nowMs - new Date(selectedRun.startedAt).getTime(), text)}</span>}
              {!isTerminal(selectedRun.status) && <button type="button" className="secondary danger" disabled={busy} onClick={() => setConfirmCancel(true)}>{text('Cancel', '取消')}</button>}
              {selectedRun.status === 'failed' && <button type="button" className="secondary" disabled={busy} onClick={() => void retryRun()}>{text('Retry run', '再実行')}</button>}
            </div>
          </div>

          {selectedRun.failure !== undefined && <div className="api-error" role="alert">{stageLabel(selectedRun.failure.stage, text)}: {selectedRun.failure.reason}</div>}

          <h3>{text('Timeline', 'タイムライン')}</h3>
          {events.length === 0 ? <p className="empty-state">{text('No events yet.', 'イベントはまだありません。')}</p> : <ol className="factory-timeline">
            {events.map((event) => <li key={event.sequence}><span className="factory-event-kind">{eventKindLabel(event.kind, text)}</span>{event.stage !== undefined && <span> · {stageLabel(event.stage, text)}</span>}{event.iteration !== undefined && <span> · it.{event.iteration}</span>}{event.message !== undefined && <span> · {event.message}</span>}</li>)}
          </ol>}

          {selectedRun.status === 'waiting-approval' && selectedRun.checkpoint !== undefined && <div className="notice-card" aria-label={text('Plan approval', '計画承認')}>
            <strong>{isEnhanceRun(selectedRun) ? text('Change plan approval required', '変更計画の承認が必要です') : text('Plan approval required', '計画の承認が必要です')}</strong>
            <p>{selectedRun.checkpoint.prompt}</p>
            {isEnhanceRun(selectedRun)
              ? <p>{text('Change plan for existing agent', '既存エージェントに対する変更計画')}: <strong>{baseAgentLabel(selectedRun, agents)}</strong></p>
              : <p>{text('Agent', 'エージェント')}: <strong>{selectedRun.checkpoint.plan.agentBrief.displayName}</strong> — {selectedRun.checkpoint.plan.agentBrief.role}</p>}
            <ul className="factory-plan-counts">
              {isEnhanceRun(selectedRun) ? <>
                <li>{text('Tools to add', '追加されるTool')}: {selectedRun.checkpoint.plan.tools.length}</li>
                <li>{text('Skills to add', '追加されるSkill')}: {selectedRun.checkpoint.plan.skills.length}</li>
                <li>{text('Validation scenarios', '検証シナリオ')}: {selectedRun.checkpoint.plan.scenarios.length}</li>
              </> : <>
                <li>{text('Tools', 'ツール')}: {selectedRun.checkpoint.plan.tools.length}</li>
                <li>{text('Skills', 'スキル')}: {selectedRun.checkpoint.plan.skills.length}</li>
                <li>{text('Personas', 'ペルソナ')}: {selectedRun.checkpoint.plan.personas.length}</li>
                <li>{text('Scenarios', 'シナリオ')}: {selectedRun.checkpoint.plan.scenarios.length}</li>
              </>}
            </ul>
            <div className="save-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void respond('approve')}>{text('Approve', '承認')}</button>
              <button type="button" className="secondary danger" disabled={busy} onClick={() => void respond('reject')}>{text('Reject', '却下')}</button>
            </div>
            <label>{text('Revise feedback', '修正フィードバック')}<textarea aria-label={text('Factory plan revise feedback', 'Factory計画修正フィードバック')} rows={2} value={reviseFeedback} onChange={(event) => setReviseFeedback(event.target.value)} /></label>
            <button type="button" className="secondary" disabled={busy || reviseFeedback.trim() === ''} onClick={() => void respond('revise')}>{text('Request revision', '修正を依頼')}</button>
          </div>}

          {selectedRun.status === 'succeeded' && selectedRun.report !== undefined && <div className="factory-report" aria-label={text('Factory report', 'Factoryレポート')}>
            <h3>{text('Report', 'レポート')}</h3>
            <p>{text('Best iteration', '最良イテレーション')}: <strong>{selectedRun.report.bestIteration}</strong></p>
            <p>{text('Candidate', '候補')}: <strong>{selectedRun.report.candidate.agentId}@{selectedRun.report.candidate.version}</strong></p>
            <p>{selectedRun.report.summary}</p>
            <div className="table-wrap"><table>
              <thead><tr><th>{text('Iteration', 'イテレーション')}</th><th>goalAchievedRate</th><th>avgSatisfaction</th><th>toolHitRate</th></tr></thead>
              <tbody>{selectedRun.report.metricsByIteration.map((metrics) => <tr key={metrics.iteration}><td>{metrics.iteration}</td><td>{Math.round(metrics.goalAchievedRate * 100)}%</td><td>{metrics.avgSatisfaction.toFixed(1)}</td><td>{Math.round(metrics.toolHitRate * 100)}%</td></tr>)}</tbody>
            </table></div>
            <h4>{text('Open findings', '未解決の指摘')}</h4>
            {selectedRun.report.openFindings.length === 0 ? <p className="empty-state">{text('No open findings.', '未解決の指摘はありません。')}</p> : <ul className="factory-findings">
              {selectedRun.report.openFindings.map((finding) => <li key={finding.id}><span className={`finding-severity ${finding.severity}`}>{finding.severity}</span> {finding.area}: {finding.detail}</li>)}
            </ul>}
            <h4>{isEnhanceRun(selectedRun) ? text('Added tools / skills (drafts)', '追加されたTool/Skill（draft）') : text('Generated assets (drafts)', '生成資産（draft）')}</h4>
            <ul className="factory-plan-counts">
              <li>{text('Tools', 'ツール')}: {selectedRun.artifacts.tools.length}</li>
              <li>{text('Skills', 'スキル')}: {selectedRun.artifacts.skills.length}</li>
              <li>{text('Agent versions', 'エージェント版')}: {selectedRun.artifacts.agentVersions.length}</li>
              <li>{text('Personas', 'ペルソナ')}: {selectedRun.artifacts.personas.length}</li>
              <li>{text('Scenarios', 'シナリオ')}: {selectedRun.artifacts.scenarios.length}</li>
            </ul>
            {/* プロンプト改善だけのRunでは Tool/Skill が0件になるのが正常系なので、欠落に見えないよう明示する。 */}
            {isEnhanceRun(selectedRun) && selectedRun.artifacts.tools.length === 0 && selectedRun.artifacts.skills.length === 0
              && <p className="empty-state">{text('No new capabilities were added; the agent context was improved.', '新しい能力の追加はなく、コンテキストの改善のみ行われました。')}</p>}
            <p className="empty-state">{text(
              'All generated assets are drafts. Open them in the Agent, Tool, Skill, or Validation screen to review or edit, and promote them through the existing Validation / Quality gate screens. There is no promotion action here.',
              'すべての生成資産はdraftです。エージェント・ツール・スキル・検証の各画面から開いて確認・編集し、既存の検証／品質ゲート画面から昇格してください。この画面に昇格操作はありません。',
            )}</p>
          </div>}
          <ConfirmDialog
            open={confirmCancel}
            title={text('Cancel this factory run?', 'このFactory runを取消しますか？')}
            message={text('The run will stop and cannot be resumed.', 'この実行は停止し、再開できません。')}
            confirmLabel={text('Cancel run', '実行を取消')}
            cancelLabel={text('Keep running', '続行する')}
            danger
            busy={busy}
            onConfirm={() => { setConfirmCancel(false); void cancelRun(); }}
            onCancel={() => setConfirmCancel(false)}
          />
        </>}
      </section>
    </div>
  </main>;
}
