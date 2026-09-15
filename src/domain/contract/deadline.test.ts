import { describe, expect, it } from 'vitest';
import { buildTermSchedule, computeTermEndDate, deadlineDisplayState, MAX_TERMS, monthsBetweenTerm, noticeDeadlineByDays, noticeDeadlineByMonths } from './deadline';

describe('deadline: R1 満了日（computeTermEndDate）', () => {
  it.each([
    // docs/23 §5.2 の例
    ['2026-04-01', 12, '2027-03-31'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-02-29', 12, '2029-02-28'],
    ['2027-03-01', 12, '2028-02-29'],
    // §5.4 の境界: 月末始期・年またぎ・N = 1 / 13
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-05-31', 1, '2026-06-30'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-12-01', 1, '2026-12-31'],
    ['2026-11-15', 2, '2027-01-14'],
    ['2026-04-01', 13, '2027-04-30'],
    ['2026-04-01', 1, '2026-04-30'],
  ])('正常/境界: %s から %i か月 → %s', (start, months, expected) => {
    expect(computeTermEndDate(start, months)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN])('異常: months = %s は日付を作らない（読み違いの徴候）', (months) => {
    expect(computeTermEndDate('2026-04-01', months)).toBeUndefined();
  });
});

describe('deadline: R5 「満了の N か月前まで」（noticeDeadlineByMonths）', () => {
  it.each([
    // docs/23 §5.2 の例（月末は月末へ写す）
    ['2027-03-31', 3, '2026-12-31'],
    ['2026-05-31', 3, '2026-02-28'],
    ['2027-02-28', 1, '2027-01-31'],
    ['2026-06-30', 3, '2026-03-31'],
    // 月末でない満了日は同日。同日が無ければその月の末日
    ['2027-03-15', 3, '2026-12-15'],
    ['2026-05-30', 3, '2026-02-28'],
    ['2027-01-15', 1, '2026-12-15'],
    ['2028-05-29', 3, '2028-02-29'],
  ])('正常/境界: 満了日 %s の %i か月前 → %s', (end, months, expected) => {
    expect(noticeDeadlineByMonths(end, months)).toBe(expected);
  });

  it('境界: N = 0 は満了日そのもの', () => {
    expect(noticeDeadlineByMonths('2027-03-15', 0)).toBe('2027-03-15');
  });
});

describe('deadline: R6 「満了の N 日前まで」（noticeDeadlineByDays）', () => {
  it.each([
    ['2027-03-31', 30, '2027-03-01'],
    ['2027-01-10', 15, '2026-12-26'],
    ['2028-03-01', 1, '2028-02-29'],
    ['2027-03-31', 0, '2027-03-31'],
  ])('正常/境界: 満了日 %s の %i 日前 → %s（暦日・年またぎ・うるう年）', (end, days, expected) => {
    expect(noticeDeadlineByDays(end, days)).toBe(expected);
  });
});

describe('deadline: monthsBetweenTerm（満了日から月数の逆算）', () => {
  it.each([
    ['2026-04-01', '2027-03-31', 12],
    ['2026-01-31', '2026-02-28', 1],
    ['2027-03-01', '2028-02-29', 12],
    ['2026-04-01', '2026-04-30', 1],
  ])('正常: %s〜%s は %i か月', (start, end, expected) => {
    expect(monthsBetweenTerm(start, end)).toBe(expected);
  });

  it.each([
    ['2026-04-01', '2027-03-30'],
    ['2026-04-01', '2026-04-15'],
    ['2027-04-01', '2026-03-31'],
  ])('異常: %s〜%s は R1 で一致する整数月が無いので undefined', (start, end) => {
    expect(monthsBetweenTerm(start, end)).toBeUndefined();
  });
});

describe('deadline: buildTermSchedule（R1〜R4・R8）', () => {
  it('異常: 満了日も「始期 + 期間」も無ければ undefined', () => {
    expect(buildTermSchedule({ renews: false }, '2026-09-15')).toBeUndefined();
    expect(buildTermSchedule({ startDate: '2026-04-01', renews: false }, '2026-09-15')).toBeUndefined();
    expect(buildTermSchedule({ durationMonths: 12, renews: false }, '2026-09-15')).toBeUndefined();
    expect(buildTermSchedule({ startDate: '2026-04-01', durationMonths: 0, renews: false }, '2026-09-15')).toBeUndefined();
  });

  it('正常: R2 明記の満了日は計算値より優先する', () => {
    const schedule = buildTermSchedule({ startDate: '2026-04-01', endDate: '2027-03-15', durationMonths: 12, renews: false }, '2026-09-15');
    expect(schedule).toEqual({ current: { index: 1, start: '2026-04-01', end: '2027-03-15' }, past: [], truncated: false });
  });

  it('正常: 自動更新なしは満了日を過ぎても 1 期目のまま', () => {
    const schedule = buildTermSchedule({ startDate: '2024-04-01', durationMonths: 12, renews: false }, '2026-09-15');
    expect(schedule?.current).toEqual({ index: 1, start: '2024-04-01', end: '2025-03-31' });
    expect(schedule?.past).toEqual([]);
  });

  it('境界: 自動更新ありでも更新期間が無ければ進めない', () => {
    const schedule = buildTermSchedule({ startDate: '2024-04-01', durationMonths: 12, renews: true }, '2026-09-15');
    expect(schedule?.current.index).toBe(1);
  });

  it('正常: R4 満了日の翌日を次期の始期にし、今日を含む期を現在期にする', () => {
    const schedule = buildTermSchedule({ startDate: '2025-04-01', durationMonths: 12, renews: true, renewalMonths: 12 }, '2026-09-15');
    expect(schedule).toEqual({
      current: { index: 2, start: '2026-04-01', end: '2027-03-31' },
      past: [{ index: 1, start: '2025-04-01', end: '2026-03-31' }],
      truncated: false,
    });
  });

  it.each([
    ['2026-03-31', 1],
    ['2026-04-01', 2],
  ])('境界: R8 今日 %s は termEnd >= 今日 の最初の期（%i 期目）', (today, index) => {
    expect(buildTermSchedule({ startDate: '2025-04-01', durationMonths: 12, renews: true, renewalMonths: 12 }, today)?.current.index).toBe(index);
  });

  it('境界: 年またぎの更新（12 月満了 → 1 月始期）と、始期不明（満了日だけ）の初回', () => {
    const schedule = buildTermSchedule({ endDate: '2026-12-31', renews: true, renewalMonths: 6 }, '2027-01-01');
    expect(schedule?.past).toEqual([{ index: 1, end: '2026-12-31' }]);
    expect(schedule?.current).toEqual({ index: 2, start: '2027-01-01', end: '2027-06-30' });
  });

  it('境界: 100 期目がちょうど今日を含むなら打ち切りにしない', () => {
    // 2000-01 から 1 か月ごと: 100 期目は 2008-04 の 1 か月。
    const schedule = buildTermSchedule({ startDate: '2000-01-01', durationMonths: 1, renews: true, renewalMonths: 1 }, '2008-04-30');
    expect(schedule?.current).toEqual({ index: 100, start: '2008-04-01', end: '2008-04-30' });
    expect(schedule?.truncated).toBe(false);
  });

  it('例外: 100 期数えても今日に届かなければ打ち切る（無限に進めない）', () => {
    const schedule = buildTermSchedule({ startDate: '2000-01-01', durationMonths: 1, renews: true, renewalMonths: 1 }, '2008-05-01');
    expect(schedule?.truncated).toBe(true);
    expect(schedule?.current.index).toBe(MAX_TERMS);
    expect(schedule?.past).toHaveLength(MAX_TERMS - 1);
  });
});

describe('deadline: R10 表示状態（deadlineDisplayState）', () => {
  it.each([
    ['2026-09-15', 60, 'due-soon'],
    ['2026-09-14', 60, 'overdue'],
    ['2026-11-14', 60, 'due-soon'],
    ['2026-11-15', 60, 'upcoming'],
    ['2026-09-16', 0, 'upcoming'],
    ['2026-09-15', 0, 'due-soon'],
  ])('境界: 今日 2026-09-15・期限 %s・dueSoonDays %i → %s（当日は due-soon、翌日から overdue）', (dueDate, dueSoonDays, expected) => {
    expect(deadlineDisplayState(dueDate, '2026-09-15', dueSoonDays)).toBe(expected);
  });

  it('境界: 期限の翌日に見ると overdue', () => {
    expect(deadlineDisplayState('2026-09-15', '2026-09-16', 60)).toBe('overdue');
  });
});
