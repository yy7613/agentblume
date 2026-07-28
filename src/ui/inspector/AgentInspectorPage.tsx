import { useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError, type ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, AgentSummaryDto, AgentToolRefDto, EvaluationResultDto, RunTraceEventDto, SerializedAgentDto, WikiPageSummaryDto } from '../api/types';
import { useI18n } from '../i18n';
import { useElapsedSeconds } from '../chat/useElapsedSeconds';
// 実行中の段階表示はChat画面と同じ文言・同じ閾値を使う（出所を一箇所に保つ）。
import { runProgressHint } from '../chat/ChatPage';
import { buildHistory } from '../chat/agent-history';
import { appendTurn, emptyThread, type TurnThread } from '../chat/turn-limit';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

type Translate = (english: string, japanese: string) => string;

type DistillState = 'loading' | 'error' | { readonly count: number };

type Turn =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly run: AgentPreviewRunDto; readonly elapsedMs: number }
  // cancelled は「利用者が中断した」印。失敗ではないので控えめな通知として描く。
  | { readonly role: 'error'; readonly text: string; readonly elapsedMs: number; readonly onRetry?: () => void; readonly cancelled?: boolean };

const sparkIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path fill="currentColor" d="M12 2l1.7 5.1a4 4 0 0 0 2.5 2.5L21.5 11l-5.3 1.4a4 4 0 0 0-2.5 2.5L12 20l-1.7-5.1a4 4 0 0 0-2.5-2.5L2.5 11l5.3-1.4a4 4 0 0 0 2.5-2.5L12 2z" />
  </svg>
);
const userIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path fill="currentColor" d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z" />
  </svg>
);
const sendIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z" />
  </svg>
);
const stopIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <rect fill="currentColor" x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export function AgentInspectorPage({ client }: { readonly client: ToolApiClient }) {
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [definition, setDefinition] = useState<SerializedAgentDto>();
  const [message, setMessage] = useState('');
  // 会話は上限付きで保持する。評価・蒸留は「落とした件数 + 配列index」の通し番号で紐づけ、トリム後もずれない。
  const [thread, setThread] = useState<TurnThread<Turn>>(emptyThread);
  const turns = thread.turns;
  const pushTurn = (turn: Turn) => setThread((prev) => appendTurn(prev, turn));
  const [evaluations, setEvaluations] = useState<ReadonlyMap<number, EvaluationResultDto | 'loading' | 'error'>>(new Map());
  const [distillations, setDistillations] = useState<ReadonlyMap<number, DistillState>>(new Map());
  const [wikiPages, setWikiPages] = useState<readonly WikiPageSummaryDto[]>([]);
  const [attached, setAttached] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** 実行中のリクエストを中断するための controller。存在＝中断できる実行が走っている。 */
  const [aborter, setAborter] = useState<AbortController>();
  // ツール承認待ちで止まったRun。承認/拒否ボタンを出す対象を最新の1件に絞る。
  const [approvalRunId, setApprovalRunId] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { text } = useI18n();
  const elapsedSeconds = useElapsedSeconds(busy);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void client.listAgents(scope)
      .then((all) => { if (!active) return; const items = all.filter((agent) => agent.kind !== 'pseudo-user'); setAgents(items); setSelectedId((current) => current || items[0]?.internalId || ''); setLoadError(undefined); })
      .catch((cause: unknown) => { if (active) setLoadError(messageOf(cause)); });
    return () => { active = false; };
  }, [client]);

  // 選択エージェントの定義（束ねたSkill / 直付けTool / 構造化出力）を取得して能力バーに出す。
  useEffect(() => {
    if (selectedId === '') { setDefinition(undefined); return; }
    const controller = new AbortController();
    void client.getAgent(selectedId, scope, undefined, controller.signal)
      .then((def) => { if (!controller.signal.aborted) { setDefinition(def); setLoadError(undefined); } })
      .catch(() => { if (!controller.signal.aborted) setDefinition(undefined); });
    return () => controller.abort();
  }, [client, selectedId]);

  // 手動アタッチ用の Wiki ページ一覧を読み込む（記憶の読み出し・M1）。失敗は静かに空のまま。
  useEffect(() => {
    let active = true;
    void client.listWiki(scope).then((pages) => { if (active) setWikiPages(pages); }).catch(() => { if (active) setWikiPages([]); });
    return () => { active = false; };
  }, [client]);

  const agent = useMemo(() => agents.find((item) => item.internalId === selectedId), [agents, selectedId]);
  const agentName = agent?.displayName ?? text('Agent', 'エージェント');

  useEffect(() => { const node = threadRef.current; if (node !== null) node.scrollTop = node.scrollHeight; }, [turns, busy]);
  useEffect(() => { const el = inputRef.current; if (el === null) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 168)}px`; }, [message]);

  async function send(retry?: { readonly content: string }): Promise<void> {
    const content = retry === undefined ? message.trim() : retry.content;
    if (agent === undefined || content === '' || busy) return;
    const controller = new AbortController();
    setBusy(true); setAborter(controller); setLoadError(undefined);
    pushTurn({ role: 'user', text: content });
    if (retry === undefined) setMessage('');
    const startedAt = performance.now();
    try {
      const memoryPageIds = [...attached];
      const history = buildHistory(turns, content);
      const run = await client.runSavedAgent({ scope, agent: { internalId: agent.internalId, version: agent.latestVersion }, message: content, mode: 'preview', ...(history.length > 0 ? { history } : {}), ...(memoryPageIds.length > 0 ? { memoryPageIds } : {}) }, controller.signal);
      pushTurn({ role: 'assistant', run, elapsedMs: performance.now() - startedAt });
      setApprovalRunId(run.status === 'waiting-approval' ? run.runId : undefined);
    } catch (cause) {
      const elapsedMs = performance.now() - startedAt;
      if (isAbortError(cause)) {
        // 中断は失敗ではない。入力を戻して、そのまま送り直せるようにする。
        setMessage((current) => current.trim() === '' ? content : current);
        pushTurn({ role: 'error', cancelled: true, elapsedMs, text: text('Run cancelled. Your message is back in the composer.', '実行を中断しました。入力内容はそのまま残しています。') });
      } else {
        pushTurn({ role: 'error', text: messageOf(cause), elapsedMs, onRetry: () => void send({ content }) });
      }
    } finally {
      setBusy(false); setAborter(undefined);
    }
  }

  function cancelRun(): void { aborter?.abort(); }

  // ツール承認の応答。resumeRunの結果は通常のrun応答と同じturnとして積む（再びwaiting-approvalなら再表示）。
  async function resolveToolApproval(runId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (busy || typeof (client as Partial<ToolApiClient>).resumeRun !== 'function') return;
    const controller = new AbortController();
    setBusy(true); setAborter(controller); setLoadError(undefined);
    const startedAt = performance.now();
    try {
      const run = await client.resumeRun(runId, scope, decision, undefined, controller.signal);
      pushTurn({ role: 'assistant', run, elapsedMs: performance.now() - startedAt });
      setApprovalRunId(run.status === 'waiting-approval' ? run.runId : undefined);
    } catch (cause) {
      const elapsedMs = performance.now() - startedAt;
      if (isAbortError(cause)) pushTurn({ role: 'error', cancelled: true, elapsedMs, text: text('Run cancelled.', '実行を中断しました。') });
      else pushTurn({ role: 'error', text: messageOf(cause), elapsedMs, onRetry: () => void resolveToolApproval(runId, decision) });
    } finally {
      setBusy(false); setAborter(undefined);
    }
  }

  // 応答をMastra Evalsで採点する（turn単位・入力は直前のユーザー発話）。
  async function evaluate(index: number, inputText: string, outputText: string): Promise<void> {
    if (inputText.trim() === '' || outputText.trim() === '') return;
    setEvaluations((prev) => new Map(prev).set(index, 'loading'));
    try {
      const result = await client.evaluate({ scope, input: inputText, output: outputText });
      setEvaluations((prev) => new Map(prev).set(index, result));
    } catch {
      setEvaluations((prev) => new Map(prev).set(index, 'error'));
    }
  }

  // 応答から記憶提案を蒸留する（Run→振り返り→draft提案）。対象Skillがあれば instructions 改訂も対象にする。
  async function distill(index: number, inputText: string, outputText: string, runId: string): Promise<void> {
    if (inputText.trim() === '' || outputText.trim() === '') return;
    const targetSkillId = definition?.skills[0]?.internalId;
    const targetWikiId = definition?.wikis?.[0]?.wikiId;
    setDistillations((prev) => new Map(prev).set(index, 'loading'));
    try {
      const proposals = await client.reflectRun({ scope, input: inputText, output: outputText, sourceRunId: runId, ...(targetSkillId !== undefined ? { targetSkillId } : {}), ...(targetWikiId !== undefined ? { targetWikiId } : {}) });
      setDistillations((prev) => new Map(prev).set(index, { count: proposals.length }));
    } catch {
      setDistillations((prev) => new Map(prev).set(index, 'error'));
    }
  }

  const suggestions = [
    text('Which tools do you call for this request?', 'この要求ではどのツールを呼ぶ？'),
    text('Run the tool and summarize each column.', 'ツールを実行して各列を要約して。'),
    text('Return the result as structured output.', '結果を構造化出力で返して。'),
  ];

  return (
    <main className="cc-chat" aria-label={text('Agent inspector', 'エージェント動作確認')}>
      <header className="cc-header">
        <div className="cc-brand">
          <span className="cc-mark" aria-hidden="true">{sparkIcon}</span>
          <div>
            <h1>{text('Agent inspector', 'エージェント動作確認')}</h1>
            <p>{text('Run an agent and watch tools, tokens, and timing.', 'エージェントを実行し、ツール・トークン・所要時間を観測します。')}</p>
          </div>
        </div>
        <button type="button" className="cc-new" onClick={() => { setThread(emptyThread()); setEvaluations(new Map()); setDistillations(new Map()); setApprovalRunId(undefined); }} disabled={turns.length === 0}>
          {text('New chat', '新しいチャット')}
        </button>
      </header>

      {definition !== undefined && (
        <div className="ins-capbar" aria-label={text('Agent capabilities', 'エージェントの能力')}>
          <span className="ins-cap-kind">{definition.kind}</span>
          <CapGroup label={text('Skills', 'スキル')} tone="skill" items={definition.skills} text={text} />
          <CapGroup label={text('Tools', 'ツール')} tone="tool" items={definition.tools} text={text} />
          {definition.output !== undefined && <span className="ins-chip out">{text('Structured output', '構造化出力')}: {definition.output.name}</span>}
        </div>
      )}

      <div className="cc-thread" ref={threadRef}>
        <div className="cc-thread-inner">
          {loadError !== undefined && <div className="cc-alert" role="alert">{loadError}</div>}
          {thread.dropped > 0 && <p className="cc-trimmed">{text(`${thread.dropped} older message(s) were removed from this view.`, `古いメッセージ${thread.dropped}件は表示から削除されました。`)}</p>}
          {turns.length === 0 ? (
            <div className="cc-welcome">
              <span className="cc-mark lg" aria-hidden="true">{sparkIcon}</span>
              <h2>{text('Inspect an agent run', 'エージェントの動作を確認')}</h2>
              <p>{welcomeHint(agents.length, text)}</p>
              {agents.length > 0 && (
                <div className="cc-suggestions">
                  {suggestions.map((suggestion) => (
                    <button type="button" key={suggestion} onClick={() => setMessage(suggestion)}>{suggestion}</button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            turns.map((turn, index) => {
              const inputText = turn.role === 'assistant' ? lastUserBefore(turns, index) : '';
              // 表示から落とした件数を足した通し番号。トリムしても評価・蒸留の紐づけがずれない。
              const turnId = thread.dropped + index;
              return <TurnView key={turnId} turn={turn} agentName={agentName} text={text} busy={busy}
                inputText={inputText}
                approvalRunId={approvalRunId}
                onResolveApproval={(runId, decision) => void resolveToolApproval(runId, decision)}
                evaluation={evaluations.get(turnId)}
                onEvaluate={() => { if (turn.role === 'assistant') void evaluate(turnId, inputText, turn.run.response); }}
                distillation={distillations.get(turnId)}
                onDistill={() => { if (turn.role === 'assistant') void distill(turnId, inputText, turn.run.response, turn.run.runId); }} />;
            })
          )}
          {busy && turns.length > 0 && (
            <div className="cc-msg assistant">
              <span className="cc-avatar assistant" aria-hidden="true">{sparkIcon}</span>
              <div className="cc-bubble">
                <span className="cc-name">{agentName}</span>
                <span className="cc-typing" aria-label={text('Running…', '実行中…')}><i /><i /><i /></span>
                <span className="cc-meta">{text(`Running… ${elapsedSeconds}s`, `実行中… ${elapsedSeconds}秒`)}</span>
                {aborter !== undefined && <span className="cc-meta" role="status">{runProgressHint(elapsedSeconds, text)}</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      {wikiPages.length > 0 && (
        <details className="ins-attach">
          <summary>{text('Attach memory', '記憶をアタッチ')} {attached.size > 0 ? `· ${attached.size}` : ''}</summary>
          <div className="ins-attach-list">
            {wikiPages.map((page) => (
              <label key={page.id} className="ins-attach-item">
                <input type="checkbox" checked={attached.has(page.id)} onChange={(event) => {
                  setAttached((prev) => { const next = new Set(prev); if (event.target.checked) next.add(page.id); else next.delete(page.id); return next; });
                }} />
                <span>{page.title}</span>
                <small>v{page.version}</small>
              </label>
            ))}
          </div>
        </details>
      )}

      <form className="cc-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className="cc-input">
          <textarea
            ref={inputRef}
            aria-label={text('Inspect message', '動作確認メッセージ')}
            placeholder={text('Ask the agent to exercise its tools…', 'ツールを使う指示を入力…')}
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
          />
          <div className="cc-tools">
            <select
              className="cc-agent"
              aria-label={text('Inspect agent', '対象エージェント')}
              value={selectedId}
              disabled={busy || agents.length === 0}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">{text('Select an agent', 'エージェントを選択')}</option>
              {agents.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName} · {item.latestVersion}</option>)}
            </select>
            {aborter === undefined
              ? <button type="submit" className="cc-send" aria-label={text('Send', '送信')} disabled={busy || agent === undefined || message.trim() === ''}>
                {sendIcon}
              </button>
              // 実行中は送信ボタンを中断ボタンへ差し替える（送信は busy でどのみち無効なので、席を譲る）。
              : <button type="button" className="cc-send" aria-label={text('Stop run', '実行を中断')} title={text('Stop run', '実行を中断')} onClick={cancelRun}>
                {stopIcon}
              </button>}
          </div>
        </div>
        <p className="cc-hint">{text('Preview mode · read-only tools only · Enter to send', 'プレビュー実行 · 読み取り専用ツールのみ · Enterで送信')}</p>
      </form>
    </main>
  );
}

function CapGroup({ label, tone, items, text }: { readonly label: string; readonly tone: 'skill' | 'tool'; readonly items: readonly AgentToolRefDto[]; readonly text: Translate }) {
  return (
    <div className="ins-cap-group">
      <b>{label}</b>
      {items.length === 0
        ? <span className="ins-chip muted">{text('none', 'なし')}</span>
        : items.map((item) => <span className={`ins-chip ${tone}`} key={`${item.internalId}@${item.version}`}>{item.internalId}<small>@{item.version}</small></span>)}
    </div>
  );
}

function lastUserBefore(turns: readonly Turn[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role === 'user') return turn.text;
  }
  return '';
}

function TurnView({ turn, agentName, text, busy, inputText, approvalRunId, onResolveApproval, evaluation, onEvaluate, distillation, onDistill }: {
  readonly turn: Turn; readonly agentName: string; readonly text: Translate; readonly busy: boolean;
  readonly inputText: string;
  readonly approvalRunId: string | undefined;
  readonly onResolveApproval: (runId: string, decision: 'approve' | 'reject') => void;
  readonly evaluation: EvaluationResultDto | 'loading' | 'error' | undefined;
  readonly onEvaluate: () => void;
  readonly distillation: DistillState | undefined;
  readonly onDistill: () => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="cc-msg user">
        <span className="cc-avatar user" aria-hidden="true">{userIcon}</span>
        <div className="cc-bubble"><span className="cc-name">{text('You', 'あなた')}</span><p>{turn.text}</p></div>
      </div>
    );
  }
  if (turn.role === 'error') {
    // 中断はエラーではないので、赤いエラーバブルではなくシステム通知の行として出す。
    if (turn.cancelled === true) return <p className="cc-trimmed" role="status">{turn.text}</p>;
    return (
      <div className="cc-msg error">
        <span className="cc-avatar error" aria-hidden="true">!</span>
        <div className="cc-bubble">
          <span className="cc-name">{text('Error', 'エラー')}</span>
          <p role="alert">{turn.text}</p>
          <span className="cc-meta">{text('Elapsed', '所要時間')} {formatSeconds(turn.elapsedMs)}s</span>
          {turn.onRetry !== undefined && <button type="button" className="secondary" disabled={busy} onClick={turn.onRetry}>{text('Retry', '再試行')}</button>}
        </div>
      </div>
    );
  }
  const { run, elapsedMs } = turn;
  const tools = calledTools(run.trace);
  // 承認待ちのRunは応答本文がプロンプトと同文で返るため、同じ文字列はバナー側だけに出す。
  const approvalPrompt = run.status === 'waiting-approval' ? (run.checkpoint?.prompt ?? run.response) : undefined;
  const pendingApproval = approvalPrompt !== undefined && run.runId === approvalRunId;
  return (
    <div className="cc-msg assistant">
      <span className="cc-avatar assistant" aria-hidden="true">{sparkIcon}</span>
      <div className="cc-bubble">
        <span className="cc-name">{agentName}</span>
        {run.structuredResponse !== undefined
          ? <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>
          : approvalPrompt === run.response ? null : <p>{run.response}</p>}

        {pendingApproval && <div className="run-approval" role="group" aria-label={text('Tool approval', 'ツール承認')}>
          <p>{approvalPrompt}{run.checkpoint !== undefined && <small>{run.checkpoint.tool} · {run.checkpoint.sideEffect}</small>}</p>
          <div className="run-approval-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => onResolveApproval(run.runId, 'approve')}>{text('Approve', '承認')}</button>
            <button type="button" className="secondary danger" disabled={busy} onClick={() => onResolveApproval(run.runId, 'reject')}>{text('Reject', '拒否')}</button>
          </div>
        </div>}

        <div className="ins-metrics" aria-label={text('Run metrics', '実行メトリクス')}>
          <div className="ins-metric"><b>{formatSeconds(elapsedMs)}s</b><span>{text('Elapsed', '所要時間')}</span></div>
          <div className="ins-metric">
            <b>{run.usage.totalTokens ?? '—'}</b><span>{text('Total tokens', '合計トークン')}</span>
            <small>{run.usage.promptTokens ?? '—'} → {run.usage.completionTokens ?? '—'}</small>
          </div>
          <div className="ins-metric"><b>{countKind(run.trace, 'tool-call')}</b><span>{text('Tool calls', 'ツール呼び出し')}</span></div>
          <div className="ins-metric"><b>{countKind(run.trace, 'model-request')}</b><span>{text('Model rounds', 'モデル往復')}</span></div>
        </div>

        <div className="ins-section">
          <h4>{text('Tools called', '呼ばれたツール')}</h4>
          {tools.length === 0
            ? <p className="ins-none">{text('No tools were called.', 'ツールは呼ばれませんでした。')}</p>
            : (
              <div className="ins-tools">
                {tools.map((tool) => (
                  <div className="ins-tool" key={tool.name}>
                    <span className="ins-tool-name">{tool.name}</span>
                    <span className="ins-tool-count">×{tool.calls}</span>
                    <span className="ins-tool-rows">{tool.rows} {text('rows', '行')}</span>
                    {tool.args !== undefined && <code>{tool.args}</code>}
                  </div>
                ))}
              </div>
            )}
        </div>

        <details className="ins-trace">
          <summary>{text('Trace', 'トレース')} · {run.trace.length} {text('events', 'イベント')} · run {run.runId}</summary>
          <ol>
            {run.trace.map((event) => (
              <li className={`ins-trace-item ${stepTone(event.kind)}`} key={event.sequence}>
                <span className="ins-seq">{event.sequence}</span>
                <span className="ins-kind">{event.kind}</span>
                <span className="ins-detail">{traceDetail(event, text)}</span>
              </li>
            ))}
          </ol>
        </details>

        <div className="ins-section ins-eval">
          <h4>{text('Evaluation', '評価')} <small>Mastra Evals</small></h4>
          {evaluation === undefined && (
            <button type="button" className="secondary ins-eval-btn" disabled={inputText === ''} onClick={onEvaluate}>{text('Evaluate response', '応答を評価')}</button>
          )}
          {evaluation === 'loading' && <p className="ins-none">{text('Scoring…', '採点中…')}</p>}
          {evaluation === 'error' && <p className="field-error">{text('Evaluation failed.', '評価に失敗しました。')}</p>}
          {typeof evaluation === 'object' && (
            <div className="ins-eval-scores">
              <div className="ins-eval-avg">{text('Average', '平均')} {Math.round(evaluation.average * 100)}%</div>
              {evaluation.scores.map((score) => (
                <div className="ins-eval-row" key={score.metric} title={score.reason}>
                  <span className="ins-eval-metric">{score.metric}</span>
                  <span className="ins-eval-bar"><i style={{ width: `${Math.round(score.score * 100)}%` }} /></span>
                  <span className="ins-eval-val">{Math.round(score.score * 100)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ins-section ins-distill">
          <h4>{text('Memory', '記憶')} <small>{text('distillation', '蒸留')}</small></h4>
          {distillation === undefined && (
            <button type="button" className="secondary ins-eval-btn" disabled={inputText === ''} onClick={onDistill}>{text('Distill to memory', '記憶へ蒸留')}</button>
          )}
          {distillation === 'loading' && <p className="ins-none">{text('Reflecting…', '振り返り中…')}</p>}
          {distillation === 'error' && <p className="field-error">{text('Distillation failed.', '蒸留に失敗しました。')}</p>}
          {typeof distillation === 'object' && (
            <p className="ins-distill-result">{distillation.count === 0
              ? text('No memory worth proposing.', '提案する記憶はありませんでした。')
              : text(`${distillation.count} proposal(s) drafted — review in Memory.`, `${distillation.count} 件の提案を作成しました — 記憶タブで確認してください。`)}</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface CalledTool { readonly name: string; readonly calls: number; readonly rows: number; readonly args?: string }

function calledTools(trace: readonly RunTraceEventDto[]): readonly CalledTool[] {
  const order: string[] = [];
  const map = new Map<string, { calls: number; rows: number; args?: string }>();
  const ensure = (name: string) => {
    let entry = map.get(name);
    if (entry === undefined) { entry = { calls: 0, rows: 0 }; map.set(name, entry); order.push(name); }
    return entry;
  };
  for (const event of trace) {
    if (event.kind === 'tool-call') {
      const entry = ensure(event.name);
      entry.calls += 1;
      if (entry.args === undefined) entry.args = compactJson(event.arguments);
    }
    if (event.kind === 'tool-result') {
      const entry = ensure(event.name);
      entry.rows += event.nodes.reduce((total, node) => total + node.rowCount, 0);
    }
  }
  return order.map((name) => ({ name, ...map.get(name)! }));
}

function countKind(trace: readonly RunTraceEventDto[], kind: RunTraceEventDto['kind']): number {
  return trace.filter((event) => event.kind === kind).length;
}

function welcomeHint(agentCount: number, text: Translate): string {
  return agentCount > 0
    ? text('Pick an agent below, then send a request to inspect its run.', '下でエージェントを選び、指示を送って実行を観測します。')
    : text('Save an Agent in Agent Builder first.', '先にエージェント画面でエージェントを保存してください。');
}

function stepTone(kind: RunTraceEventDto['kind']): string {
  if (kind === 'tool-call' || kind === 'tool-result') return 'tool';
  if (kind === 'error') return 'error';
  return '';
}

function traceDetail(event: RunTraceEventDto, text: Translate): string {
  switch (event.kind) {
    case 'model-request':
      return `step ${event.step}${event.toolNames.length > 0 ? ` · ${text('offered', '提供')}: ${event.toolNames.join(', ')}` : ` · ${text('no tools', 'ツールなし')}`}`;
    case 'tool-call':
      return `${event.name}(${compactJson(event.arguments)})`;
    case 'tool-result':
      return `${event.name} · ${event.nodes.map((node) => `${node.nodeId}:${node.rowCount}${node.truncated ? '+' : ''}`).join(', ')}`;
    case 'model-response':
      return event.content === '' ? text('(empty)', '（空）') : event.content;
    case 'agent_call':
      return `${event.toolName} → ${event.agentRef.internalId}@${event.agentRef.version}${event.ok ? '' : ` (${text('failed', '失敗')})`} · ${event.summary}`;
    case 'compaction':
      return `${text('compacted context', '文脈を圧縮')}: ${event.beforeChars} → ${event.afterChars} ${text('chars', '文字')}`;
    case 'approval-requested':
      return `${event.tool} (${event.sideEffect}) · ${event.prompt}`;
    case 'approval-resolved':
      return event.decision;
    case 'error':
      return `${event.code}: ${event.message}`;
  }
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value) ?? '';
  return json.length > 72 ? `${json.slice(0, 69)}…` : json;
}

function formatSeconds(ms: number): string { return (ms / 1000).toFixed(2); }

function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : 'Request failed'; }
