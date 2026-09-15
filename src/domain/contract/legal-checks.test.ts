import { describe, expect, it } from 'vitest';
import { daysBetween } from './calendar';
import type { PaymentTermsValue } from './clause-value';
import { applicablePaymentLimit, checkPaymentMaxDays, checkProhibitedPaymentMethod, paymentMaxDays, withinPaymentLimit, type CounterpartyProfile, type LegalSettings } from './legal-checks';

const legal: LegalSettings = {
  paymentMaxDays: 60, freelancePaymentMaxDays: 60, freelanceRedelegationMaxDays: 30, prohibitedPaymentMethods: ['promissory_note'],
  allowMonthEndNextMonthEnd: true, dueSoonDays: 60, sources: [],
};

const terms = (overrides: Partial<PaymentTermsValue>): PaymentTermsValue => ({ kind: 'payment_terms', basis: 'delivery', ...overrides });
const profile = (toriteki: CounterpartyProfile['toriteki'], freelance: CounterpartyProfile['freelance'] = 'no'): CounterpartyProfile => ({ toriteki, freelance });

describe('legal-checks: paymentMaxDays（受領日を 1 日目とする最長日数）', () => {
  it('正常: 月末締め翌々月末払いは 92 日目（7/1 受領 → 9/30 払いと同じ長さ）', () => {
    const result = paymentMaxDays(terms({ closingDay: 'month_end', payMonthOffset: 2, payDay: 'month_end' }));
    expect(result.kind).toBe('computed');
    if (result.kind !== 'computed') return;
    expect(result.maxDays).toBe(92);
    // 公取委テキストの数え方（受領日を算入）。7/1 → 9/30 も 92 日目になることを暦で確かめる。
    expect(daysBetween('2026-07-01', '2026-09-30') + 1).toBe(92);
    expect(daysBetween(result.receivedOn, result.paidOn) + 1).toBe(92);
    expect(result.monthEndAllowance).toBe(false);
  });

  it('正常: 月末締め翌月末払いは 62 日目で、月締めの許容の対象になる', () => {
    expect(paymentMaxDays(terms({ closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end' }))).toEqual({ kind: 'computed', maxDays: 62, receivedOn: '2026-07-01', paidOn: '2026-08-31', monthEndAllowance: true });
  });

  it.each([
    // [説明, 条件, 最長日数]
    ['20日締め翌月10日払い', { closingDay: 20, payMonthOffset: 1, payDay: 10 }, 52],
    ['20日締め翌月末払い', { closingDay: 20, payMonthOffset: 1, payDay: 'month_end' }, 72],
    ['15日締め当月25日払い', { closingDay: 15, payMonthOffset: 0, payDay: 25 }, 41],
    ['月末締め当月末払い（締め日 = 支払日）', { closingDay: 'month_end', payMonthOffset: 0, payDay: 'month_end' }, 31],
    ['締め日なし（none）は月末締めと同じ数え方', { closingDay: 'none', payMonthOffset: 1, payDay: 'month_end' }, 62],
    ['締め日の記載なしも月末締めと同じ', { payMonthOffset: 1, payDay: 'month_end' }, 62],
    ['支払日 31 は小の月で末日に丸める', { closingDay: 'month_end', payMonthOffset: 1, payDay: 31 }, 62],
    ['月末締め翌月20日払い（2 月を含む月でも最大を採る）', { closingDay: 'month_end', payMonthOffset: 1, payDay: 20 }, 51],
  ] as const)('正常/境界: %s → %i 日目', (_label, overrides, expected) => {
    const result = paymentMaxDays(terms(overrides));
    expect(result.kind).toBe('computed');
    expect(result.kind === 'computed' ? result.maxDays : undefined).toBe(expected);
  });

  it('正常: 20日締め翌月10日払いの最悪ケースは前月 21 日受領（年またぎを含む）', () => {
    expect(paymentMaxDays(terms({ closingDay: 20, payMonthOffset: 1, payDay: 10 }))).toEqual({ kind: 'computed', maxDays: 52, receivedOn: '2025-12-21', paidOn: '2026-02-10', monthEndAllowance: false });
  });

  it.each([
    ['翌々月末', { closingDay: 'month_end', payMonthOffset: 2, payDay: 'month_end' }],
    ['締め日 20', { closingDay: 20, payMonthOffset: 1, payDay: 'month_end' }],
  ] as const)('境界: 月締めの許容は「月末締め・翌月・末日払い」だけ（%s は対象外）', (_label, overrides) => {
    const result = paymentMaxDays(terms(overrides));
    expect(result.kind === 'computed' && result.monthEndAllowance).toBe(false);
  });

  // 「31 日」は暦の上で末日と同じ（短い月は末日に丸める）。LLM が month_end と読むか 31 と読むかで合否が変わらないようにする。
  it.each([
    ['支払日 31', { closingDay: 'month_end', payMonthOffset: 1, payDay: 31 }],
    ['締め日 31', { closingDay: 31, payMonthOffset: 1, payDay: 'month_end' }],
    ['両方 31', { closingDay: 31, payMonthOffset: 1, payDay: 31 }],
  ] as const)('境界: %s は月末締め翌月末払いとして許容の対象', (_label, overrides) => {
    const result = paymentMaxDays(terms(overrides));
    expect(result).toMatchObject({ kind: 'computed', maxDays: 62, monthEndAllowance: true });
  });

  it.each([
    [60, 61], [0, 1], [30, 31],
  ])('正常: daysAfterBasis %i は受領日を 1 日目として %i 日目（締め日等より優先）', (days, expected) => {
    expect(paymentMaxDays(terms({ daysAfterBasis: days }))).toEqual({ kind: 'fixed', maxDays: expected });
    expect(paymentMaxDays(terms({ daysAfterBasis: days, closingDay: 20 }))).toEqual({ kind: 'fixed', maxDays: expected });
  });

  it.each([
    ['payDay 欠落', { closingDay: 'month_end', payMonthOffset: 1 }, 'payDay'],
    ['payMonthOffset 欠落', { closingDay: 'month_end', payDay: 'month_end' }, 'payMonthOffset'],
    ['何も無い', {}, 'payDay'],
    ['締め前払い（月末締め当月10日払い）', { closingDay: 'month_end', payMonthOffset: 0, payDay: 10 }, 'payDay'],
    ['締め前払い（25日締め当月10日払い）', { closingDay: 25, payMonthOffset: 0, payDay: 10 }, 'payDay'],
  ] as const)('異常: %s は計算不能（補正しない）', (_label, overrides, missing) => {
    expect(paymentMaxDays(terms(overrides))).toEqual({ kind: 'indeterminate', missing });
  });
});

describe('legal-checks: applicablePaymentLimit', () => {
  const custom: LegalSettings = { ...legal, paymentMaxDays: 60, freelancePaymentMaxDays: 45 };
  it.each([
    [profile('yes', 'no'), 60], [profile('no', 'yes'), 45], [profile('yes', 'yes'), 45], [profile('unknown', 'unknown'), undefined], [profile('no', 'no'), undefined],
  ])('正常: 申告 %o の上限は %s（両方 yes は小さい方）', (declared, expected) => {
    expect(applicablePaymentLimit(declared, custom)).toBe(expected);
  });
});

describe('legal-checks: withinPaymentLimit', () => {
  const monthEnd = paymentMaxDays(terms({ closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end' }));
  it('正常: 上限以内は許容の設定に依らず true', () => {
    expect(withinPaymentLimit({ kind: 'fixed', maxDays: 60 }, 60, { ...legal, allowMonthEndNextMonthEnd: false })).toBe(true);
  });
  it('境界: 月締めの許容は allowMonthEndNextMonthEnd と上限 60 日以上の両方が要る', () => {
    expect(withinPaymentLimit(monthEnd, 60, legal)).toBe(true);
    expect(withinPaymentLimit(monthEnd, 60, { ...legal, allowMonthEndNextMonthEnd: false })).toBe(false);
    expect(withinPaymentLimit(monthEnd, 59, legal)).toBe(false);
  });
  it('異常: 固定日数の超過・計算不能は false', () => {
    expect(withinPaymentLimit({ kind: 'fixed', maxDays: 61 }, 60, legal)).toBe(false);
    expect(withinPaymentLimit({ kind: 'indeterminate', missing: 'payDay' }, 60, legal)).toBe(false);
  });
});

describe('legal-checks: checkPaymentMaxDays', () => {
  const monthEndNext = terms({ closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end' });

  it('正常: 月末締め翌月末払いは許容 on で pass（detail に許容を明記）', () => {
    expect(checkPaymentMaxDays(monthEndNext, profile('yes'), legal)).toEqual({
      outcome: 'pass', detail: { maxDays: 62, limit: 60, worstCase: '2026-07-01 受領 → 2026-08-31 支払（62 日目）', monthEndAllowance: true },
    });
  });

  it('異常: 許容 off なら同じ条件が payment-over-limit', () => {
    const outcome = checkPaymentMaxDays(monthEndNext, profile('yes'), { ...legal, allowMonthEndNextMonthEnd: false });
    expect(outcome).toMatchObject({ outcome: 'fail', reason: 'payment-over-limit', detail: { maxDays: 62, limit: 60, monthEndAllowance: false } });
  });

  it('異常: 翌々月末払いは許容があっても超過', () => {
    expect(checkPaymentMaxDays(terms({ closingDay: 'month_end', payMonthOffset: 2, payDay: 'month_end' }), profile('yes'), legal)).toMatchObject({ outcome: 'fail', reason: 'payment-over-limit', detail: { maxDays: 92 } });
  });

  it('境界: 固定日数 59 日後（60 日目）は pass、60 日後（61 日目）は fail。worstCase は null', () => {
    expect(checkPaymentMaxDays(terms({ daysAfterBasis: 59 }), profile('yes'), legal)).toEqual({ outcome: 'pass', detail: { maxDays: 60, limit: 60, worstCase: null, monthEndAllowance: false } });
    expect(checkPaymentMaxDays(terms({ daysAfterBasis: 60 }), profile('yes'), legal)).toMatchObject({ outcome: 'fail', reason: 'payment-over-limit' });
  });

  it('正常: フリーランスだけ yes ならフリーランスの日数で照合する', () => {
    expect(checkPaymentMaxDays(terms({ daysAfterBasis: 40 }), profile('no', 'yes'), { ...legal, freelancePaymentMaxDays: 40 })).toMatchObject({ outcome: 'fail', detail: { limit: 40 } });
  });

  it('正常: 両方 no は照合しない（not-applicable）', () => {
    expect(checkPaymentMaxDays(monthEndNext, profile('no', 'no'), legal)).toEqual({ outcome: 'not-applicable' });
  });

  it.each([
    [profile('unknown', 'unknown'), monthEndNext, { maxDays: 62, worstCase: '2026-07-01 受領 → 2026-08-31 支払（62 日目）' }],
    [profile('no', 'unknown'), terms({ daysAfterBasis: 30 }), { maxDays: 31, worstCase: null }],
    [profile('unknown', 'no'), terms({}), { maxDays: null, worstCase: null }],
  ])('異常: 申告 %o が決まらなければ counterparty-profile-missing（参考値を detail に残す）', (declared, value, detail) => {
    expect(checkPaymentMaxDays(value, declared, legal)).toEqual({ outcome: 'unresolved', reason: 'counterparty-profile-missing', detail });
  });

  it('異常: 上限が決まっていて条件が計算不能なら payment-terms-indeterminate', () => {
    expect(checkPaymentMaxDays(terms({ closingDay: 'month_end', payMonthOffset: 1 }), profile('yes'), legal)).toEqual({ outcome: 'unresolved', reason: 'payment-terms-indeterminate', detail: { missing: 'payDay', limit: 60 } });
  });
});

describe('legal-checks: checkProhibitedPaymentMethod', () => {
  it.each([
    ['取適法 no は対象外', profile('no', 'yes'), terms({ method: 'promissory_note' }), { outcome: 'not-applicable' }],
    ['取適法 unknown', profile('unknown'), terms({ method: 'promissory_note' }), { outcome: 'unresolved', reason: 'counterparty-profile-missing', detail: { method: 'promissory_note' } }],
    ['取適法 unknown・手段なし', profile('unknown'), terms({}), { outcome: 'unresolved', reason: 'counterparty-profile-missing', detail: { method: null } }],
    ['手段が読めていない', profile('yes'), terms({}), { outcome: 'unresolved', reason: 'field-missing', detail: { field: 'payment.method' } }],
    ['手形は禁止', profile('yes'), terms({ method: 'promissory_note' }), { outcome: 'fail', reason: 'prohibited-payment-method', detail: { method: 'promissory_note' } }],
    ['振込は可', profile('yes'), terms({ method: 'bank_transfer' }), { outcome: 'pass', detail: { method: 'bank_transfer' } }],
  ] as const)('正常/異常: %s', (_label, declared, value, expected) => {
    expect(checkProhibitedPaymentMethod(value, declared, legal)).toEqual(expected);
  });

  it('正常: 禁止手段は設定値（電子記録債権を足せる）', () => {
    expect(checkProhibitedPaymentMethod(terms({ method: 'electronic_record' }), profile('yes'), { ...legal, prohibitedPaymentMethods: ['promissory_note', 'electronic_record'] })).toMatchObject({ outcome: 'fail' });
  });
});
