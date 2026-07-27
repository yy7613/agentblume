import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, AgentSummaryDto, HarnessRunDto, HarnessSummaryDto, RunImageAttachmentDto, RunTraceEventDto, SessionArtifactDto } from '../api/types';
import { useModalBehavior } from '../hooks/useModalBehavior';
import { useI18n } from '../i18n';
import { useElapsedSeconds } from './useElapsedSeconds';
import { buildHistory } from './agent-history';
import { appendTurn, emptyThread, type TurnThread } from './turn-limit';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

type Translate = (english: string, japanese: string) => string;

type ChatTurn =
  | { readonly role: 'user'; readonly text: string; readonly images: readonly RunImageAttachmentDto[] }
  | { readonly role: 'assistant'; readonly run: AgentPreviewRunDto | HarnessRunDto }
  | { readonly role: 'error'; readonly text: string; readonly onRetry?: () => void };

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
const attachIcon = (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <path fill="currentColor" d="M16.5 6.5 9 14a2.12 2.12 0 0 0 3 3l7-7a4.24 4.24 0 1 0-6-6l-7.2 7.2a6.36 6.36 0 0 0 9 9L20 15l-1.5-1.5-5.2 5.2a4.24 4.24 0 1 1-6-6l7.2-7.2a2.12 2.12 0 1 1 3 3l-7 7a.71.71 0 0 1-1-1l7.5-7.5-1-1z" />
  </svg>
);

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES = 2;

export function ChatPage({ client }: { readonly client: ToolApiClient }) {
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [harnesses, setHarnesses] = useState<readonly HarnessSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<readonly RunImageAttachmentDto[]>([]);
  // 会話は上限付きで保持する（超過分は古い順に落とし、落とした件数を画面へ出す）。
  const [thread, setThread] = useState<TurnThread<ChatTurn>>(emptyThread);
  const turns = thread.turns;
  const pushTurn = (turn: ChatTurn) => setThread((prev) => appendTurn(prev, turn));
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [sessionId, setSessionId] = useState<string>();
  const [activeHarnessRun, setActiveHarnessRun] = useState<HarnessRunDto>();
  // 単一Agent実行がツール承認待ちで止まったRun。承認/拒否ボタンを出す対象を1件に絞る。
  const [approvalRunId, setApprovalRunId] = useState<string>();
  const [artifacts, setArtifacts] = useState<readonly SessionArtifactDto[]>([]);
  const [chart, setChart] = useState<{ readonly artifact: SessionArtifactDto; readonly payload: ChartPayload }>();
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const { text } = useI18n();
  const elapsedSeconds = useElapsedSeconds(busy);

  useEffect(() => {
    let active = true;
    setBusy(true);
    const harnessClient = client as Partial<ToolApiClient>;
    const harnessItems = typeof harnessClient.listHarnesses === 'function' ? client.listHarnesses(scope) : Promise.resolve([]);
    void Promise.all([client.listAgents(scope), harnessItems])
      .then(([all, allHarnesses]) => { if (!active) return; const items = all.filter((agent) => agent.kind !== 'pseudo-user'); setAgents(items); setHarnesses(allHarnesses); setSelectedId((current) => current || items[0]?.internalId || (allHarnesses[0] === undefined ? '' : `harness:${allHarnesses[0].internalId}`)); })
      .catch((cause: unknown) => { if (active) setLoadError(messageOf(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [client]);

  const agent = useMemo(() => agents.find((item) => item.internalId === selectedId), [agents, selectedId]);
  const harness = useMemo(() => selectedId.startsWith('harness:') ? harnesses.find((item) => item.internalId === selectedId.slice('harness:'.length)) : undefined, [harnesses, selectedId]);
  const target = agent === undefined ? (harness === undefined ? undefined : { kind: 'harness' as const, item: harness }) : { kind: 'agent' as const, item: agent };
  const agentName = target?.item.displayName ?? text('Agent', 'エージェント');

  useEffect(() => {
    if (sessionId === undefined || typeof (client as Partial<ToolApiClient>).listSessionArtifacts !== 'function') { setArtifacts([]); return; }
    let active = true;
    void client.listSessionArtifacts(sessionId, scope).then((items) => { if (active) setArtifacts(items); }).catch(() => { if (active) setArtifacts([]); });
    return () => { active = false; };
  }, [client, sessionId]);

  // 会話が伸びたら常に最新のメッセージが見えるよう最下部へスクロールする。
  useEffect(() => { const node = threadRef.current; if (node !== null) node.scrollTop = node.scrollHeight; }, [turns, busy]);
  // コンポーザーを入力量に合わせて自動で高さ調整する（Copilot風の伸縮入力欄）。
  useEffect(() => { const el = inputRef.current; if (el === null) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 168)}px`; }, [message]);

  async function send(retry?: { readonly content: string; readonly images: readonly RunImageAttachmentDto[] }): Promise<void> {
    const content = retry === undefined ? message.trim() : retry.content;
    if (target === undefined || content === '' || busy) return;
    setBusy(true);
    const attachedImages = retry === undefined ? images : retry.images;
    pushTurn({ role: 'user', text: content, images: attachedImages });
    if (retry === undefined) { setMessage(''); setImages([]); }
    try {
      let activeSessionId = target.kind === 'agent' ? sessionId : undefined;
      const sessions = client as Partial<ToolApiClient>;
      if (target.kind === 'agent' && activeSessionId === undefined && typeof sessions.createAgentSession === 'function') {
        const session = await client.createAgentSession({ scope, agent: { internalId: target.item.internalId, version: target.item.latestVersion } });
        activeSessionId = session.id;
        setSessionId(activeSessionId);
      }
      if (target.kind === 'harness' && attachedImages.length > 0) throw new Error(text('Image input is not available for Multi-Agent preview yet.', 'マルチエージェントpreviewではまだ画像入力を利用できません。'));
      const history = target.kind === 'agent' ? buildHistory(turns, content) : [];
      const run = target.kind === 'agent'
        ? await client.runSavedAgent({ scope, agent: { internalId: target.item.internalId, version: target.item.latestVersion }, message: content, mode: 'preview', sessionId: activeSessionId, ...(history.length > 0 ? { history } : {}), ...(attachedImages.length > 0 ? { images: attachedImages } : {}) })
        : activeHarnessRun?.status === 'waiting-input'
          ? await client.respondToHarnessRun(activeHarnessRun.runId, { scope, response: { kind: 'input', message: content } })
          : activeHarnessRun?.status === 'waiting-approval'
            ? await client.respondToHarnessRun(activeHarnessRun.runId, { scope, response: { kind: 'approval', decision: 'revise', feedback: content } })
            : await client.runHarness({ scope, harness: { internalId: target.item.internalId, version: target.item.latestVersion }, message: content, mode: 'preview' });
      pushTurn({ role: 'assistant', run });
      if (isHarnessRun(run)) setActiveHarnessRun(run.status === 'waiting-input' || run.status === 'waiting-approval' ? run : undefined);
      else setApprovalRunId(run.status === 'waiting-approval' ? run.runId : undefined);
      if (activeSessionId !== undefined && typeof sessions.listSessionArtifacts === 'function') void sessions.listSessionArtifacts(activeSessionId, scope).then(setArtifacts).catch(() => {});
    } catch (cause) {
      pushTurn({ role: 'error', text: messageOf(cause), onRetry: () => void send({ content, images: attachedImages }) });
    } finally {
      setBusy(false);
    }
  }

  function newChat(): void {
    const closing = sessionId;
    setThread(emptyThread()); setSessionId(undefined); setArtifacts([]); setImages([]); setActiveHarnessRun(undefined); setApprovalRunId(undefined);
    if (closing !== undefined && typeof (client as Partial<ToolApiClient>).closeAgentSession === 'function') void client.closeAgentSession(closing, scope).catch(() => {});
  }

  function selectAgent(next: string): void {
    const closing = sessionId;
    setSelectedId(next); setSessionId(undefined); setArtifacts([]); setThread(emptyThread()); setImages([]); setActiveHarnessRun(undefined); setApprovalRunId(undefined);
    if (closing !== undefined && typeof (client as Partial<ToolApiClient>).closeAgentSession === 'function') void client.closeAgentSession(closing, scope).catch(() => {});
  }

  async function openChart(artifact: SessionArtifactDto): Promise<void> {
    if (sessionId === undefined) return;
    try {
      const result = await client.getSessionArtifact(sessionId, artifact.id, scope);
      if (isChartPayload(result.payload)) setChart({ artifact, payload: result.payload });
    } catch (cause) { setLoadError(messageOf(cause)); }
  }

  async function selectImages(files: FileList | null): Promise<void> {
    if (files === null) return;
    const selected = Array.from(files);
    if (images.length + selected.length > MAX_IMAGES) {
      setLoadError(text('You can attach up to two images.', '画像は2枚まで添付できます。'));
      return;
    }
    const invalid = selected.find((file) => !isSupportedImage(file) || file.size > MAX_IMAGE_BYTES);
    if (invalid !== undefined) {
      setLoadError(text('Attach PNG, JPEG, WebP, or GIF images up to 3 MiB each.', 'PNG、JPEG、WebP、GIFを1枚3 MiBまで添付できます。'));
      return;
    }
    try {
      const next = await Promise.all(selected.map(async (file) => ({ name: file.name, dataUrl: await readAsDataUrl(file) })));
      setImages((current) => [...current, ...next]);
      setLoadError(undefined);
    } catch {
      setLoadError(text('The image could not be read.', '画像を読み込めませんでした。'));
    }
  }

  // 単一Agent実行のツール承認。応答は通常のrun応答と同じ経路で積み、再びwaiting-approvalなら承認UIを出し直す。
  async function resolveToolApproval(runId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (busy || typeof (client as Partial<ToolApiClient>).resumeRun !== 'function') return;
    setBusy(true);
    try {
      const run = await client.resumeRun(runId, scope, decision);
      pushTurn({ role: 'assistant', run });
      setApprovalRunId(run.status === 'waiting-approval' ? run.runId : undefined);
    } catch (cause) {
      pushTurn({ role: 'error', text: messageOf(cause), onRetry: () => void resolveToolApproval(runId, decision) });
    } finally {
      setBusy(false);
    }
  }

  async function respondToApproval(decision: 'approve' | 'reject'): Promise<void> {
    if (activeHarnessRun?.status !== 'waiting-approval' || busy) return;
    setBusy(true);
    pushTurn({ role: 'user', text: decision === 'approve' ? text('Approve the plan.', '計画を承認します。') : text('Reject and cancel the plan.', '計画を却下して中止します。'), images: [] });
    try {
      const run = await client.respondToHarnessRun(activeHarnessRun.runId, { scope, response: { kind: 'approval', decision } });
      pushTurn({ role: 'assistant', run });
      setActiveHarnessRun(run.status === 'waiting-input' || run.status === 'waiting-approval' ? run : undefined);
    } catch (cause) {
      pushTurn({ role: 'error', text: messageOf(cause), onRetry: () => void respondToApproval(decision) });
    } finally {
      setBusy(false);
    }
  }

  async function cancelInteractiveHarness(): Promise<void> {
    if (activeHarnessRun === undefined || busy) return;
    setBusy(true);
    try {
      const run = await client.cancelHarnessRun(activeHarnessRun.runId, scope);
      pushTurn({ role: 'assistant', run });
      setActiveHarnessRun(undefined);
    } catch (cause) {
      pushTurn({ role: 'error', text: messageOf(cause), onRetry: () => void cancelInteractiveHarness() });
    } finally {
      setBusy(false);
    }
  }

  const suggestions = [
    text('Summarize what this agent can do.', 'このエージェントができることを要約して。'),
    text('Walk through the result step by step.', '結果を順を追って説明して。'),
    text('What tools did you use and why?', 'どのツールをなぜ使ったの？'),
  ];

  return (
    <main className="cc-chat" aria-label={text('Agent playground', 'エージェント実行')}>
      <header className="cc-header">
        <div className="cc-brand">
          <span className="cc-mark" aria-hidden="true">{sparkIcon}</span>
          <div>
            <h1>{text('Agent playground', 'エージェント実行')}</h1>
            <p>{text('Preview a saved Agent version in chat.', '保存済みエージェントのバージョンを固定してチャットで実行します。')}</p>
          </div>
        </div>
        <button type="button" className="cc-new" onClick={newChat} disabled={turns.length === 0}>
          {text('New chat', '新しいチャット')}
        </button>
      </header>

      <div className="cc-thread" ref={threadRef}>
        <div className="cc-thread-inner">
          {loadError !== undefined && <div className="cc-alert" role="alert">{loadError}</div>}
          {thread.dropped > 0 && <p className="cc-trimmed">{text(`${thread.dropped} older message(s) were removed from this view.`, `古いメッセージ${thread.dropped}件は表示から削除されました。`)}</p>}
          {turns.length === 0 ? (
            <div className="cc-welcome">
              <span className="cc-mark lg" aria-hidden="true">{sparkIcon}</span>
              <h2>{text('Ask the agent anything', 'エージェントに質問しましょう')}</h2>
              <p>{welcomeHint(agents.length + harnesses.length, busy, text)}</p>
              {(agents.length + harnesses.length) > 0 && (
                <div className="cc-suggestions">
                  {suggestions.map((suggestion) => (
                    <button type="button" key={suggestion} onClick={() => setMessage(suggestion)}>{suggestion}</button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            turns.map((turn, index) => <Turn key={thread.dropped + index} turn={turn} agentName={agentName} text={text} busy={busy}
              approvalRunId={approvalRunId}
              onResolveApproval={(runId, decision) => void resolveToolApproval(runId, decision)} />)
          )}
          {busy && turns.length > 0 && (
            <div className="cc-msg assistant">
              <span className="cc-avatar assistant" aria-hidden="true">{sparkIcon}</span>
              <div className="cc-bubble">
                <span className="cc-name">{agentName}</span>
                <span className="cc-typing" aria-label={text('Running…', '実行中…')}><i /><i /><i /></span>
                <span className="cc-meta">{text(`Running… ${elapsedSeconds}s`, `実行中… ${elapsedSeconds}秒`)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <form className="cc-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        {activeHarnessRun?.status === 'waiting-approval' && <div className="cc-alert notice">
          <span>{text('The Magentic plan is waiting for approval. Enter feedback to request a revision.', 'Magenticの計画は承認待ちです。入力して送信すると修正依頼になります。')}</span>
          <button type="button" className="cc-new" disabled={busy} onClick={() => void respondToApproval('approve')}>{text('Approve plan', '計画を承認')}</button>
          <button type="button" className="cc-new" disabled={busy} onClick={() => void respondToApproval('reject')}>{text('Reject and cancel', '却下して中止')}</button>
        </div>}
        {activeHarnessRun?.status === 'waiting-input' && <div className="cc-alert notice">
          <span>{activeHarnessRun.checkpoint?.kind === 'handoff-input' ? activeHarnessRun.checkpoint.prompt : text('The Multi-Agent is waiting for your message.', 'マルチエージェントは入力待ちです。')}</span>
          <button type="button" className="cc-new" disabled={busy} onClick={() => void cancelInteractiveHarness()}>{text('Cancel run', '実行を中止')}</button>
        </div>}
        <div className="cc-input">
          {images.length > 0 && <div className="cc-image-list" aria-label={text('Attached images', '添付画像')}>
            {images.map((image) => <div className="cc-image-chip" key={`${image.name}:${image.dataUrl.length}`}>
              <img src={image.dataUrl} alt={image.name} />
              <button type="button" aria-label={text(`Remove ${image.name}`, `${image.name}を削除`)} onClick={() => setImages((current) => current.filter((item) => item !== image))}>×</button>
            </div>)}
          </div>}
          <textarea
            ref={inputRef}
            aria-label={text('Chat message', 'チャットメッセージ')}
            placeholder={activeHarnessRun?.status === 'waiting-input' ? text('Reply to continue the handoff…', 'Handoffを続ける返信を入力…') : activeHarnessRun?.status === 'waiting-approval' ? text('Describe the plan revision…', '計画の修正内容を入力…') : text('Ask the agent…', 'エージェントに質問…')}
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
          />
          <input ref={imageInputRef} className="cc-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void selectImages(event.target.files); event.currentTarget.value = ''; }} />
          <div className="cc-tools">
            <div className="cc-tools-start">
              <button type="button" className="cc-attach" aria-label={text('Attach images', '画像を添付')} title={text('Attach images', '画像を添付')} disabled={busy || images.length >= MAX_IMAGES || target?.kind === 'harness'} onClick={() => imageInputRef.current?.click()}>{attachIcon}</button>
              <select
                className="cc-agent"
                aria-label={text('Chat agent', 'チャット対象エージェント')}
                value={selectedId}
                disabled={busy || (agents.length === 0 && harnesses.length === 0)}
                onChange={(event) => selectAgent(event.target.value)}
              >
                <option value="">{text('Select an agent', 'エージェントを選択')}</option>
                {agents.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName} · {item.latestVersion}</option>)}
                {harnesses.length > 0 && <optgroup label={text('Multi-Agents', 'マルチエージェント')}>
                  {harnesses.map((item) => <option key={item.internalId} value={`harness:${item.internalId}`}>{item.displayName} · {item.latestVersion} · {item.pattern}</option>)}
                </optgroup>}
              </select>
            </div>
            <button type="submit" className="cc-send" aria-label={text('Send', '送信')} disabled={busy || target === undefined || message.trim() === ''}>
              {sendIcon}
            </button>
          </div>
        </div>
        <p className="cc-hint">{text('Enter to send · Shift+Enter for a new line · attach up to 2 images · preview mode', 'Enterで送信 · Shift+Enterで改行 · 画像は2枚まで添付 · プレビュー実行')}</p>
      </form>
      {sessionId !== undefined && <aside className="session-workspace" aria-label={text('Session workspace', 'セッションワークスペース')}>
        <strong>{text('Session workspace', 'セッションワークスペース')}</strong><small>{text(`${artifacts.length} temporary artifacts`, `一時Artifact ${artifacts.length}件`)}</small>
        {artifacts.map((artifact) => artifact.kind === 'chart'
          ? <button type="button" className="session-artifact-chart" key={artifact.id} title={artifact.id} onClick={() => void openChart(artifact)}>{artifact.name} · {artifact.kind} · {formatBytes(artifact.sizeBytes)}</button>
          : <span key={artifact.id} title={artifact.id}>{artifact.name} · {artifact.kind} · {formatBytes(artifact.sizeBytes)}</span>)}
      </aside>}
      {chart !== undefined && <ChartDialog artifact={chart.artifact} payload={chart.payload} text={text} onClose={() => setChart(undefined)} />}
    </main>
  );
}

function Turn({ turn, agentName, text, busy, approvalRunId, onResolveApproval }: {
  readonly turn: ChatTurn; readonly agentName: string; readonly text: Translate; readonly busy: boolean;
  readonly approvalRunId?: string;
  readonly onResolveApproval: (runId: string, decision: 'approve' | 'reject') => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="cc-msg user">
        <span className="cc-avatar user" aria-hidden="true">{userIcon}</span>
        <div className="cc-bubble"><span className="cc-name">{text('You', 'あなた')}</span><p>{turn.text}</p>{turn.images.length > 0 && <div className="cc-turn-images">{turn.images.map((image) => <img key={`${image.name}:${image.dataUrl.length}`} src={image.dataUrl} alt={image.name} />)}</div>}</div>
      </div>
    );
  }
  if (turn.role === 'error') {
    return (
      <div className="cc-msg error">
        <span className="cc-avatar error" aria-hidden="true">!</span>
        <div className="cc-bubble">
          <span className="cc-name">{text('Error', 'エラー')}</span>
          <p role="alert">{turn.text}</p>
          {turn.onRetry !== undefined && <button type="button" className="secondary" disabled={busy} onClick={turn.onRetry}>{text('Retry', '再試行')}</button>}
        </div>
      </div>
    );
  }
  const { run } = turn;
  if (isHarnessRun(run)) {
    const waiting = run.checkpoint?.kind === 'handoff-input'
      ? run.checkpoint.prompt
      : run.checkpoint?.kind === 'magentic-approval'
        ? `${text('Plan approval required:', '計画の承認が必要です:')} ${run.checkpoint.plan}`
        : undefined;
    return <div className="cc-msg assistant"><span className="cc-avatar assistant" aria-hidden="true">{sparkIcon}</span><div className="cc-bubble"><span className="cc-name">{agentName}</span><p>{run.response ?? run.failure?.message ?? waiting ?? ''}</p>{waiting !== undefined && run.response !== undefined && <p>{waiting}</p>}<div className="cc-steps">{run.events.filter((event) => event.kind !== 'harness_started' && event.kind !== 'harness_completed').map((event) => <span className="cc-step" key={event.sequence}><i className="cc-step-dot" />{event.kind}{event.slotId === undefined ? '' : ` · ${event.slotId}`}</span>)}</div><span className="cc-meta">multi-agent run {run.runId}</span></div></div>;
  }
  // 承認待ちで止まったRunは、応答本文がプロンプトと同文なのでバナー側だけに出す（二重表示を避ける）。
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
        {run.trace.length > 0 && (
          <div className="cc-steps">
            {run.trace.map((event) => (
              <span className={`cc-step ${stepTone(event.kind)}`} key={event.sequence}>
                <i className="cc-step-dot" />{traceLabel(event, text)}
              </span>
            ))}
          </div>
        )}
        <span className="cc-meta">run {run.runId}{usageLabel(run)}</span>
      </div>
    </div>
  );
}

function welcomeHint(agentCount: number, busy: boolean, text: Translate): string {
  if (agentCount > 0) return text('Pick an agent below and start the conversation.', '下でエージェントを選んで会話を始めてください。');
  if (busy) return text('Loading agents…', 'エージェントを読み込み中…');
  return text('Save an Agent in Agent Builder first.', '先にエージェント画面でエージェントを保存してください。');
}

function stepTone(kind: RunTraceEventDto['kind']): string {
  if (kind === 'tool-call' || kind === 'tool-result') return 'tool';
  if (kind === 'error') return 'error';
  return '';
}

function traceLabel(event: RunTraceEventDto, text: Translate): string {
  switch (event.kind) {
    case 'model-request':
      return `${text('Model request', 'モデル要求')} · step ${event.step}${event.toolNames.length > 0 ? ` · ${event.toolNames.join(', ')}` : ''}`;
    case 'tool-call':
      return `${text('Called', 'ツール呼び出し')} ${event.name}(${compactJson(event.arguments)})`;
    case 'tool-result':
      return `${text('Result', '結果')} ${event.name} · ${event.nodes.map((node) => `${node.nodeId}:${node.rowCount}`).join(', ')}`;
    case 'model-response':
      return text('Model response', 'モデル応答');
    case 'agent_call':
      return `${text('Delegated', '委譲')} ${event.toolName} → ${event.agentRef.internalId}@${event.agentRef.version}${event.ok ? '' : ` · ${text('failed', '失敗')}`}`;
    case 'compaction':
      return `${text('Compacted context', '文脈を圧縮')} · ${event.beforeChars} → ${event.afterChars}`;
    case 'approval-requested':
      return `${text('Approval requested', '承認待ち')} · ${event.tool} (${event.sideEffect})`;
    case 'approval-resolved':
      return `${text('Approval', '承認')} · ${event.decision}`;
    case 'error':
      return `${event.code}: ${event.message}`;
  }
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value) ?? '';
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

function usageLabel(run: AgentPreviewRunDto): string {
  const total = run.usage.totalTokens;
  return total === undefined ? '' : ` · ${total} tokens`;
}

function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : 'Request failed'; }

function isSupportedImage(file: File): boolean { return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type); }
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('invalid image result'));
    reader.readAsDataURL(file);
  });
}

function isHarnessRun(run: AgentPreviewRunDto | HarnessRunDto): run is HarnessRunDto { return 'harness' in run; }

function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }

type ChartPayload = { readonly specVersion: 1; readonly chartType: string; readonly title?: string; readonly mapping: Readonly<Record<string, string | number>>; readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly sourceRowCount: number; readonly sampled: boolean };
function isChartPayload(value: unknown): value is ChartPayload { return value !== null && typeof value === 'object' && (value as { chartType?: unknown }).chartType !== undefined && Array.isArray((value as { rows?: unknown }).rows); }

function ChartDialog({ artifact, payload, text, onClose }: { readonly artifact: SessionArtifactDto; readonly payload: ChartPayload; readonly text: Translate; readonly onClose: () => void }) {
  const dialogRef = useModalBehavior<HTMLElement>({ onClose });
  const valueColumn = stringMapping(payload.mapping, 'valueColumn', 'coefficientColumn', 'yColumn');
  const labelColumn = stringMapping(payload.mapping, 'timeColumn', 'xColumn', 'categoryColumn');
  const points = payload.rows.map((row, index) => ({ x: labelColumn === undefined ? String(index + 1) : String(row[labelColumn] ?? ''), y: valueColumn === undefined ? undefined : number(row[valueColumn]) })).filter((point): point is { x: string; y: number } => point.y !== undefined);
  const numericValues = valueColumn === undefined ? [] : payload.rows.map((row) => number(row[valueColumn])).filter((value): value is number => value !== undefined);
  return <div className="chart-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} tabIndex={-1} className="chart-dialog" role="dialog" aria-modal="true" aria-label={text('Chart preview', 'チャートプレビュー')}><header><div><span className="eyebrow">{payload.chartType}</span><h2>{payload.title ?? artifact.name}</h2></div><button type="button" className="ghost" aria-label={text('Close chart', 'チャートを閉じる')} onClick={onClose}>×</button></header>{payload.chartType === 'histogram' ? <HistogramSvg values={numericValues} text={text} /> : payload.chartType === 'box-plot' ? <BoxPlotSvg values={numericValues} text={text} /> : payload.chartType === 'correlation-heatmap' ? <HeatmapSvg rows={payload.rows} mapping={payload.mapping} text={text} /> : <ChartSvg points={points} type={payload.chartType} text={text} />}<p>{text(`${payload.sourceRowCount} source rows · ${payload.rows.length} rendered points`, `元データ ${payload.sourceRowCount}行 · 描画 ${payload.rows.length}ポイント`)}{payload.sampled ? text(' · sampled', ' · 間引き済み') : ''}</p><details><summary>{text('Chart mapping', 'チャート対応')}</summary><pre>{JSON.stringify(payload.mapping, null, 2)}</pre></details></section></div>;
}
function stringMapping(mapping: ChartPayload['mapping'], ...keys: readonly string[]): string | undefined { for (const key of keys) { const value = mapping[key]; if (typeof value === 'string') return value; } return undefined; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function ChartSvg({ points, type, text }: { readonly points: readonly { x: string; y: number }[]; readonly type: string; readonly text: Translate }) { if (points.length === 0) return <p className="empty-state">{text('No numeric chart points.', '数値のチャートポイントがありません。')}</p>; const width = 640; const height = 280; const min = Math.min(...points.map((point) => point.y)); const max = Math.max(...points.map((point) => point.y)); const range = max - min || 1; const x = (index: number) => 36 + index * ((width - 56) / Math.max(1, points.length - 1)); const y = (value: number) => height - 28 - ((value - min) / range) * (height - 52); const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.y)}`).join(' '); return <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${type} chart`}><line x1="36" y1="12" x2="36" y2={height - 28} /><line x1="36" y1={height - 28} x2={width - 12} y2={height - 28} />{type === 'scatter' || type === 'outlier-overlay' ? points.map((point, index) => <circle key={index} cx={x(index)} cy={y(point.y)} r="4" />) : <path d={path} fill="none" strokeWidth="3" />}</svg>; }
function HistogramSvg({ values, text }: { readonly values: readonly number[]; readonly text: Translate }) { if (values.length === 0) return <p className="empty-state">{text('No numeric chart points.', '数値のチャートポイントがありません。')}</p>; const count = Math.min(12, Math.max(1, Math.ceil(Math.sqrt(values.length)))); const min = Math.min(...values); const max = Math.max(...values); const step = (max - min || 1) / count; const bins = new Array<number>(count).fill(0); values.forEach((value) => { bins[Math.min(count - 1, Math.floor((value - min) / step))]! += 1; }); const peak = Math.max(...bins, 1); return <svg className="chart-svg" viewBox="0 0 640 280" role="img" aria-label="histogram chart">{bins.map((bin, index) => <rect key={index} x={36 + index * (570 / count)} y={252 - (bin / peak) * 220} width={Math.max(2, 570 / count - 4)} height={(bin / peak) * 220} />)}</svg>; }
function BoxPlotSvg({ values, text }: { readonly values: readonly number[]; readonly text: Translate }) { if (values.length === 0) return <p className="empty-state">{text('No numeric chart points.', '数値のチャートポイントがありません。')}</p>; const sorted = [...values].sort((a, b) => a - b); const at = (q: number) => { const p = (sorted.length - 1) * q; const a = sorted[Math.floor(p)]!; const b = sorted[Math.ceil(p)]!; return a + (b - a) * (p - Math.floor(p)); }; const min = sorted[0]!; const max = sorted[sorted.length - 1]!; const q1 = at(.25); const median = at(.5); const q3 = at(.75); const scale = (value: number) => 40 + ((value - min) / (max - min || 1)) * 560; return <svg className="chart-svg" viewBox="0 0 640 280" role="img" aria-label="box plot chart"><line x1={scale(min)} y1="140" x2={scale(max)} y2="140" /><line x1={scale(min)} y1="110" x2={scale(min)} y2="170" /><line x1={scale(max)} y1="110" x2={scale(max)} y2="170" /><rect x={scale(q1)} y="100" width={Math.max(2, scale(q3) - scale(q1))} height="80" /><line x1={scale(median)} y1="100" x2={scale(median)} y2="180" /></svg>; }
function HeatmapSvg({ rows, mapping, text }: { readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly mapping: ChartPayload['mapping']; readonly text: Translate }) { const x = stringMapping(mapping, 'xColumn'); const y = stringMapping(mapping, 'yColumn'); const coefficient = stringMapping(mapping, 'coefficientColumn'); if (x === undefined || y === undefined || coefficient === undefined) return <p className="empty-state">{text('Chart mapping is incomplete.', 'チャートの対応付けが不完全です。')}</p>; const xs = [...new Set(rows.map((row) => String(row[x] ?? '')))].filter(Boolean); const ys = [...new Set(rows.map((row) => String(row[y] ?? '')))].filter(Boolean); if (xs.length === 0 || ys.length === 0) return <p className="empty-state">{text('No correlation pairs.', '相関ペアがありません。')}</p>; const cells = new Map(rows.map((row) => [`${row[x]}\u0000${row[y]}`, number(row[coefficient]) ?? 0])); const size = Math.min(48, 520 / Math.max(xs.length, ys.length)); const color = (value: number) => value >= 0 ? `rgb(${Math.round(255 - value * 110)},${Math.round(255 - value * 40)},255)` : `rgb(255,${Math.round(255 + value * 100)},${Math.round(255 + value * 100)})`; return <svg className="chart-svg" viewBox={`0 0 ${Math.max(640, xs.length * size + 100)} ${Math.max(280, ys.length * size + 80)}`} role="img" aria-label="correlation heatmap">{ys.flatMap((yv, yi) => xs.map((xv, xi) => <rect key={`${xv}-${yv}`} x={70 + xi * size} y={24 + yi * size} width={size - 1} height={size - 1} fill={color(cells.get(`${xv}\u0000${yv}`) ?? cells.get(`${yv}\u0000${xv}`) ?? 0)} />))}</svg>; }
