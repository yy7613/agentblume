import { describe, expect, it } from 'vitest';
import { buildHistory, MAX_HISTORY_CHARS, MAX_HISTORY_ENTRY_CHARS, MAX_HISTORY_MESSAGES, type HistorySourceTurn } from './agent-history';

function exchange(index: number): readonly HistorySourceTurn[] {
  return [
    { role: 'user', text: `question ${index}` },
    { role: 'assistant', run: { response: `answer ${index}` } },
  ];
}

describe('buildHistory', () => {
  it('user/assistantのターンをrole付き履歴へ変換する', () => {
    const turns: HistorySourceTurn[] = [...exchange(1), ...exchange(2)];
    expect(buildHistory(turns, 'next')).toEqual([
      { role: 'user', content: 'question 1' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'question 2' },
      { role: 'assistant', content: 'answer 2' },
    ]);
  });

  it('エラーturn・空応答・空白のみのuser発言は除外する', () => {
    const turns: HistorySourceTurn[] = [
      { role: 'user', text: 'q1' },
      { role: 'error' },
      { role: 'assistant', run: { response: '   ' } },
      { role: 'assistant', run: {} },
      { role: 'user', text: '   ' },
      { role: 'assistant', run: { response: 'a1' } },
    ];
    expect(buildHistory(turns, 'next')).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('再試行時は末尾の同文user発言を落として二重送信を防ぐ', () => {
    const turns: HistorySourceTurn[] = [
      ...exchange(1),
      { role: 'user', text: 'retry me' },
      { role: 'error' },
    ];
    expect(buildHistory(turns, 'retry me')).toEqual([
      { role: 'user', content: 'question 1' },
      { role: 'assistant', content: 'answer 1' },
    ]);
  });

  it('末尾user発言が別内容なら落とさない', () => {
    const turns: HistorySourceTurn[] = [{ role: 'user', text: 'other' }];
    expect(buildHistory(turns, 'next')).toEqual([{ role: 'user', content: 'other' }]);
  });

  it('件数上限を超えた分は古い順に切り捨てる', () => {
    const turns: HistorySourceTurn[] = [];
    for (let i = 1; i <= 10; i++) turns.push(...exchange(i));
    const history = buildHistory(turns, 'next');
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0]).toEqual({ role: 'user', content: 'question 5' });
    expect(history[history.length - 1]).toEqual({ role: 'assistant', content: 'answer 10' });
  });

  it('文字数予算を超えると古い履歴で打ち切る', () => {
    // 個別クリップ後でも 4000 + 4000 > MAX_HISTORY_CHARS(6000) になる構成で予算打ち切りを確認する。
    const oldBig = 'x'.repeat(MAX_HISTORY_ENTRY_CHARS);
    const recentBig = 'y'.repeat(MAX_HISTORY_ENTRY_CHARS);
    const turns: HistorySourceTurn[] = [
      { role: 'user', text: oldBig },
      { role: 'assistant', run: { response: recentBig } },
      { role: 'user', text: 'recent question' },
    ];
    expect(buildHistory(turns, 'next')).toEqual([
      { role: 'assistant', content: recentBig },
      { role: 'user', content: 'recent question' },
    ]);
  });

  it('1件が長すぎる場合は個別上限で切り詰める', () => {
    const huge = 'y'.repeat(MAX_HISTORY_ENTRY_CHARS + 500);
    const history = buildHistory([{ role: 'user', text: huge }], 'next');
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toHaveLength(MAX_HISTORY_ENTRY_CHARS);
  });

  it('空のturnsでは空配列を返す', () => {
    expect(buildHistory([], 'next')).toEqual([]);
  });
});
