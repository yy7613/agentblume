import { describe, expect, it } from 'vitest';
import type { ClauseValue, TermValue } from './clause-value';
import { applyConsistency, termMonthsOf, type TopicKind } from './consistency';
import type { Clause, ClauseWarning } from './document';

const topics: readonly TopicKind[] = [
  { id: 'term', valueKind: 'term' },
  { id: 'renewal', valueKind: 'auto_renewal' },
  { id: 'notice', valueKind: 'notice' },
  { id: 'free', valueKind: 'text' },
];

const clause = (topicId: string, value: ClauseValue | undefined, quotes: readonly string[], warnings: readonly ClauseWarning[] = []): Clause => ({
  topicId, present: true, evidence: quotes.map((quote) => ({ quote, verified: true })), ...(value === undefined ? {} : { value }), source: 'llm', warnings,
});

const term = (overrides: Partial<TermValue>): TermValue => ({ kind: 'term', startsOnSigning: false, ...overrides });
const warningsOf = (clauses: readonly Clause[], topicId: string) => clauses.find((entry) => entry.topicId === topicId)!.warnings;

describe('consistency: termMonthsOf', () => {
  it.each([
    [term({ durationMonths: 6, startDate: '2026-04-01', endDate: '2027-03-31' }), 6],
    [term({ startDate: '2026-04-01', endDate: '2027-03-31' }), 12],
    [term({ startDate: '2026-04-01', endDate: '2027-03-15' }), undefined],
    [term({ startDate: '2026-04-01' }), undefined],
    [term({ endDate: '2027-03-31' }), undefined],
  ])('正常/境界: %o → %s（明記優先・無ければ R1 で逆算）', (value, expected) => {
    expect(termMonthsOf(value)).toBe(expected);
  });
});

describe('consistency: G1 期間の整合', () => {
  it('正常: 始期・満了日・期間が R1 と一致し、引用の日付・期間もすべて使われていれば警告なし', () => {
    const [result] = applyConsistency([clause('term', term({ startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12 }), ['本契約の有効期間は、2026年4月1日から2027年3月31日までの1年間とする。'])], topics);
    expect(result!.warnings).toEqual([]);
  });

  it.each([
    ['2027-04-01', 1],
    ['2027-03-30', -1],
  ])('境界: 満了日 %s は計算値と %i 日ずれ → 「始期を含めない書き方の可能性」の文言', (endDate, days) => {
    const value = term({ startDate: '2026-04-01', endDate, durationMonths: 12 });
    const [result] = applyConsistency([clause('term', value, [])], topics);
    expect(result!.warnings).toEqual([{ code: 'deadline-mismatch', origin: 'consistency', days, message: expect.stringContaining('始期を含めない書き方の可能性があります') }]);
    expect(result!.warnings[0]!.message).toContain('2027-03-31');
  });

  it('異常: 2 日以上のずれは差の日数だけを示し、1 日ずれの文言は付けない', () => {
    const [result] = applyConsistency([clause('term', term({ startDate: '2026-04-01', endDate: '2027-04-02', durationMonths: 12 }), [])], topics);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0]).toMatchObject({ code: 'deadline-mismatch', days: 2 });
    expect(result!.warnings[0]!.message).not.toContain('始期を含めない');
  });
});

describe('consistency: G3 期間の日付', () => {
  it('異常: 満了日が引用の中の日付（和暦換算後）に無ければ警告し、見つかった日付を並べる', () => {
    const [result] = applyConsistency([clause('term', term({ startDate: '2026-04-01', endDate: '2027-03-31' }), ['本契約は令和8年4月1日から効力を有する。'])], topics);
    expect(result!.warnings).toEqual([{ code: 'deadline-mismatch', origin: 'consistency', message: '満了日 2027-03-31 が根拠の引用の中の日付（2026-04-01）と一致しません' }]);
  });

  it('境界: 引用に日付が 1 つも無ければ「なし」と書く', () => {
    const [result] = applyConsistency([clause('term', term({ startDate: '2026-04-01' }), ['本契約の期間は締結日から始まる。'])], topics);
    expect(result!.warnings.map((warning) => warning.message)).toEqual(['始期 2026-04-01 が根拠の引用の中の日付（なし）と一致しません']);
  });
});

describe('consistency: G2 通知期間', () => {
  it.each([
    [{ amount: 3, unit: 'month' as const }, '期間満了の三箇月前までに書面で通知する。'],
    [{ amount: 3, unit: 'month' as const }, '期間満了の3ヶ月前までに書面で通知する。'],
    [{ amount: 90, unit: 'day' as const }, '期間満了の９０日前までに書面で通知する。'],
  ])('正常: %o と「%s」は一致', (notice, quote) => {
    const [result] = applyConsistency([clause('notice', { kind: 'notice', ...notice, anchor: 'expiry', businessDays: false }, [quote])], topics);
    expect(result!.warnings).toEqual([]);
  });

  it.each([
    [{ amount: 2, unit: 'month' as const }, '期間満了の三箇月前までに通知する。', '通知期間「2か月」が根拠の引用の中の期間表現（三箇月）と一致しません'],
    [{ amount: 3, unit: 'day' as const }, '期間満了の3か月前までに通知する。', '通知期間「3日」が根拠の引用の中の期間表現（3か月）と一致しません'],
    [{ amount: 3, unit: 'month' as const }, '期間満了前に通知する。', '通知期間「3か月」が根拠の引用の中の期間表現（なし）と一致しません'],
  ])('異常: %o と「%s」は不一致', (notice, quote, message) => {
    const [result] = applyConsistency([clause('notice', { kind: 'notice', ...notice, anchor: 'expiry', businessDays: false }, [quote])], topics);
    expect(result!.warnings.filter((warning) => warning.code === 'deadline-mismatch').map((warning) => warning.message)).toEqual([message]);
  });

  it('境界: 引用が無ければ照合しない', () => {
    const [result] = applyConsistency([clause('notice', { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false }, [])], topics);
    expect(result!.warnings).toEqual([]);
  });
});

describe('consistency: G4 更新期間', () => {
  const termClause = clause('term', term({ startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12 }), []);

  it('正常: 更新の月数が引用内の期間表現と一致', () => {
    const result = applyConsistency([termClause, clause('renewal', { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: false }, ['同一条件でさらに1年間更新する。'])], topics);
    expect(warningsOf(result, 'renewal')).toEqual([]);
  });

  it('異常: 更新の月数が引用と違えば警告', () => {
    const result = applyConsistency([termClause, clause('renewal', { kind: 'auto_renewal', renews: true, renewalMonths: 6, sameAsInitial: false }, ['さらに1年間更新する。'])], topics);
    expect(warningsOf(result, 'renewal')).toContainEqual({ code: 'deadline-mismatch', origin: 'consistency', message: '更新期間「6か月」が根拠の引用の中の期間表現（1年間）と一致しません' });
  });

  it('異常: 「同一条件」なのに更新期間が初回の期間と違えば警告', () => {
    const result = applyConsistency([termClause, clause('renewal', { kind: 'auto_renewal', renews: true, renewalMonths: 6, sameAsInitial: true }, ['同一条件で6か月更新する。'])], topics);
    expect(warningsOf(result, 'renewal')).toEqual([{ code: 'deadline-mismatch', origin: 'consistency', message: '更新は「同一条件」ですが、更新期間 6 か月が初回の期間 12 か月と違います' }]);
  });

  it.each([
    ['更新しない', { kind: 'auto_renewal' as const, renews: false, sameAsInitial: false }, ['更新しない。']],
    ['同一条件で月数なし', { kind: 'auto_renewal' as const, renews: true, sameAsInitial: true }, ['同一条件で更新する。']],
    ['引用なし・同一条件で初回と同じ', { kind: 'auto_renewal' as const, renews: true, renewalMonths: 12, sameAsInitial: true }, []],
  ])('境界: %s は警告なし', (_label, value, quotes) => {
    const result = applyConsistency([termClause, clause('renewal', value, quotes)], topics);
    expect(warningsOf(result, 'renewal')).toEqual([]);
  });
});

describe('consistency: G5 取りこぼし', () => {
  it('正常: 引用にあるのに値に使っていない期間表現を code なしの補足で列挙する（重複は 1 つ）', () => {
    const [result] = applyConsistency([clause('notice', { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false }, ['満了の3か月前まで、又は30日前まで', '30日前'])], topics);
    expect(result!.warnings).toEqual([{ message: '根拠の引用に値として使っていない日付・期間があります: 30日', origin: 'consistency' }]);
  });

  it('正常: 期間の引用にある未使用の日付も列挙する', () => {
    const [result] = applyConsistency([clause('term', term({ startDate: '2026-04-01', durationMonths: 12 }), ['2026年4月1日から1年間。ただし2026年10月1日に見直す。'])], topics);
    expect(result!.warnings).toEqual([{ message: '根拠の引用に値として使っていない日付・期間があります: 2026年10月1日', origin: 'consistency' }]);
  });

  it('正常: 更新の引用の日数表現は未使用として列挙する', () => {
    const result = applyConsistency([clause('renewal', { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: false }, ['1年間更新する。30日前までに申し出る。'])], topics);
    expect(warningsOf(result, 'renewal')).toEqual([{ message: '根拠の引用に値として使っていない日付・期間があります: 30日', origin: 'consistency' }]);
  });
});

describe('consistency: 付け直し', () => {
  it('正常: 以前の consistency 由来の警告を外し、抽出・手入力の警告は残す', () => {
    const previous: ClauseWarning[] = [
      { code: 'deadline-mismatch', message: 'old', origin: 'consistency', days: 3 },
      { code: 'value-unparsed', message: 'kept', origin: 'extraction' },
      { message: 'manual note', origin: 'manual' },
    ];
    const [result] = applyConsistency([clause('term', term({ startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12 }), [], previous)], topics);
    expect(result!.warnings).toEqual([previous[1], previous[2]]);
  });

  it.each([
    ['条項が無い', { ...clause('term', term({ startDate: '2026-04-01' }), ['x']), present: false }],
    ['値が無い', clause('term', undefined, ['2026年4月1日'])],
    ['トピックの valueKind と値の型が違う', clause('term', { kind: 'notice', amount: 1, unit: 'day', anchor: 'expiry', businessDays: false }, ['5日'])],
    ['text のトピック', clause('free', { kind: 'text', summary: 'x' }, ['2026年4月1日'])],
    ['未知のトピック', clause('other', term({ startDate: '2026-04-01' }), ['x'])],
  ])('境界: %s は consistency の警告を外すだけで足さない', (_label, input) => {
    const stale: ClauseWarning = { code: 'deadline-mismatch', message: 'old', origin: 'consistency' };
    const [result] = applyConsistency([{ ...input, warnings: [stale] }], topics);
    expect(result!.warnings).toEqual([]);
  });

  it('正常: 入力の配列と条項は変更しない（純関数）', () => {
    const input = [clause('term', term({ startDate: '2026-04-01', endDate: '2027-04-01', durationMonths: 12 }), [])];
    const snapshot = structuredClone(input);
    applyConsistency(input, topics);
    expect(input).toEqual(snapshot);
  });
});
