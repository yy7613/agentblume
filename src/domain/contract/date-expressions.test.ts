import { describe, expect, it } from 'vitest';
import { parseJapaneseNumber, scanDates, scanDurations } from './date-expressions';

describe('date-expressions: parseJapaneseNumber', () => {
  it.each([
    ['3', 3], ['３', 3], ['三', 3], ['十', 10], ['十二', 12], ['二十', 20], ['三十一', 31], ['百二十', 120], ['千', 1000], ['二〇二六', 2026], ['〇', 0], [' 12 ', 12],
  ])('正常: %s → %i', (text, expected) => {
    expect(parseJapaneseNumber(text)).toBe(expected);
  });

  it.each(['', 'abc', '三a', '1.5'])('異常: %s は読めない', (text) => {
    expect(parseJapaneseNumber(text)).toBeUndefined();
  });
});

describe('date-expressions: scanDates', () => {
  it.each([
    ['令和8年4月1日', '2026-04-01'],
    ['令和元年5月1日', '2019-05-01'],
    ['平成31年4月30日', '2019-04-30'],
    ['昭和64年1月7日', '1989-01-07'],
    ['R8年4月1日', '2026-04-01'],
    ['H31年4月30日', '2019-04-30'],
    ['令和八年十二月三十一日', '2026-12-31'],
    ['二〇二六年四月一日', '2026-04-01'],
    ['２０２６年４月１日', '2026-04-01'],
    ['2026年 4月 1日', '2026-04-01'],
    ['2026/4/1', '2026-04-01'],
    ['2026-04-01', '2026-04-01'],
    ['2026.4.1', '2026-04-01'],
  ])('正常: 「%s」→ %s（和暦は換算）', (text, iso) => {
    expect(scanDates(`本契約は${text}から効力を有する。`).map((entry) => entry.iso)).toEqual([iso]);
  });

  it('正常: 複数の日付を出現順に、原文の表記つきで返す', () => {
    expect(scanDates('2026年4月1日から2027年3月31日まで')).toEqual([
      { iso: '2026-04-01', raw: '2026年4月1日' },
      { iso: '2027-03-31', raw: '2027年3月31日' },
    ]);
  });

  it.each(['2026年2月30日', '令和8年13月1日', '2026/02/29'])('異常: 暦に無い日付「%s」は落とす', (text) => {
    expect(scanDates(text)).toEqual([]);
  });

  it('境界: 日付の無い本文は空', () => {
    expect(scanDates('期間満了の3か月前までに通知する')).toEqual([]);
  });
});

describe('date-expressions: scanDurations', () => {
  it.each([
    ['三箇月', { amount: 3, unit: 'month', months: 3 }],
    ['3ヶ月', { amount: 3, unit: 'month', months: 3 }],
    ['３か月', { amount: 3, unit: 'month', months: 3 }],
    ['6カ月', { amount: 6, unit: 'month', months: 6 }],
    ['6ヵ月', { amount: 6, unit: 'month', months: 6 }],
    ['2ケ月', { amount: 2, unit: 'month', months: 2 }],
    ['6月間', { amount: 6, unit: 'month', months: 6 }],
    ['９０日', { amount: 90, unit: 'day', days: 90 }],
    ['30日間', { amount: 30, unit: 'day', days: 30 }],
    ['1年間', { amount: 1, unit: 'year', months: 12 }],
    ['二年', { amount: 2, unit: 'year', months: 24 }],
    ['2週間', { amount: 2, unit: 'week', days: 14 }],
  ])('正常: 「%s」を正規化する', (text, expected) => {
    expect(scanDurations(`期間満了の${text}前までに`)).toEqual([expect.objectContaining(expected)]);
  });

  it('境界: 日付の「年」「日」を期間と取り違えない', () => {
    const durations = scanDurations('令和8年4月1日から1年間とし、2027年3月31日の3か月前までに通知する。');
    expect(durations.map((entry) => entry.raw)).toEqual(['1年間', '3か月']);
    expect(scanDates('令和8年4月1日から1年間とし').map((entry) => entry.iso)).toEqual(['2026-04-01']);
  });

  it('境界: 期間の無い本文は空', () => {
    expect(scanDurations('本契約は締結日から効力を有する。')).toEqual([]);
  });
});
