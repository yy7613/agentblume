import type { AgentHistoryMessageDto } from '../api/types';

// マルチターン会話でモデルへ渡す履歴の上限。ローカルモデルのコンテキスト長を圧迫しないよう直近優先で切り詰める。
export const MAX_HISTORY_MESSAGES = 12;
export const MAX_HISTORY_CHARS = 6000;
export const MAX_HISTORY_ENTRY_CHARS = 4000;

/** Chat/Inspect両画面のturns表現を受けるための最小構造。 */
export type HistorySourceTurn =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly run: { readonly response?: string } }
  | { readonly role: 'error' };

function clipHistoryEntry(content: string): string {
  return content.length > MAX_HISTORY_ENTRY_CHARS ? content.slice(0, MAX_HISTORY_ENTRY_CHARS) : content;
}

/** 表示済みturnsからLLMへ渡す会話履歴を組み立てる（エラーturnは除外、直近優先で件数・文字数を制限）。 */
export function buildHistory(turns: readonly HistorySourceTurn[], outgoing: string): readonly AgentHistoryMessageDto[] {
  const entries: AgentHistoryMessageDto[] = [];
  for (const turn of turns) {
    if (turn.role === 'user' && turn.text.trim() !== '') entries.push({ role: 'user', content: clipHistoryEntry(turn.text) });
    else if (turn.role === 'assistant') {
      const content = (turn.run.response ?? '').trim();
      if (content !== '') entries.push({ role: 'assistant', content: clipHistoryEntry(content) });
    }
  }
  // 再試行時は失敗した同文のuser発言が既に積まれているため、二重送信を避ける。
  const last = entries[entries.length - 1];
  if (last !== undefined && last.role === 'user' && last.content === clipHistoryEntry(outgoing)) entries.pop();
  const limited: AgentHistoryMessageDto[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0 && limited.length < MAX_HISTORY_MESSAGES; i--) {
    const entry = entries[i]!;
    if (total + entry.content.length > MAX_HISTORY_CHARS) break;
    limited.unshift(entry);
    total += entry.content.length;
  }
  return limited;
}
