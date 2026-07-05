import { useCallback, useEffect, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type {
  RunRecordDto, ScenarioRunDto, ScenarioSummaryDto, SerializedScenarioDto, SurveyQuestionDto, TenantScopeDto,
} from '../api/types';
import { useI18n } from '../i18n';

export function RunsTab({ client, scope }: { readonly client: ToolApiClient; readonly scope: TenantScopeDto }) {
  const { language, text } = useI18n();
  const [runs, setRuns] = useState<readonly ScenarioRunDto[]>([]);
  const [scenarioNames, setScenarioNames] = useState<Readonly<Record<string, string>>>({});
  const [selected, setSelected] = useState<ScenarioRunDto>();
  const [scenario, setScenario] = useState<SerializedScenarioDto>();
  const [trace, setTrace] = useState<RunRecordDto>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const [runItems, scenarioItems] = await Promise.all([client.listScenarioRuns(scope), client.listScenarios(scope)]);
      setRuns(runItems);
      setScenarioNames(Object.fromEntries(scenarioItems.map((item: ScenarioSummaryDto) => [item.internalId, item.displayName])));
    } catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  }, [client, scope]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function select(run: ScenarioRunDto): Promise<void> {
    setSelected(run); setScenario(undefined); setTrace(undefined); setError(undefined);
    // 設問文・scaleのmin/maxは実行時点のScenarioバージョンから引く（無ければ値のみで表示）。
    try { setScenario(await client.getScenario(run.scenario.id, scope, run.scenario.version)); }
    catch { setScenario(undefined); }
  }

  async function openTrace(runId: string): Promise<void> {
    setError(undefined);
    try { setTrace(await client.getRunTrace(runId, scope)); }
    catch (cause) { setError(message(cause)); }
  }

  return <>
    {error !== undefined && <div className="api-error" role="alert">{error}</div>}
    <div className="two-column-workspace">
    <section className="workspace-card" aria-label={text('Scenario run history', 'シナリオ実行履歴')}>
      <div className="panel-title"><h2>{text('Scenario runs', 'シナリオ実行')}</h2><button type="button" className="secondary" onClick={() => void refresh()}>{loading ? text('Loading…', '読み込み中…') : text('Refresh', '更新')}</button></div>
      <div className="validation-list">
        {runs.length === 0 && !loading && <p className="empty-state">{text('No scenario runs yet.', 'シナリオ実行はまだありません。')}</p>}
        {runs.map((run) => <button type="button" key={run.id} className={selected?.id === run.id ? 'selected' : ''} onClick={() => void select(run)}>
          <span className={`run-status scenario-${run.status}`}>{run.status}</span>
          <strong>{scenarioNames[run.scenario.id] ?? run.scenario.id}</strong>
          <span className="run-meta">
            {run.goalAchieved === null ? '—' : run.goalAchieved ? text('goal achieved', '目標達成') : text('goal not achieved', '目標未達')}
            {satisfaction(run) !== undefined && <> · {text('satisfaction', '満足度')} {satisfaction(run)}</>}
          </span>
          <time>{new Date(run.startedAt).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}</time>
        </button>)}
      </div>
    </section>
    <section className="workspace-card" aria-label={text('Scenario run detail', 'シナリオ実行詳細')}>
      {selected === undefined ? <p className="empty-state">{text('Select a run to view the transcript and survey.', '実行を選択するとトランスクリプトとアンケートを表示します。')}</p> : <>
        <div className="panel-title"><div><span className={`run-status scenario-${selected.status}`}>{selected.status}</span> <h2>{scenarioNames[selected.scenario.id] ?? selected.scenario.id} · {selected.scenario.version}</h2></div><code>{selected.id}</code></div>
        <h3>{text('Transcript', 'トランスクリプト')}</h3>
        {selected.transcript.length === 0 && <p className="empty-state">{text('The conversation ended before the first message.', '最初の発話前に会話が終了しました。')}</p>}
        <div className="transcript">
          {selected.transcript.map((turn, index) => {
            const runId = turn.runId;
            return <div className={`transcript-turn ${turn.speaker}`} key={index}>
              <span className="turn-speaker">{turn.speaker === 'user' ? text('Pseudo user', '疑似ユーザー') : text('Agent', 'エージェント')}</span>
              <p>{turn.message}</p>
              {runId !== undefined && <button type="button" className="secondary run-link" aria-label={`${text('Open run trace', '実行トレースを開く')} ${runId}`} onClick={() => void openTrace(runId)}>run {runId}</button>}
            </div>;
          })}
        </div>
        {trace !== undefined && <div className="trace-list"><strong>{text('Run trace', '実行トレース')} · {trace.runId}</strong>
          {trace.response !== undefined && <div className="chat-response"><span>{text('Response', '応答')}</span><p>{trace.response}</p></div>}
          {trace.trace.map((event) => <div className={`trace-event ${event.kind.startsWith('tool-') ? 'tool' : ''}`} key={event.sequence}><span>{event.sequence}</span><p>{event.kind === 'model-response' ? event.content : event.kind === 'tool-call' ? `${event.name} ${JSON.stringify(event.arguments)}` : event.kind === 'error' ? `${event.code} ${event.message}` : event.kind}</p></div>)}
        </div>}
        <h3>{text('Survey', 'アンケート')}</h3>
        {selected.survey.length === 0 ? <p className="empty-state">{text('No survey answers were recorded.', 'アンケート回答は記録されていません。')}</p> : <div className="survey-result">
          {selected.survey.map((answer) => <SurveyAnswerView key={answer.questionId} answer={answer} question={scenario?.survey.find((item) => item.id === answer.questionId)} />)}
        </div>}
        <h3>{text('Impressions', '感想')}</h3>
        {selected.impressions === '' ? <p className="empty-state">{text('No impressions were recorded.', '感想は記録されていません。')}</p> : <div className="chat-response"><span>{text('Pseudo user', '疑似ユーザー')}</span><p>{selected.impressions}</p></div>}
        <h3>{text('Metrics', 'メトリクス')}</h3>
        <div className="table-wrap"><table><tbody>
          <tr><th>{text('User turns', 'ユーザーターン数')}</th><td>{selected.metrics.userTurns}</td></tr>
          <tr><th>{text('Agent runs', 'エージェント実行数')}</th><td>{selected.metrics.agentRuns}</td></tr>
          <tr><th>{text('Tool calls', 'ツール呼び出し数')}</th><td>{selected.metrics.totalToolCalls}</td></tr>
          {selected.metrics.expectedToolHit !== undefined && <tr><th>{text('Expected tool hit rate', '期待ツール適合率')}</th><td>{Math.round(selected.metrics.expectedToolHit.hitRate * 100)}% ({selected.metrics.expectedToolHit.called.join(', ') || text('none', 'なし')} / {selected.metrics.expectedToolHit.expected.join(', ')})</td></tr>}
          <tr><th>{text('Duration', '所要時間')}</th><td>{selected.metrics.durationMs} ms</td></tr>
          <tr><th>{text('Total tokens', '合計トークン')}</th><td>{selected.metrics.usage.totalTokens ?? '—'}</td></tr>
        </tbody></table></div>
      </>}
    </section>
    </div>
  </>;
}

function SurveyAnswerView({ answer, question }: {
  readonly answer: { readonly questionId: string; readonly value: number | boolean | string };
  readonly question?: SurveyQuestionDto;
}) {
  const { language, text } = useI18n();
  const label = question === undefined ? answer.questionId : language === 'ja' ? question.textJa : question.textEn;
  if (typeof answer.value === 'number') {
    const min = question?.min ?? 1;
    const max = question?.max ?? 5;
    const ratio = max > min ? Math.min(Math.max((answer.value - min) / (max - min), 0), 1) : 1;
    return <div className="survey-scale">
      <span className="survey-question">{label}</span>
      <div className="survey-scale-track" role="img" aria-label={`${label}: ${answer.value}/${max}`}><div className="survey-scale-fill" style={{ width: `${ratio * 100}%` }} /></div>
      <strong>{answer.value}/{max}</strong>
    </div>;
  }
  if (typeof answer.value === 'boolean') {
    return <div className="survey-boolean"><span className="survey-question">{label}</span><strong className={answer.value ? 'yes' : 'no'} aria-label={answer.value ? text('yes', 'はい') : text('no', 'いいえ')}>{answer.value ? '○' : '×'}</strong></div>;
  }
  return <div className="survey-text"><span className="survey-question">{label}</span><p>{answer.value}</p></div>;
}

/** 一覧の満足度: 最初のscale（数値）回答を代表値として表示する。 */
function satisfaction(run: ScenarioRunDto): number | undefined {
  const numeric = run.survey.find((answer) => typeof answer.value === 'number');
  return numeric === undefined ? undefined : numeric.value as number;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
