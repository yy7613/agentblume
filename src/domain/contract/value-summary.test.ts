import { describe, expect, it } from 'vitest';
import type { ClauseValue } from './clause-value';
import { summarizeClauseValue } from './value-summary';

describe('value-summary: summarizeClauseValue', () => {
  it('境界: 値が無ければ null', () => {
    expect(summarizeClauseValue(undefined)).toBeNull();
  });

  it.each<[string, ClauseValue, string]>([
    ['期間: 始期・満了日・月数', { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false }, '2026-04-01〜2027-03-31（12か月）'],
    ['期間: 締結日始まり・満了日', { kind: 'term', endDate: '2027-03-31', startsOnSigning: true }, '締結日〜2027-03-31'],
    ['期間: 始期不明', { kind: 'term', endDate: '2027-03-31', startsOnSigning: false }, '始期不明〜2027-03-31'],
    ['期間: 満了日不明', { kind: 'term', startDate: '2026-04-01', startsOnSigning: false }, '2026-04-01〜満了日不明'],
    ['期間: 締結日から月数', { kind: 'term', durationMonths: 12, startsOnSigning: true }, '締結日から（12か月）'],
    ['期間: 月数だけ', { kind: 'term', durationMonths: 6, startsOnSigning: false }, '（6か月）'],
    ['期間: 何も無い', { kind: 'term', startsOnSigning: false }, '期間の定めあり（値不明）'],
    ['更新なし', { kind: 'auto_renewal', renews: false, sameAsInitial: false }, '自動更新なし'],
    ['更新: 月数', { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: true }, '自動更新あり（12か月ごと）'],
    ['更新: 同一期間', { kind: 'auto_renewal', renews: true, sameAsInitial: true }, '自動更新あり（同一期間）'],
    ['更新: 期間不明', { kind: 'auto_renewal', renews: true, sameAsInitial: false }, '自動更新あり（期間不明）'],
    ['通知: 満了の月', { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false }, '満了の3か月前まで'],
    ['通知: 更新日の営業日', { kind: 'notice', amount: 30, unit: 'day', anchor: 'renewal', businessDays: true }, '更新日の30営業日前まで'],
    ['通知: 満了の日', { kind: 'notice', amount: 30, unit: 'day', anchor: 'expiry', businessDays: false }, '満了の30日前まで'],
    ['支払: 請求後の日数', { kind: 'payment_terms', basis: 'invoice', daysAfterBasis: 30, method: 'bank_transfer' }, '請求後 30 日以内・振込（最長 31 日目）'],
    ['支払: 月末締め翌月末', { kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end' }, '受領基準・末日締め翌月末日払い（最長 62 日目）'],
    ['支払: 20日締め翌々月10日・手形', { kind: 'payment_terms', basis: 'acceptance', closingDay: 20, payMonthOffset: 2, payDay: 10, method: 'promissory_note' }, '検収基準・20日締め翌々月10日払い・手形（最長 82 日目）'],
    ['支払: 計算不能', { kind: 'payment_terms', basis: 'unknown', closingDay: 'none', payMonthOffset: 0, method: 'electronic_record' }, '基準日不明基準・締めなし締め当月不明払い・電子記録債権（最長日数は計算不能）'],
    ['支払: 月数後・締め不明', { kind: 'payment_terms', basis: 'delivery', payMonthOffset: 3, payDay: 5, method: 'factoring' }, '受領基準・不明締め3か月後5日払い・ファクタリング（最長 97 日目）'],
    ['支払: 現金', { kind: 'payment_terms', basis: 'delivery', method: 'cash' }, '受領基準・不明締め不明不明払い・現金（最長日数は計算不能）'],
    ['支払: その他', { kind: 'payment_terms', basis: 'delivery', method: 'other' }, '受領基準・不明締め不明不明払い・その他（最長日数は計算不能）'],
    ['上限なし', { kind: 'liability_cap', capKind: 'none' }, '上限なし'],
    ['上限額', { kind: 'liability_cap', capKind: 'fixed_amount', amount: 1_000_000 }, '上限 1,000,000 円'],
    ['上限額不明', { kind: 'liability_cap', capKind: 'fixed_amount' }, '上限 金額不明'],
    ['支払済み委託料・故意重過失除く', { kind: 'liability_cap', capKind: 'fees_paid', excludesWillfulOrGross: true }, '支払済み委託料の総額まで（故意・重過失は除く）'],
    ['委託料 N か月分', { kind: 'liability_cap', capKind: 'fees_months', months: 3, excludesWillfulOrGross: false }, '委託料の3か月分まで'],
    ['委託料 ? か月分', { kind: 'liability_cap', capKind: 'fees_months' }, '委託料の?か月分まで'],
    ['上限不明確', { kind: 'liability_cap', capKind: 'unspecified' }, '上限の定めが不明確'],
    ['再委託自由', { kind: 'permission', policy: 'free' }, '自由'],
    ['再委託承諾', { kind: 'permission', policy: 'prior_consent' }, '事前の承諾が必要'],
    ['再委託通知', { kind: 'permission', policy: 'notify' }, '通知が必要'],
    ['再委託禁止', { kind: 'permission', policy: 'prohibited' }, '禁止'],
    ['知財: 甲（名前なし）', { kind: 'ip_ownership', owner: 'A' }, '甲に帰属'],
    ['知財: 共有・納品時', { kind: 'ip_ownership', owner: 'shared', transferOn: 'delivery' }, '共有（納品時に移転）'],
    ['知財: 不明確・発生時', { kind: 'ip_ownership', owner: 'unspecified', transferOn: 'creation' }, '帰属の定めが不明確（発生時に移転）'],
    ['管轄: 専属', { kind: 'jurisdiction', court: '東京地方裁判所', exclusive: true }, '東京地方裁判所（専属）'],
    ['管轄: 専属でない', { kind: 'jurisdiction', court: '大阪地方裁判所', exclusive: false }, '大阪地方裁判所（専属ではない）'],
    ['管轄: 裁判所名なし', { kind: 'jurisdiction' }, '裁判所名なし'],
    ['text', { kind: 'text', summary: '口頭の情報を含む' }, '口頭の情報を含む'],
  ])('正常: %s', (_label, value, expected) => {
    expect(summarizeClauseValue(value)).toBe(expected);
  });

  it('正常: 知財の帰属は甲乙の名前を添える', () => {
    expect(summarizeClauseValue({ kind: 'ip_ownership', owner: 'A' }, { A: '株式会社A' })).toBe('甲（株式会社A）に帰属');
    expect(summarizeClauseValue({ kind: 'ip_ownership', owner: 'B', transferOn: 'payment' }, { B: 'B社' })).toBe('乙（B社）に帰属（支払完了時に移転）');
    expect(summarizeClauseValue({ kind: 'ip_ownership', owner: 'B' })).toBe('乙に帰属');
  });
});
