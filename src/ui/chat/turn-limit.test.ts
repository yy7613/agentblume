import { describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TURNS, appendTurn, emptyThread } from './turn-limit';

describe('turn-limit', () => {
  it('空スレッドはturn0件・drop0件から始まる', () => {
    expect(emptyThread<string>()).toEqual({ turns: [], dropped: 0 });
  });

  it('上限以内は全turnを保持し、dropは増えない', () => {
    let thread = emptyThread<string>();
    for (const turn of ['a', 'b', 'c']) thread = appendTurn(thread, turn, 3);
    expect(thread).toEqual({ turns: ['a', 'b', 'c'], dropped: 0 });
  });

  it('上限を超えると古いturnから落とし、落とした件数を数える', () => {
    let thread = emptyThread<string>();
    for (const turn of ['a', 'b', 'c', 'd', 'e']) thread = appendTurn(thread, turn, 3);
    expect(thread).toEqual({ turns: ['c', 'd', 'e'], dropped: 2 });
  });

  it('落とした件数は追記のたびに累積する', () => {
    const start = { turns: ['x', 'y'], dropped: 7 };
    expect(appendTurn(start, 'z', 2)).toEqual({ turns: ['y', 'z'], dropped: 8 });
  });

  it('上限が0以下・小数でも最低1件は残す', () => {
    expect(appendTurn(emptyThread<string>(), 'a', 0)).toEqual({ turns: ['a'], dropped: 0 });
    expect(appendTurn({ turns: ['a'], dropped: 0 }, 'b', 1.9)).toEqual({ turns: ['b'], dropped: 1 });
  });

  it('既定上限は100件', () => {
    expect(MAX_VISIBLE_TURNS).toBe(100);
    let thread = emptyThread<number>();
    for (let i = 0; i < 105; i += 1) thread = appendTurn(thread, i);
    expect(thread.turns).toHaveLength(100);
    expect(thread.dropped).toBe(5);
    expect(thread.turns[0]).toBe(5);
  });
});
