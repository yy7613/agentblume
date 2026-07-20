import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { CreateFactoryRunDto, DataSourceDto, FactoryEventDto, FactoryRunDto } from '../api/types';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;
const TERMINAL_STATUSES: ReadonlySet<FactoryRunDto['status']> = new Set(['succeeded', 'failed', 'cancelled']);

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
function isTerminal(status: FactoryRunDto['status']): boolean { return TERMINAL_STATUSES.has(status); }
function runLabel(run: FactoryRunDto): string {
  const name = run.plan?.agentBrief.displayName;
  if (name !== undefined && name.trim() !== '') return name;
  const goal = run.input.goal.goal;
  return goal.length > 48 ? `${goal.slice(0, 48)}…` : goal;
}

/**
 * Agent Factory 画面（v33 M5・docs/16-agent-factory.md §10）。
 * 入力フォームから `POST /factory-runs` を起票し、events をポーリングしてタイムライン・計画承認カード・
 * レポートを表示する。生成資産はすべてdraftのため昇格ボタンは置かず、既存の検証／品質画面へ誘導する。
 */
export function FactoryPage({ client }: { readonly client: ToolApiClient }) {
  const { text } = useI18n();

  const [dataSources, setDataSources] = useState<readonly DataSourceDto[]>([]);
  const [runs, setRuns] = useState<readonly FactoryRunDto[]>([]);
  const [loadError, setLoadError] = useState<string>();

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

  useEffect(() => {
    let active = true;
    void Promise.all([client.listDataSources(scope), client.listFactoryRuns(scope)])
      .then(([sources, factoryRuns]) => { if (!active) return; setDataSources(sources); setRuns(factoryRuns); })
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
      } catch (cause) { if (active) setActionError(message(cause)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [client, selectedRunId, selectedRun?.status]);

  function toggleSource(id: string): void {
    setSelectedSourceIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function selectRun(run: FactoryRunDto): void {
    setSelectedRunId(run.id); setSelectedRun(run); setEvents(run.events); setReviseFeedback(''); setActionError(undefined);
  }

  async function startRun(): Promise<void> {
    if (!canStart || starting) return;
    setStarting(true); setStartError(undefined);
    try {
      const input: CreateFactoryRunDto = {
        scope,
        goal: { goal: goal.trim(), language, ...(targetUsers.trim() === '' ? {} : { targetUsers: targetUsers.trim() }) },
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

  const canStart = goal.trim() !== '' && selectedSourceIds.size > 0;

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
          <label>{text('Goal', 'やりたいこと')}<textarea aria-label={text('Factory goal', 'Factoryのやりたいこと')} rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={text('e.g. An assistant that answers questions about monthly sales data and summarizes trends.', '例: 月次の売上データについて質問に答え、傾向を要約できるアシスタントが欲しい')} /></label>
          <label>{text('Target users', '想定利用者')}<input aria-label={text('Factory target users', 'Factory想定利用者')} value={targetUsers} onChange={(event) => setTargetUsers(event.target.value)} placeholder={text('e.g. Accounting staff, cannot write SQL', '例: 経理担当者。SQLは書けない')} /></label>
          <label>{text('Language', '言語')}<select aria-label={text('Factory language', 'Factory言語')} value={language} onChange={(event) => setLanguage(event.target.value as 'ja' | 'en')}><option value="ja">{text('Japanese', '日本語')}</option><option value="en">{text('English', '英語')}</option></select></label>
          <fieldset className="factory-source-select">
            <legend>{text('Data sources', 'データソース')}</legend>
            {dataSources.length === 0 && <p className="empty-state">{text('No data sources yet. Register one in the Data sources screen.', 'データソースがまだありません。データソース画面で登録してください。')}</p>}
            {dataSources.map((source) => <label className="agent-tool-option" key={source.id}>
              <input type="checkbox" checked={selectedSourceIds.has(source.id)} onChange={() => toggleSource(source.id)} />
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
          <button type="button" className="primary" disabled={!canStart || starting} onClick={() => void startRun()}>{starting ? text('Starting…', '起票中…') : text('Start factory run', '生成を開始')}</button>
        </section>
        <section className="workspace-card" aria-label={text('Factory run history', 'Factory実行履歴')}>
          <h2>{text('Run history', '実行履歴')}</h2>
          <div className="validation-list">
            {runs.length === 0 && <p className="empty-state">{text('No factory runs yet.', 'Factory実行はまだありません。')}</p>}
            {runs.map((run) => <button type="button" key={run.id} className={run.id === selectedRunId ? 'selected' : ''} onClick={() => selectRun(run)}>
              <strong>{runLabel(run)}</strong><span className={`run-status ${run.status}`}>{run.status}</span><span className="run-meta">{run.id}</span>
            </button>)}
          </div>
        </section>
      </div>

      <section className="workspace-card" aria-label={text('Factory run detail', 'Factory実行詳細')}>
        {selectedRun === undefined ? <p className="empty-state">{text('Select a run, or start a new factory run.', '実行を選択するか、新しいFactory実行を開始してください。')}</p> : <>
          {actionError !== undefined && <div className="api-error" role="alert">{actionError}</div>}
          <div className="panel-title">
            <h2>{runLabel(selectedRun)}</h2>
            <div className="save-actions">
              <span className={`run-status ${selectedRun.status}`}>{selectedRun.status}</span>
              <span className="run-meta">{text('Stage', 'ステージ')}: {selectedRun.stage}</span>
              {!isTerminal(selectedRun.status) && <button type="button" className="secondary danger" disabled={busy} onClick={() => void cancelRun()}>{text('Cancel', '取消')}</button>}
            </div>
          </div>

          {selectedRun.failure !== undefined && <div className="api-error" role="alert">{selectedRun.failure.stage}: {selectedRun.failure.reason}</div>}

          <h3>{text('Timeline', 'タイムライン')}</h3>
          {events.length === 0 ? <p className="empty-state">{text('No events yet.', 'イベントはまだありません。')}</p> : <ol className="factory-timeline">
            {events.map((event) => <li key={event.sequence}><span className="factory-event-kind">{event.kind}</span>{event.stage !== undefined && <span> · {event.stage}</span>}{event.iteration !== undefined && <span> · it.{event.iteration}</span>}{event.message !== undefined && <span> · {event.message}</span>}</li>)}
          </ol>}

          {selectedRun.status === 'waiting-approval' && selectedRun.checkpoint !== undefined && <div className="notice-card" aria-label={text('Plan approval', '計画承認')}>
            <strong>{text('Plan approval required', '計画の承認が必要です')}</strong>
            <p>{selectedRun.checkpoint.prompt}</p>
            <p>{text('Agent', 'エージェント')}: <strong>{selectedRun.checkpoint.plan.agentBrief.displayName}</strong> — {selectedRun.checkpoint.plan.agentBrief.role}</p>
            <ul className="factory-plan-counts">
              <li>{text('Tools', 'ツール')}: {selectedRun.checkpoint.plan.tools.length}</li>
              <li>{text('Skills', 'スキル')}: {selectedRun.checkpoint.plan.skills.length}</li>
              <li>{text('Personas', 'ペルソナ')}: {selectedRun.checkpoint.plan.personas.length}</li>
              <li>{text('Scenarios', 'シナリオ')}: {selectedRun.checkpoint.plan.scenarios.length}</li>
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
            <h4>{text('Generated assets (drafts)', '生成資産（draft）')}</h4>
            <ul className="factory-plan-counts">
              <li>{text('Tools', 'ツール')}: {selectedRun.artifacts.tools.length}</li>
              <li>{text('Skills', 'スキル')}: {selectedRun.artifacts.skills.length}</li>
              <li>{text('Agent versions', 'エージェント版')}: {selectedRun.artifacts.agentVersions.length}</li>
              <li>{text('Personas', 'ペルソナ')}: {selectedRun.artifacts.personas.length}</li>
              <li>{text('Scenarios', 'シナリオ')}: {selectedRun.artifacts.scenarios.length}</li>
            </ul>
            <p className="empty-state">{text(
              'All generated assets are drafts. Open them in the Agent, Tool, Skill, or Validation screen to review or edit, and promote them through the existing Validation / Quality gate screens. There is no promotion action here.',
              'すべての生成資産はdraftです。エージェント・ツール・スキル・検証の各画面から開いて確認・編集し、既存の検証／品質ゲート画面から昇格してください。この画面に昇格操作はありません。',
            )}</p>
          </div>}
        </>}
      </section>
    </div>
  </main>;
}
