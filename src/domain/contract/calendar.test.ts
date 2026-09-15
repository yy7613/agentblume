import { describe, expect, it } from 'vitest';
import { addDays, compareIsoDates, daysBetween, daysInMonth, formatIsoDate, isIsoDate, isLastDayOfMonth, isLeapYear, lastDayOfMonth, parseIsoDate, shiftMonth } from './calendar';

describe('calendar: うるう年と月の日数', () => {
  it.each([
    [2024, true], [2026, false], [2100, false], [2000, true], [1900, false],
  ])('境界: isLeapYear(%i) = %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });

  it.each([
    [2026, 2, 28], [2028, 2, 29], [2026, 1, 31], [2026, 4, 30], [2026, 6, 30], [2026, 9, 30], [2026, 11, 30], [2026, 12, 31],
  ])('正常: daysInMonth(%i, %i) = %i', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });
});

describe('calendar: isIsoDate / parseIsoDate / formatIsoDate', () => {
  it.each([
    ['2026-04-01', true], ['2028-02-29', true], ['2026-02-29', false], ['2026-13-01', false], ['2026-00-10', false],
    ['2026-04-31', false], ['2026-4-1', false], ['0000-01-01', false], [20260401, false], [undefined, false],
  ])('境界: isIsoDate(%s) = %s', (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });

  it('正常: parse と format は往復する（ゼロ埋めを保つ）', () => {
    expect(parseIsoDate('0999-03-05')).toEqual({ y: 999, m: 3, d: 5 });
    expect(formatIsoDate({ y: 999, m: 3, d: 5 })).toBe('0999-03-05');
  });

  it('例外: 暦に無い日付の parse は RangeError（呼び出し側の確認漏れに気づかせる）', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrowError(RangeError);
  });
});

describe('calendar: 日数の演算', () => {
  it.each([
    ['2026-01-01', '2026-01-01', 0], ['2026-01-01', '2026-12-31', 364], ['2028-01-01', '2028-12-31', 365],
    ['2026-12-31', '2027-01-01', 1], ['2027-01-01', '2026-12-31', -1], ['2028-02-28', '2028-03-01', 2],
  ])('正常: daysBetween(%s, %s) = %i', (from, to, expected) => {
    expect(daysBetween(from, to)).toBe(expected);
  });

  it.each([
    ['2026-01-31', 1, '2026-02-01'], ['2026-12-31', 1, '2027-01-01'], ['2028-02-28', 1, '2028-02-29'], ['2026-03-01', -1, '2026-02-28'],
    ['2027-01-01', -1, '2026-12-31'], ['2026-01-15', 0, '2026-01-15'], ['2026-01-01', 365, '2027-01-01'], ['2027-01-01', -365, '2026-01-01'],
    ['2026-03-31', -31, '2026-02-28'],
  ])('境界: addDays(%s, %i) = %s（月末・年またぎ）', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
    expect(daysBetween(date, expected)).toBe(days);
  });

  it.each([
    [2026, 12, 1, { y: 2027, m: 1 }], [2027, 1, -1, { y: 2026, m: 12 }], [2026, 4, 12, { y: 2027, m: 4 }], [2026, 3, -15, { y: 2024, m: 12 }], [2026, 5, 0, { y: 2026, m: 5 }],
  ])('境界: shiftMonth(%i, %i, %i)', (y, m, months, expected) => {
    expect(shiftMonth(y, m, months)).toEqual(expected);
  });

  it('正常: 月末の判定と月末日', () => {
    expect(lastDayOfMonth(2028, 2)).toBe('2028-02-29');
    expect(isLastDayOfMonth('2026-02-28')).toBe(true);
    expect(isLastDayOfMonth('2028-02-28')).toBe(false);
  });

  it('正常: compareIsoDates は辞書順 = 暦順', () => {
    expect(compareIsoDates('2026-01-01', '2026-01-02')).toBe(-1);
    expect(compareIsoDates('2026-01-02', '2026-01-01')).toBe(1);
    expect(compareIsoDates('2026-01-01', '2026-01-01')).toBe(0);
  });
});
