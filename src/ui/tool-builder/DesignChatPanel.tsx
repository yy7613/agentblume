import { useEffect, useState, type KeyboardEvent } from 'react';
import { localizeDesignChatChange, localizeDiagnosticDetail } from '../api/error-messages';
import type { ToolApiClient } from '../api/tool-api';
import type { DesignChatUsageDto } from '../api/types';
import {
  currentGraph,
  designChatAgentTool,
  designChatCompactTurns,
  designChatFoldableTurns,
  designChatTranscript,
  useToolBuilderStore,
  DESIGN_CHAT_COMPACT_MIN_TURNS,
  DESIGN_CHAT_KEEP_TURNS,
  type DesignChatTurn,
} from './store';
import { NODE_CATALOG } from './node-catalog';
import { useI18n } from '../i18n';
import { ScreenLink } from '../navigation';
import { scope } from '../scope';

/**
 * ツール作成画面の設計アシスタント（v47 / ADR-0051）。
 *
 * 自由な文章で指示すると、サーバーが編集操作を当てた**編集後のグラフ**を返し、確認なしで
 * キャンバスへ適用する。確認ダイアログを出さない代わりに、各返答から 1 手で元へ戻せる
 * （戻り先は store が持つ適用前のキャンバス）。
 */

/** パネルの開閉の記憶。画面ごとの好みなので下書きではなく localStorage に置く。 */
export const DESIGN_CHAT_OPEN_KEY = 'agentblume.tool-builder.design-chat-open';

/** 変更したノードを強調する時間(ms)。目で追える長さだけ光らせ、そのあとは普通のノードへ戻す。 */
export const DESIGN_CHAT_HIGHLIGHT_MS = 4000;

/** メーターを黄にする消費比率。ここから「そろそろ畳んだ方がいい」段階（v49）。 */
export const DESIGN_CHAT_WARN_RATIO = 0.7;
/** メーターを赤にする消費比率。超えると先頭が黙って切られるので、圧縮かクリアを促す。 */
export const DESIGN_CHAT_DANGER_RATIO = 0.9;

/**
 * トークン数の表記（6812 → `6.8k` / 200192 → `200k` / 812 → `812`）。
 * 1,000 未満はそのまま出す。桁が増えるほど小数は読み取りの邪魔なので、100k 以上は整数に丸める。
 */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const thousands = value / 1000;
  return thousands < 100 ? `${Math.round(thousands * 10) / 10}k` : `${Math.round(thousands)}k`;
}

/** 開閉を切り替え、次に開いたときも同じ状態で始まるよう覚える。 */
export function setDesignChatPanelOpen(open: boolean): void {
  useToolBuilderStore.getState().setDesignChatOpen(open);
  try { localStorage.setItem(DESIGN_CHAT_OPEN_KEY, open ? 'true' : 'false'); }
  catch { /* 埋め込みブラウザ等で Storage が使えないときは、このセッションだけの開閉にする。 */ }
}

/** 覚えていた開閉を復元する（編集画面を開いたときに 1 度だけ）。読めなければ閉じたまま。 */
export function restoreDesignChatPanelOpen(): void {
  try { if (localStorage.getItem(DESIGN_CHAT_OPEN_KEY) === 'true') useToolBuilderStore.getState().setDesignChatOpen(true); }
  catch { /* 読めない環境では閉じた状態で始める。 */ }
}

export function DesignChatPanel({ client }: { readonly client: ToolApiClient }) {
  const designChat = useToolBuilderStore((state) => state.designChat);
  const [available, setAvailable] = useState(false);
  const [instruction, setInstruction] = useState('');
  const { text, language } = useI18n();

  // 可否は関数電卓の式提案と同じ判定（main スロットのモデル）。答えられない旧サーバーでは「使えない」。
  useEffect(() => {
    if (typeof client.designAssistantCapability !== 'function') return;
    let active = true;
    void client.designAssistantCapability()
      .then((enabled) => { if (active) setAvailable(enabled); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [client]);

  // 強調は時間で消す。次の応答が来れば新しい強調で置き換わるので、そのときはタイマーも張り直す。
  const highlight = designChat.highlight;
  useEffect(() => {
    if (highlight.length === 0) return;
    const timer = window.setTimeout(() => useToolBuilderStore.getState().clearDesignChatHighlight(), DESIGN_CHAT_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  async function send(): Promise<void> {
    const value = instruction.trim();
    if (!available || designChat.busy || designChat.compacting || value === '') return;
    const store = useToolBuilderStore.getState();
    // 会話は「この指示より前」を送る（いま送る指示は instruction として別に渡す）。
    const transcript = designChatTranscript(store.designChat.turns);
    // 畳んだ古い会話（v49）。直近の会話の手前に 1 ブロックとして付き、transcript とは別枠で送る。
    const transcriptSummary = store.designChat.summary;
    // いまの Tool Calling 契約（v49）。これが無いとモデルは説明文を直せない（見えていないものは直せない）。
    const agentTool = designChatAgentTool(store.metadata);
    const graph = currentGraph();
    const turnId = store.startDesignChatTurn(value);
    setInstruction('');
    try {
      const result = await client.designChat({
        scope, graph, instruction: value, transcript,
        ...(agentTool === undefined ? {} : { agentTool }),
        ...(transcriptSummary === undefined ? {} : { transcriptSummary }),
      });
      useToolBuilderStore.getState().completeDesignChatTurn(turnId, result);
    } catch (cause) {
      useToolBuilderStore.getState().failDesignChatTurn(turnId, cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'));
    }
  }

  /**
   * Enter で送信、Shift+Enter で改行（チャットの作法）。
   * 日本語入力の変換確定も Enter なので、変換中は送らない（送ると書きかけの指示が飛ぶ）。
   */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  /**
   * 古いターンをモデルに要約させる（v49）。
   *
   * 失敗しても会話は 1 文字も変えない: 畳むのは要約が手に入ってからで、
   * 要約できないまま古いターンを捨てると、決めたことが消えて戻せなくなる。
   */
  async function compact(): Promise<void> {
    const store = useToolBuilderStore.getState();
    const folding = designChatFoldableTurns(store.designChat.turns);
    if (!available || store.designChat.busy || store.designChat.compacting || folding.length === 0) return;
    const previousSummary = store.designChat.summary;
    store.startDesignChatCompact();
    try {
      const result = await client.compactDesignChat({
        scope,
        ...(previousSummary === undefined ? {} : { previousSummary }),
        turns: designChatCompactTurns(folding),
        language,
      });
      useToolBuilderStore.getState().completeDesignChatCompact(folding.length, result.summary);
    } catch (cause) {
      useToolBuilderStore.getState().failDesignChatCompact(cause instanceof Error ? cause.message : text('Request failed', 'リクエストが失敗しました'));
    }
  }

  // 送信中と要約中は同じ「待ち」。どちらでも入力・送信・圧縮・クリアを止める。
  const busy = designChat.busy || designChat.compacting;
  // 押せない理由は title に置く（ボタンを消すと「そもそも何ができるのか」が読めなくなる）。
  const compactBlocked = !available
    ? text('No model is set. Set the main model under "Model provider" in Settings', 'モデルが未設定です。設定画面の「モデルプロバイダ」でメインモデルを設定してください')
    : designChat.turns.length < DESIGN_CHAT_COMPACT_MIN_TURNS
      ? text(
          `Available once the conversation has ${DESIGN_CHAT_COMPACT_MIN_TURNS} turns or more (the last ${DESIGN_CHAT_KEEP_TURNS} are always kept)`,
          `会話が ${DESIGN_CHAT_COMPACT_MIN_TURNS} ターン以上になると押せます（直近 ${DESIGN_CHAT_KEEP_TURNS} ターンは必ず残ります）`,
        )
      : undefined;

  return <aside className="design-chat" aria-label={text('Design assistant', '設計アシスタント')}>
    <div className="design-chat-head">
      <h2>{text('Design assistant', '設計アシスタント')}</h2>
      <button type="button" className="ghost" aria-label={text('Close design assistant', '設計アシスタントを閉じる')} onClick={() => setDesignChatPanelOpen(false)}>×</button>
    </div>
    <DesignChatMeter usage={designChat.usage} />
    {/* 会話が何も無いうちは畳むものも消すものも無いので、行ごと出さない。 */}
    {(designChat.turns.length > 0 || designChat.summary !== undefined) && <div className="design-chat-tools">
      <button
        type="button"
        className="ghost"
        disabled={busy || compactBlocked !== undefined}
        title={compactBlocked}
        onClick={() => void compact()}
      >{designChat.compacting ? text('Summarizing…', '要約しています…') : text('Compact history', '履歴を圧縮')}</button>
      <button type="button" className="ghost" disabled={busy} onClick={() => useToolBuilderStore.getState().clearDesignChat()}>{text('Clear history', '履歴をクリア')}</button>
      {/* 畳んだターンは戻り先ごと消える。押す前に読める場所へ置く。 */}
      <small>{text('Undo stops working for compacted turns', '圧縮したターンの変更は取り消せなくなります')}</small>
    </div>}
    {/*
      可否は関数電卓の式提案と同じ判定（main スロット）だが、案内は設計アシスタント用の文にする（v53）。
      直す場所は設定画面の実際の見出し「モデルプロバイダ」で、ボタンからそのまま設定画面へ行ける。
    */}
    {!available && <div className="calc-ai-unavailable design-chat-unavailable" role="note">
      <small>{text(
        'The design assistant needs a model. Set the main model under "Model provider" in Settings, then reopen this panel to design the tool by chatting.',
        '設計アシスタントを使うにはモデルが必要です。設定画面の「モデルプロバイダ」でメインモデル（main スロット）を設定してから、このパネルを開き直すと、会話でツールを設計できます。',
      )}</small>
      <ScreenLink to="Settings">{text('Open Settings', '設定画面を開く')}</ScreenLink>
    </div>}
    {available && designChat.turns.length === 0 && <p className="empty-state">{text('Describe the tool you want and the canvas changes as you talk. For example: "Return the top 10 prefectures by population, yearly only."', '作りたいツールを文章で伝えると、話しながらキャンバスが変わります。例: 「都道府県別の人口を年次に絞って多い順に 10 件返して」')}</p>}
    <div className="design-chat-turns">
      {/* 畳んだターンはモデルの覚え書きとしてだけ残る。既定では閉じておき、読みたい人だけが開く。 */}
      {designChat.compacted > 0 && <details className="design-chat-compacted">
        <summary>{text(
          `Compacted (${designChat.compacted} ${designChat.compacted === 1 ? 'turn' : 'turns'})`,
          `圧縮済み（${designChat.compacted} ターン）`,
        )}</summary>
        <pre>{designChat.summary}</pre>
      </details>}
      {designChat.turns.map((turn) => <DesignChatTurnView key={turn.id} turn={turn} />)}
      {busy && <p className="design-chat-thinking" role="status">{designChat.compacting ? text('Summarizing…', '要約しています…') : text('Thinking…', '考えています…')}</p>}
    </div>
    {designChat.error !== undefined && <div className="api-error" role="alert">{designChat.error}</div>}
    <textarea
      className="design-chat-input"
      aria-label={text('Instruction', '指示')}
      rows={3}
      disabled={!available || busy}
      value={instruction}
      placeholder={text('e.g. Let the region be filtered by an argument', '例: 地域を引数で絞れるようにして')}
      onChange={(event) => setInstruction(event.target.value)}
      onKeyDown={onKeyDown}
    />
    <div className="design-chat-send">
      <small>{text('Enter sends · Shift+Enter for a new line', 'Enter で送信・Shift+Enter で改行')}</small>
      <button type="button" className="primary" disabled={!available || busy || instruction.trim() === ''} onClick={() => void send()}>{designChat.busy ? text('Thinking…', '考えています…') : text('Send', '送信')}</button>
    </div>
  </aside>;
}

/**
 * 文脈の消費（v49）。見出しの下の 1 行。
 *
 * 出すのは**直前の応答が実際に数えた値**だけで、送信前や消費を返さないプロバイダでは何も出さない
 * （推定した数字は当たらないので、無いことを無いまま見せる方が判断を誤らせない）。
 * コンテキスト長が取れたときだけ比率を出し、70% / 90% で色を変える。
 */
function DesignChatMeter({ usage }: { readonly usage?: DesignChatUsageDto }) {
  const { text } = useI18n();
  const prompt = usage?.promptTokens;
  if (prompt === undefined) return null;
  const limit = usage?.contextWindow;
  const tokens = formatTokens(prompt);
  // コンテキスト長が取れないプロバイダ（LM Studio 以外）では、分母の無い実数だけを出す。
  if (limit === undefined || limit <= 0) {
    return <p className="design-chat-meter">{text(`Context ≈ ${tokens} tokens`, `文脈 約 ${tokens} トークン`)}</p>;
  }
  const ratio = prompt / limit;
  const percent = Math.round(ratio * 100);
  const level = ratio >= DESIGN_CHAT_DANGER_RATIO ? 'danger' : ratio >= DESIGN_CHAT_WARN_RATIO ? 'warn' : 'ok';
  return <p className={level === 'ok' ? 'design-chat-meter' : `design-chat-meter ${level}`}>
    {text(`Context ${tokens} / ${formatTokens(limit)} (${percent}%)`, `文脈 ${tokens} / ${formatTokens(limit)}（${percent}%）`)}
    {/* 赤は「このままだと先頭が切られる」段階。直し方（圧縮かクリア）まで書いて、すぐ上のボタンへ導く。 */}
    {level === 'danger' && <span className="design-chat-meter-hint">{text('Compact or clear the history', '履歴を圧縮するか、クリアしてください')}</span>}
  </p>;
}

/** 変更一覧のノード種別を、パレット・設定欄と同じ日本語名にする（カタログに無い種別は原文のまま）。 */
function nodeTypeLabelJa(type: string): string | undefined {
  return NODE_CATALOG.find((item) => item.type === type)?.labelJa;
}

/** 1 往復の表示。指示 → 返答 → 変更一覧 → 適用できなかった理由 → 取り消し、の順で読める並びにする。 */
function DesignChatTurnView({ turn }: { readonly turn: DesignChatTurn }) {
  const { text, language } = useI18n();
  return <article className="design-chat-turn">
    <p className="design-chat-user">{turn.user}</p>
    {turn.assistant !== undefined && <p className="design-chat-assistant">{turn.assistant}</p>}
    {turn.changes.length > 0 && <ul className="design-chat-changes">
      {/* summary はサーバーの英語の定型文（モデルへもそのまま戻る契約）。表示のときだけ訳し、種別はパレットと同じ名前にする。 */}
      {turn.changes.map((change, index) => <li key={`${change.nodeId ?? change.op}-${index}`}>{localizeDesignChatChange(change.summary, language, nodeTypeLabelJa)}</li>)}
    </ul>}
    {/* problems は英語の原文で届く。実行エラーと同じ変換表を通し、訳が無ければ原文のまま出す。 */}
    {/* 返答の文は「追加しました」と言っていても、ここに来たターンはキャンバスを変えていない。どちらが正かを先頭で言い切る。 */}
    {turn.problems.length > 0 && <div className="design-chat-problems" role="alert">
      <strong>{text('Not applied — the canvas is unchanged. The reply above describes a change that failed these checks:', '適用していません（キャンバスは変わっていません）。上の返答の変更は、次の理由で通りませんでした:')}</strong>
      {turn.problems.map((problem, index) => <small key={index}>{localizeDiagnosticDetail(problem, language)}</small>)}
    </div>}
    {/* warnings は適用済みの注記（赤枠ではない）。粒度の混在のように、指示によっては正しい形なので止めていない。 */}
    {turn.warnings.length > 0 && <div className="design-chat-warnings" role="note">
      {turn.warnings.map((warning, index) => <small key={index}>{localizeDiagnosticDetail(warning, language)}</small>)}
    </div>}
    {turn.before !== undefined && (turn.reverted
      ? <small className="design-chat-reverted">{text('Reverted', '取り消し済み')}</small>
      : <button type="button" className="ghost design-chat-undo" onClick={() => useToolBuilderStore.getState().revertDesignChatTurn(turn.id)}>{text('Undo this change', 'この変更を取り消す')}</button>)}
  </article>;
}
