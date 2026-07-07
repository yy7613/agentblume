import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, AgentSummaryDto, RunTraceEventDto } from '../api/types';
import { useI18n } from '../i18n';

const scope = { tenantId: 'local', workspaceId: 'default' } as const;

type Translate = (english: string, japanese: string) => string;

type ChatTurn =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly run: AgentPreviewRunDto }
  | { readonly role: 'error'; readonly text: string };

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

export function ChatPage({ client }: { readonly client: ToolApiClient }) {
  const [agents, setAgents] = useState<readonly AgentSummaryDto[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('Use the available capabilities and explain the result.');
  const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { text } = useI18n();

  useEffect(() => {
    let active = true;
    setBusy(true);
    void client.listAgents(scope)
      .then((items) => { if (!active) return; setAgents(items); setSelectedId((current) => current || items[0]?.internalId || ''); })
      .catch((cause: unknown) => { if (active) setLoadError(messageOf(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [client]);

  const agent = useMemo(() => agents.find((item) => item.internalId === selectedId), [agents, selectedId]);
  const agentName = agent?.displayName ?? text('Agent', 'エージェント');

  // 会話が伸びたら常に最新のメッセージが見えるよう最下部へスクロールする。
  useEffect(() => { const node = threadRef.current; if (node !== null) node.scrollTop = node.scrollHeight; }, [turns, busy]);
  // コンポーザーを入力量に合わせて自動で高さ調整する（Copilot風の伸縮入力欄）。
  useEffect(() => { const el = inputRef.current; if (el === null) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 168)}px`; }, [message]);

  async function send(): Promise<void> {
    const content = message.trim();
    if (agent === undefined || content === '' || busy) return;
    setBusy(true);
    setTurns((prev) => [...prev, { role: 'user', text: content }]);
    setMessage('');
    try {
      const run = await client.runSavedAgent({ scope, agent: { internalId: agent.internalId, version: agent.latestVersion }, message: content, mode: 'preview' });
      setTurns((prev) => [...prev, { role: 'assistant', run }]);
    } catch (cause) {
      setTurns((prev) => [...prev, { role: 'error', text: messageOf(cause) }]);
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
        <button type="button" className="cc-new" onClick={() => setTurns([])} disabled={turns.length === 0}>
          {text('New chat', '新しいチャット')}
        </button>
      </header>

      <div className="cc-thread" ref={threadRef}>
        <div className="cc-thread-inner">
          {loadError !== undefined && <div className="cc-alert" role="alert">{loadError}</div>}
          {turns.length === 0 ? (
            <div className="cc-welcome">
              <span className="cc-mark lg" aria-hidden="true">{sparkIcon}</span>
              <h2>{text('Ask the agent anything', 'エージェントに質問しましょう')}</h2>
              <p>{welcomeHint(agents.length, busy, text)}</p>
              {agents.length > 0 && (
                <div className="cc-suggestions">
                  {suggestions.map((suggestion) => (
                    <button type="button" key={suggestion} onClick={() => setMessage(suggestion)}>{suggestion}</button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            turns.map((turn, index) => <Turn key={index} turn={turn} agentName={agentName} text={text} />)
          )}
          {busy && turns.length > 0 && (
            <div className="cc-msg assistant">
              <span className="cc-avatar assistant" aria-hidden="true">{sparkIcon}</span>
              <div className="cc-bubble">
                <span className="cc-name">{agentName}</span>
                <span className="cc-typing" aria-label={text('Running…', '実行中…')}><i /><i /><i /></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <form className="cc-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className="cc-input">
          <textarea
            ref={inputRef}
            aria-label={text('Chat message', 'チャットメッセージ')}
            placeholder={text('Ask the agent…', 'エージェントに質問…')}
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
          />
          <div className="cc-tools">
            <select
              className="cc-agent"
              aria-label={text('Chat agent', 'チャット対象エージェント')}
              value={selectedId}
              disabled={busy || agents.length === 0}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">{text('Select an agent', 'エージェントを選択')}</option>
              {agents.map((item) => <option key={item.internalId} value={item.internalId}>{item.displayName} · {item.latestVersion}</option>)}
            </select>
            <button type="submit" className="cc-send" aria-label={text('Send', '送信')} disabled={busy || agent === undefined || message.trim() === ''}>
              {sendIcon}
            </button>
          </div>
        </div>
        <p className="cc-hint">{text('Enter to send · Shift+Enter for a new line · preview mode', 'Enterで送信 · Shift+Enterで改行 · プレビュー実行')}</p>
      </form>
    </main>
  );
}

function Turn({ turn, agentName, text }: { readonly turn: ChatTurn; readonly agentName: string; readonly text: Translate }) {
  if (turn.role === 'user') {
    return (
      <div className="cc-msg user">
        <span className="cc-avatar user" aria-hidden="true">{userIcon}</span>
        <div className="cc-bubble"><span className="cc-name">{text('You', 'あなた')}</span><p>{turn.text}</p></div>
      </div>
    );
  }
  if (turn.role === 'error') {
    return (
      <div className="cc-msg error">
        <span className="cc-avatar error" aria-hidden="true">!</span>
        <div className="cc-bubble"><span className="cc-name">{text('Error', 'エラー')}</span><p role="alert">{turn.text}</p></div>
      </div>
    );
  }
  const { run } = turn;
  return (
    <div className="cc-msg assistant">
      <span className="cc-avatar assistant" aria-hidden="true">{sparkIcon}</span>
      <div className="cc-bubble">
        <span className="cc-name">{agentName}</span>
        {run.structuredResponse === undefined ? <p>{run.response}</p> : <pre>{JSON.stringify(run.structuredResponse, null, 2)}</pre>}
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
