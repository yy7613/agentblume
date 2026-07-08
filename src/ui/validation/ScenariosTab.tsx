import { useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type {
  AgentSummaryDto, PersonaSummaryDto, ScenarioSummaryDto, SurveyQuestionDto, SurveyQuestionKindDto, TenantScopeDto,
} from '../api/types';
import { useI18n } from '../i18n';

// UIはHTTP境界の外なので domain の DEFAULT_SURVEY を直接importできない（依存ルール）。
// docs/11 §5 の既定8問（q8 id='impressions'）を初期値としてここに複製する。
export const DEFAULT_SURVEY_TEMPLATE: readonly SurveyQuestionDto[] = [
  { id: 'q1', textJa: '目的を達成できましたか', textEn: 'Did you achieve your goal?', kind: 'boolean' },
  { id: 'q2', textJa: '総合満足度', textEn: 'Overall satisfaction', kind: 'scale', min: 1, max: 5 },
  { id: 'q3', textJa: '回答のわかりやすさ', textEn: 'Clarity of the responses', kind: 'scale', min: 1, max: 5 },
  { id: 'q4', textJa: '手間の少なさ（少ないほど高評価）', textEn: 'Low effort required (less effort scores higher)', kind: 'scale', min: 1, max: 5 },
  { id: 'q5', textJa: '回答をどの程度信頼できましたか', textEn: 'How much did you trust the responses?', kind: 'scale', min: 1, max: 5 },
  { id: 'q6', textJa: '良かった点', textEn: 'What went well?', kind: 'text' },
  { id: 'q7', textJa: '不満・困った点', textEn: 'What was frustrating or unclear?', kind: 'text' },
  { id: 'impressions', textJa: '感想（自由記述）', textEn: 'Overall impressions (free text)', kind: 'text' },
];

export function ScenariosTab({ client, scope, onRunCompleted }: {
  readonly client: ToolApiClient;
  readonly scope: TenantScopeDto;
  readonly onRunCompleted: () => void;
}) {
  const { text } = useI18n();
  const [scenarios, setScenarios] = useState<readonly ScenarioSummaryDto[]>([]);
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [agentVersions, setAgentVersions] = useState<readonly string[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [internalId, setInternalId] = useState('sales-summary-scenario');
  const [workingName, setWorkingName] = useState('Sales summary scenario draft');
  const [displayName, setDisplayName] = useState('Sales summary scenario');
  const [publishName, setPublishName] = useState('sales_summary_scenario');
  const [owner, setOwner] = useState('local-user');
  const [agentId, setAgentId] = useState('');
  const [agentVersion, setAgentVersion] = useState('');
  const [pseudoAgentId, setPseudoAgentId] = useState('');
  const [pseudoAgentVersion, setPseudoAgentVersion] = useState('');
  const [legacyPersona, setLegacyPersona] = useState<string>();
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [maxUserTurns, setMaxUserTurns] = useState(4);
  const [expectedTools, setExpectedTools] = useState('');
  const [survey, setSurvey] = useState<readonly SurveyQuestionDto[]>(DEFAULT_SURVEY_TEMPLATE.map((question) => ({ ...question })));
  const [bump, setBump] = useState<'major' | 'minor' | 'patch'>('patch');
  const [savedVersion, setSavedVersion] = useState<string>();
  const [busy, setBusy] = useState<'save' | 'run'>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all([client.listScenarios(scope), client.listAgents(scope)])
      .then(([scenarioItems, agentItems]) => { if (active) { setScenarios(scenarioItems); setAgents(agentItems); } })
      .catch((cause: unknown) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [client, scope]);

  const targetAgents = agents.filter((agent) => agent.kind !== 'pseudo-user');
  const pseudoAgents = agents.filter((agent) => agent.kind === 'pseudo-user');

  async function selectAgent(nextAgentId: string): Promise<void> {
    setAgentId(nextAgentId); setAgentVersions([]); setAgentVersion('');
    if (nextAgentId === '') return;
    const summary = agents.find((agent) => agent.internalId === nextAgentId);
    try {
      const versions = await client.listAgentVersions(nextAgentId, scope);
      setAgentVersions(versions);
      setAgentVersion(summary?.latestVersion ?? versions[versions.length - 1] ?? '');
    } catch (cause) { setError(message(cause)); }
  }

  function selectPseudoAgent(nextAgentId: string): void {
    setPseudoAgentId(nextAgentId);
    setPseudoAgentVersion(pseudoAgents.find((agent) => agent.internalId === nextAgentId)?.latestVersion ?? '');
    setLegacyPersona(undefined);
  }

  async function edit(summary: ScenarioSummaryDto): Promise<void> {
    setError(undefined); setSavedVersion(undefined);
    try {
      const scenario = await client.getScenario(summary.internalId, scope);
      setEditingId(scenario.metadata.internalId); setSavedVersion(scenario.metadata.version);
      setInternalId(scenario.metadata.internalId); setWorkingName(scenario.metadata.workingName);
      setDisplayName(scenario.metadata.displayName); setPublishName(scenario.metadata.publishName); setOwner(scenario.metadata.owner);
      setAgentId(scenario.target.agentId); setAgentVersion(scenario.target.version);
      if (scenario.pseudoUser !== undefined) {
        setPseudoAgentId(scenario.pseudoUser.agentId); setPseudoAgentVersion(scenario.pseudoUser.version); setLegacyPersona(undefined);
      } else {
        // 旧 persona 参照は読み取り表示し、保存時は疑似ユーザーAgentの選択を要求する。
        setPseudoAgentId(''); setPseudoAgentVersion('');
        setLegacyPersona(scenario.persona !== undefined ? `${scenario.persona.personaId}@${scenario.persona.version}` : undefined);
      }
      setGoal(scenario.goal); setContext(scenario.context ?? '');
      setMaxUserTurns(scenario.maxUserTurns); setExpectedTools((scenario.expectedTools ?? []).join(', '));
      setSurvey(scenario.survey.map((question) => ({ ...question })));
      try { setAgentVersions(await client.listAgentVersions(scenario.target.agentId, scope)); }
      catch { setAgentVersions([scenario.target.version]); }
    } catch (cause) { setError(message(cause)); }
  }

  function startNew(): void {
    setEditingId(undefined); setSavedVersion(undefined);
    setInternalId(''); setWorkingName(''); setDisplayName(''); setPublishName(''); setOwner('local-user');
    setAgentId(''); setAgentVersion(''); setAgentVersions([]); setPseudoAgentId(''); setPseudoAgentVersion(''); setLegacyPersona(undefined);
    setGoal(''); setContext(''); setMaxUserTurns(4); setExpectedTools('');
    setSurvey(DEFAULT_SURVEY_TEMPLATE.map((question) => ({ ...question })));
  }

  function updateQuestion(index: number, patch: Partial<SurveyQuestionDto>): void {
    setSurvey((questions) => questions.map((question, questionIndex) => {
      if (questionIndex !== index) return question;
      const next = { ...question, ...patch };
      if (patch.kind !== undefined) {
        if (patch.kind === 'scale') return { ...next, min: 1, max: 5 };
        const { min: _min, max: _max, ...rest } = next;
        return rest;
      }
      return next;
    }));
  }

  const expectedToolList = expectedTools.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const turnsValid = Number.isInteger(maxUserTurns) && maxUserTurns >= 1 && maxUserTurns <= 8;
  const surveyValid = survey.length > 0 && survey.every((question) => question.id.trim() !== '' && question.textJa.trim() !== '' && question.textEn.trim() !== '')
    && new Set(survey.map((question) => question.id)).size === survey.length;
  const valid = internalId.trim() !== '' && workingName.trim() !== '' && displayName.trim() !== '' && publishName.trim() !== ''
    && owner.trim() !== '' && agentId !== '' && agentVersion !== '' && pseudoAgentId !== '' && pseudoAgentVersion !== ''
    && goal.trim() !== '' && turnsValid && surveyValid;

  async function save(): Promise<void> {
    setBusy('save'); setError(undefined);
    try {
      const scenario = await client.saveScenario({
        scope, internalId, workingName, displayName, publishName, owner,
        target: { agentId, version: agentVersion },
        pseudoUser: { agentId: pseudoAgentId, version: pseudoAgentVersion },
        goal,
        ...(context.trim() !== '' ? { context } : {}),
        maxUserTurns,
        ...(expectedToolList.length > 0 ? { expectedTools: expectedToolList } : {}),
        survey,
        bump,
      });
      setSavedVersion(scenario.metadata.version);
      setEditingId(scenario.metadata.internalId);
      setScenarios(await client.listScenarios(scope));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  async function run(): Promise<void> {
    if (savedVersion === undefined) return;
    setBusy('run'); setError(undefined);
    try {
      await client.runScenario(internalId, { scope, version: savedVersion, mode: 'test' });
      onRunCompleted();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(undefined); }
  }

  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <div className="two-column-workspace">
    <section className="workspace-card" aria-label={text('Scenario list', 'シナリオ一覧')}>
      <div className="panel-title"><h2>{text('Scenarios', 'シナリオ')}</h2><button type="button" className="secondary" onClick={startNew}>{text('New scenario', '新規シナリオ')}</button></div>
      <div className="validation-list">
        {scenarios.length === 0 && <p className="empty-state">{text('No saved scenarios.', '保存済みシナリオはありません。')}</p>}
        {scenarios.map((scenario) => <button type="button" key={scenario.internalId} className={scenario.internalId === editingId ? 'selected' : ''} onClick={() => void edit(scenario)}>
          <strong>{scenario.displayName}</strong><span className="version-chip">{scenario.latestVersion}</span>
        </button>)}
      </div>
    </section>
    <section className="workspace-card" aria-label={text('Scenario form', 'シナリオフォーム')}>
      <div className="panel-title"><h2>{editingId === undefined ? text('New scenario', '新規シナリオ') : text('Edit scenario', 'シナリオを編集')}</h2><div className="save-actions">
        {savedVersion !== undefined && <span className="version-chip">{text('saved', '保存済み')} {savedVersion}</span>}
        <select aria-label={text('Scenario version bump', 'シナリオのバージョン更新種別')} value={bump} onChange={(event) => setBump(event.target.value as typeof bump)}><option value="patch">patch</option><option value="minor">minor</option><option value="major">major</option></select>
        <button type="button" className="primary" disabled={busy !== undefined || !valid} onClick={() => void save()}>{busy === 'save' ? text('Saving…', '保存中…') : text('Save version', 'バージョンを保存')}</button>
        <button type="button" className="primary" disabled={busy !== undefined || savedVersion === undefined} onClick={() => void run()}>{busy === 'run' ? <span className="spinner">{text('Running…', '実行中…')}</span> : text('Run scenario', 'シナリオを実行')}</button>
      </div></div>
      <div className="agent-fields">
        <label>{text('Internal ID', '内部ID')}<input aria-label={text('Scenario internal ID', 'シナリオ内部ID')} value={internalId} onChange={(event) => setInternalId(event.target.value)} /></label>
        <label>{text('Working name', '作業名')}<input aria-label={text('Scenario working name', 'シナリオ作業名')} value={workingName} onChange={(event) => setWorkingName(event.target.value)} /></label>
        <label>{text('Display name', '表示名')}<input aria-label={text('Scenario display name', 'シナリオ表示名')} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>{text('Publish name', '公開名')}<input aria-label={text('Scenario publish name', 'シナリオ公開名')} value={publishName} onChange={(event) => setPublishName(event.target.value)} /></label>
        <label>{text('Owner', '所有者')}<input aria-label={text('Scenario owner', 'シナリオ所有者')} value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
        <label>{text('Target agent', '対象エージェント')}<select aria-label={text('Scenario target agent', 'シナリオ対象エージェント')} value={agentId} onChange={(event) => void selectAgent(event.target.value)}><option value="">{text('Select an agent', 'エージェントを選択')}</option>{targetAgents.map((agent) => <option key={agent.internalId} value={agent.internalId}>{agent.displayName} · {agent.latestVersion}</option>)}</select></label>
        <label>{text('Agent version', 'エージェントバージョン')}<select aria-label={text('Scenario agent version', 'シナリオ対象エージェントバージョン')} value={agentVersion} disabled={agentVersions.length === 0} onChange={(event) => setAgentVersion(event.target.value)}>{agentVersions.length === 0 && <option value="">{text('Select an agent first', '先にエージェントを選択')}</option>}{agentVersions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>{text('Pseudo-user agent', '疑似ユーザーAgent')}<select aria-label={text('Scenario pseudo-user agent', 'シナリオ疑似ユーザーAgent')} value={pseudoAgentId} onChange={(event) => selectPseudoAgent(event.target.value)}><option value="">{text('Select a pseudo-user agent', '疑似ユーザーAgentを選択')}</option>{pseudoAgents.map((agent) => <option key={agent.internalId} value={agent.internalId}>{agent.displayName} · {agent.latestVersion}</option>)}</select></label>
        <label>{text('Max user turns (1-8)', '上限ユーザーターン (1-8)')}<input aria-label={text('Scenario max user turns', 'シナリオ上限ユーザーターン')} type="number" min={1} max={8} value={maxUserTurns} onChange={(event) => setMaxUserTurns(Number(event.target.value))} /></label>
        <label>{text('Expected tools (comma separated)', '期待するツール（カンマ区切り）')}<input aria-label={text('Scenario expected tools', 'シナリオ期待ツール')} placeholder={text('Optional publish names', '公開名・任意')} value={expectedTools} onChange={(event) => setExpectedTools(event.target.value)} /></label>
      </div>
      {pseudoAgents.length === 0 && <p className="empty-state">{text('No pseudo-user agents yet — register a persona as a pseudo-user agent in the Personas tab.', '疑似ユーザーAgentがありません。Personasタブでペルソナを疑似ユーザーAgentとして登録してください。')}</p>}
      {legacyPersona !== undefined && <p className="field-error">{text('Legacy persona reference', '旧ペルソナ参照')} ({legacyPersona}) — {text('select a pseudo-user agent to save.', '保存には疑似ユーザーAgentを選択してください。')}</p>}
      <label>{text('Goal', '目標')}<textarea aria-label={text('Scenario goal', 'シナリオ目標')} rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
      <label>{text('Context', '状況設定')}<textarea aria-label={text('Scenario context', 'シナリオ状況設定')} rows={2} placeholder={text('Optional', '任意')} value={context} onChange={(event) => setContext(event.target.value)} /></label>
      {!turnsValid && <p className="field-error">{text('Max user turns must be an integer between 1 and 8.', '上限ユーザーターンは1〜8の整数で指定してください。')}</p>}
      <h2>{text('Survey questions', 'アンケート設問')} <small>{survey.length} {text('questions', '問')}</small></h2>
      <div className="survey-editor">
        {survey.map((question, index) => <div className="survey-editor-row" key={index}>
          <input aria-label={`${text('Question', '設問')} ${index + 1} ID`} value={question.id} onChange={(event) => updateQuestion(index, { id: event.target.value })} />
          <input aria-label={`${text('Question', '設問')} ${index + 1} ${text('text (Japanese)', '設問文（日本語）')}`} value={question.textJa} onChange={(event) => updateQuestion(index, { textJa: event.target.value })} />
          <input aria-label={`${text('Question', '設問')} ${index + 1} ${text('text (English)', '設問文（英語）')}`} value={question.textEn} onChange={(event) => updateQuestion(index, { textEn: event.target.value })} />
          <select aria-label={`${text('Question', '設問')} ${index + 1} ${text('kind', '型')}`} value={question.kind} onChange={(event) => updateQuestion(index, { kind: event.target.value as SurveyQuestionKindDto })}><option value="scale">scale</option><option value="boolean">boolean</option><option value="text">text</option></select>
          {question.kind === 'scale'
            ? <><input aria-label={`${text('Question', '設問')} ${index + 1} min`} type="number" value={question.min ?? 1} onChange={(event) => updateQuestion(index, { min: Number(event.target.value) })} />
              <input aria-label={`${text('Question', '設問')} ${index + 1} max`} type="number" value={question.max ?? 5} onChange={(event) => updateQuestion(index, { max: Number(event.target.value) })} /></>
            : <><span /><span /></>}
          <button aria-label={`${text('Remove question', '設問を削除')} ${index + 1}`} type="button" className="secondary" disabled={survey.length === 1} onClick={() => setSurvey((questions) => questions.filter((_, questionIndex) => questionIndex !== index))}>×</button>
        </div>)}
        <button type="button" className="secondary" onClick={() => setSurvey((questions) => [...questions, { id: `q${questions.length + 1}`, textJa: '', textEn: '', kind: 'scale', min: 1, max: 5 }])}>{text('Add question', '設問を追加')}</button>
        {!surveyValid && <p className="field-error">{text('Question ids must be non-empty and unique, and both texts are required.', '設問IDは空・重複不可で、日英の設問文が必要です。')}</p>}
      </div>
      <p className="empty-state">{text('Save a version first, then run the scenario. The run appears in the Runs tab when it finishes.', '先にバージョンを保存してからシナリオを実行してください。完了するとRunsタブに結果が表示されます。')}</p>
    </section>
    </div>
  </>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
