/**
 * 会話turnの表示上限。
 *
 * 1turnはトレースイベント一式（error turnは再送用の画像データまで）を保持するため、
 * 無制限に積むとタブのメモリと描画コストが際限なく伸びる。古い順に落として上限を保つ。
 */
export const MAX_VISIBLE_TURNS = 100;

export interface TurnThread<T> {
  readonly turns: readonly T[];
  /** 表示から落とした件数。0でなければ「古いメッセージを削除した」旨を画面へ出す。 */
  readonly dropped: number;
}

export function emptyThread<T>(): TurnThread<T> {
  return { turns: [], dropped: 0 };
}

/** turnを1件追加し、上限を超えた分を古い順に落とす。 */
export function appendTurn<T>(thread: TurnThread<T>, turn: T, limit: number = MAX_VISIBLE_TURNS): TurnThread<T> {
  const cap = Math.max(1, Math.floor(limit));
  const next = [...thread.turns, turn];
  if (next.length <= cap) return { turns: next, dropped: thread.dropped };
  const overflow = next.length - cap;
  return { turns: next.slice(overflow), dropped: thread.dropped + overflow };
}
