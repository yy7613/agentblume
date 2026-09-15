import { describe, expect, it } from 'vitest';
import { clauseValueProblem, FIELD_PATHS, isFieldPathFor, normalizeFlatValue, VALUE_KINDS, type FlatValue, type ValueKind } from './clause-value';

describe('clause-value: normalizeFlatValue（正常系: valueKind ごとの型へ）', () => {
  it.each<[ValueKind, FlatValue, unknown]>([
    ['term', { term_start: '2026-04-01', term_end: '2027-03-31', term_months: 12, starts_on_signing: false }, { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false }],
    ['term', { starts_on_signing: true, term_months: 12 }, { kind: 'term', durationMonths: 12, startsOnSigning: true }],
    ['auto_renewal', { renews: true, renewal_months: 12, renewal_same_as_initial: null }, { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: false }],
    ['auto_renewal', { renews: false }, { kind: 'auto_renewal', renews: false, sameAsInitial: false }],
    ['notice', { notice_amount: 3, notice_unit: 'month' }, { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false }],
    ['notice', { notice_amount: 30, notice_unit: 'day', notice_anchor: 'renewal', notice_business_days: true }, { kind: 'notice', amount: 30, unit: 'day', anchor: 'renewal', businessDays: true }],
    ['payment_terms', { pay_basis: 'delivery', pay_closing_day: 'month_end', pay_month_offset: 1, pay_day: 'month_end', pay_method: 'bank_transfer' }, { kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end', method: 'bank_transfer' }],
    ['payment_terms', { pay_closing_day: 'none', pay_days_after_basis: 30 }, { kind: 'payment_terms', basis: 'unknown', closingDay: 'none', daysAfterBasis: 30 }],
    ['payment_terms', { pay_basis: 'acceptance' }, { kind: 'payment_terms', basis: 'acceptance' }],
    ['liability_cap', { cap_kind: 'fees_months', cap_amount: 0, cap_months: 3, cap_excludes_willful_or_gross: true }, { kind: 'liability_cap', capKind: 'fees_months', amount: 0, months: 3, excludesWillfulOrGross: true }],
    ['permission', { permission_policy: 'prior_consent' }, { kind: 'permission', policy: 'prior_consent' }],
    ['ip_ownership', { ip_owner_party: 'A', ip_transfer_on: 'payment', ip_moral_rights_not_exercised: false }, { kind: 'ip_ownership', owner: 'A', transferOn: 'payment', moralRightsNotExercised: false }],
    ['jurisdiction', { court: '  東京地方裁判所 ', court_exclusive: true }, { kind: 'jurisdiction', court: '東京地方裁判所', exclusive: true }],
    ['jurisdiction', { court_exclusive: false }, { kind: 'jurisdiction', exclusive: false }],
    ['text', { text_summary: '口頭の情報も含む' }, { kind: 'text', summary: '口頭の情報も含む' }],
  ])('正常: %s %o', (kind, flat, expected) => {
    expect(normalizeFlatValue(kind, flat)).toEqual({ value: expected, dropped: [] });
  });

  it.each<[ValueKind, FlatValue]>([
    ['term', {}], ['term', { starts_on_signing: false }], ['auto_renewal', { renewal_months: 12 }], ['notice', { notice_amount: 3 }], ['notice', { notice_unit: 'month' }],
    ['payment_terms', { pay_basis: 'unknown' }], ['liability_cap', { cap_amount: 100 }], ['permission', {}], ['ip_ownership', { ip_transfer_on: 'payment' }],
    ['jurisdiction', {}], ['text', { text_summary: null }],
  ])('境界: 必須の値が揃わない %s %o は値を作らない（null は黙って省く）', (kind, flat) => {
    expect(normalizeFlatValue(kind, flat)).toEqual({ dropped: [] });
  });
});

describe('clause-value: normalizeFlatValue（異常系: 型・範囲外は落として dropped に積む）', () => {
  it.each<[ValueKind, FlatValue, readonly string[]]>([
    ['term', { term_start: '2026-02-30', term_end: '2027/03/31', term_months: 0, starts_on_signing: 'yes' }, ['term_start="2026-02-30"', 'term_end="2027/03/31"', 'term_months=0', 'starts_on_signing="yes"']],
    ['term', { term_months: 1201 }, ['term_months=1201']],
    ['auto_renewal', { renews: 'true', renewal_months: 1.5, renewal_same_as_initial: 1 }, ['renews="true"', 'renewal_months=1.5', 'renewal_same_as_initial=1']],
    ['notice', { notice_amount: -1, notice_unit: 'week', notice_anchor: 'start', notice_business_days: 'no' }, ['notice_amount=-1', 'notice_unit="week"', 'notice_anchor="start"', 'notice_business_days="no"']],
    ['payment_terms', { pay_basis: 'shipment', pay_closing_day: 32, pay_month_offset: 15, pay_day: 0, pay_days_after_basis: 3651, pay_method: 'bitcoin' }, ['pay_basis="shipment"', 'pay_closing_day=32', 'pay_month_offset=15', 'pay_day=0', 'pay_days_after_basis=3651', 'pay_method="bitcoin"']],
    ['liability_cap', { cap_kind: 'unlimited', cap_amount: -5, cap_months: 0, cap_excludes_willful_or_gross: 'yes' }, ['cap_kind="unlimited"', 'cap_amount=-5', 'cap_months=0', 'cap_excludes_willful_or_gross="yes"']],
    ['permission', { permission_policy: 'maybe' }, ['permission_policy="maybe"']],
    ['ip_ownership', { ip_owner_party: 'us', ip_transfer_on: 'never', ip_moral_rights_not_exercised: 'x' }, ['ip_owner_party="us"', 'ip_transfer_on="never"', 'ip_moral_rights_not_exercised="x"']],
    ['jurisdiction', { court: '   ', court_exclusive: 'yes' }, ['court="   "', 'court_exclusive="yes"']],
    ['jurisdiction', { court: 'x'.repeat(201) }, [`court="${'x'.repeat(201)}"`]],
    ['text', { text_summary: 'x'.repeat(1001) }, [`text_summary="${'x'.repeat(1001)}"`]],
  ])('異常: %s %o', (kind, flat, dropped) => {
    const result = normalizeFlatValue(kind, flat);
    expect(result.dropped).toEqual(dropped);
  });

  it('異常: 一部だけ崩れていれば通ったフィールドで値を作る（補正しない）', () => {
    expect(normalizeFlatValue('payment_terms', { pay_basis: 'delivery', pay_month_offset: 15, pay_day: 'month_end' })).toEqual({
      value: { kind: 'payment_terms', basis: 'delivery', payDay: 'month_end' },
      dropped: ['pay_month_offset=15'],
    });
  });
});

describe('clause-value: clauseValueProblem', () => {
  it.each([
    { kind: 'term', startsOnSigning: false },
    { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: true },
    { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: false },
    { kind: 'notice', amount: 0, unit: 'day', anchor: 'renewal', businessDays: false },
    { kind: 'payment_terms', basis: 'invoice', closingDay: 'none', payMonthOffset: 0, payDay: 31, daysAfterBasis: 0, method: 'cash' },
    { kind: 'liability_cap', capKind: 'fixed_amount', amount: 1000, months: 1, excludesWillfulOrGross: false },
    { kind: 'permission', policy: 'notify' },
    { kind: 'ip_ownership', owner: 'shared', transferOn: 'creation', moralRightsNotExercised: true },
    { kind: 'jurisdiction' },
    { kind: 'text', summary: 'x' },
  ])('正常: %o は正しい', (value) => {
    expect(clauseValueProblem(value)).toBeUndefined();
  });

  it.each([
    null, [], 'term', { kind: 'unknown' },
    { kind: 'term' }, { kind: 'term', startsOnSigning: false, startDate: '2026-13-01' }, { kind: 'term', startsOnSigning: false, durationMonths: 0 },
    { kind: 'auto_renewal', renews: true }, { kind: 'auto_renewal', renews: true, sameAsInitial: false, renewalMonths: 0 },
    { kind: 'notice', amount: 3, unit: 'week', anchor: 'expiry', businessDays: false }, { kind: 'notice', amount: 3, unit: 'day', anchor: 'x', businessDays: false },
    { kind: 'payment_terms', basis: 'x' }, { kind: 'payment_terms', basis: 'delivery', closingDay: 0 }, { kind: 'payment_terms', basis: 'delivery', payMonthOffset: 13 },
    { kind: 'payment_terms', basis: 'delivery', payDay: 'none' }, { kind: 'payment_terms', basis: 'delivery', daysAfterBasis: -1 }, { kind: 'payment_terms', basis: 'delivery', method: 'check' },
    { kind: 'liability_cap', capKind: 'x' }, { kind: 'liability_cap', capKind: 'none', amount: 1.5 }, { kind: 'liability_cap', capKind: 'none', excludesWillfulOrGross: 'no' },
    { kind: 'permission', policy: 'x' },
    { kind: 'ip_ownership', owner: 'us' }, { kind: 'ip_ownership', owner: 'A', transferOn: 'x' }, { kind: 'ip_ownership', owner: 'A', moralRightsNotExercised: 1 },
    { kind: 'jurisdiction', court: '' }, { kind: 'jurisdiction', exclusive: 'yes' },
    { kind: 'text', summary: ' ' },
  ])('異常: %o は崩れている', (value) => {
    expect(clauseValueProblem(value)).toMatch(/^value (must be an object|does not match its kind)/u);
  });
});

describe('clause-value: isFieldPathFor', () => {
  it('正常: present はすべての valueKind で使え、各 valueKind は自分のパスだけを持つ', () => {
    for (const kind of VALUE_KINDS) {
      expect(isFieldPathFor(kind, 'present')).toBe(true);
      for (const path of FIELD_PATHS[kind]) expect(isFieldPathFor(kind, path)).toBe(true);
    }
  });

  it.each<[ValueKind, string]>([['term', 'renewal.months'], ['text', 'text.summary'], ['payment_terms', 'payment.payDay'], ['ip_ownership', 'cap.kind']])('異常: %s に %s は無い', (kind, path) => {
    expect(isFieldPathFor(kind, path)).toBe(false);
  });
});
