import { describe, expect, it } from 'vitest';
import type { ClauseValue } from './clause-value';
import { CLAUSE_TAGS, clauseTags, formatTags, type ClauseTag } from './clause-tags';
import { DEFAULT_LEGAL_SETTINGS } from './playbook-templates';
import type { SignedClause } from './signed-contract';
import type { PartyKey } from './vocabulary';

const signed = (value: ClauseValue | undefined, overrides: Partial<SignedClause> = {}): SignedClause => ({
  topicId: 't', topicLabel: 'T', valueKind: value?.kind ?? 'text', present: true, quoteVerified: true, ...(value === undefined ? {} : { value }), ...overrides,
});

const cases: readonly [string, SignedClause, PartyKey | undefined, readonly ClauseTag[]][] = [
  ['条項なし（未検証でも missing だけ）', signed(undefined, { present: false, quoteVerified: false }), 'A', ['missing']],
  ['上限なし', signed({ kind: 'liability_cap', capKind: 'none' }), 'A', ['no-cap']],
  ['上限額', signed({ kind: 'liability_cap', capKind: 'fixed_amount', amount: 1 }), 'A', ['cap-fixed']],
  ['支払済み委託料', signed({ kind: 'liability_cap', capKind: 'fees_paid' }), 'A', ['cap-fees-paid']],
  ['委託料の N か月分', signed({ kind: 'liability_cap', capKind: 'fees_months', months: 3 }), 'A', ['cap-fees-paid']],
  ['上限の定めが不明確', signed({ kind: 'liability_cap', capKind: 'unspecified' }), 'A', ['cap-unspecified']],
  ['自動更新あり', signed({ kind: 'auto_renewal', renews: true, sameAsInitial: true }), 'A', ['auto-renewal']],
  ['自動更新なし', signed({ kind: 'auto_renewal', renews: false, sameAsInitial: false }), 'A', ['no-auto-renewal']],
  ['翌々月末払い（92 日目）', signed({ kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 2, payDay: 'month_end' }), 'A', ['payment-over-limit']],
  ['月末締め翌月末払いは許容内', signed({ kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end', method: 'bank_transfer' }), 'A', []],
  ['計算不能はタグなし', signed({ kind: 'payment_terms', basis: 'unknown' }), 'A', []],
  ['手形', signed({ kind: 'payment_terms', basis: 'delivery', daysAfterBasis: 30, method: 'promissory_note' }), 'A', ['promissory-note']],
  ['再委託自由', signed({ kind: 'permission', policy: 'free' }), 'A', ['subcontract-free']],
  ['事前承諾', signed({ kind: 'permission', policy: 'prior_consent' }), 'A', ['subcontract-consent']],
  ['通知', signed({ kind: 'permission', policy: 'notify' }), 'A', ['subcontract-notify']],
  ['禁止', signed({ kind: 'permission', policy: 'prohibited' }), 'A', ['subcontract-prohibited']],
  ['自社（甲）に帰属', signed({ kind: 'ip_ownership', owner: 'A' }), 'A', ['ip-ours']],
  ['相手（乙）に帰属', signed({ kind: 'ip_ownership', owner: 'B' }), 'A', ['ip-theirs']],
  ['共有', signed({ kind: 'ip_ownership', owner: 'shared' }), undefined, ['ip-shared']],
  ['帰属不明', signed({ kind: 'ip_ownership', owner: 'unspecified' }), 'A', ['ip-unspecified']],
  ['自社の甲乙が未設定', signed({ kind: 'ip_ownership', owner: 'A' }), undefined, ['ip-unspecified']],
  ['専属管轄', signed({ kind: 'jurisdiction', exclusive: true }), 'A', ['court-exclusive']],
  ['専属でない', signed({ kind: 'jurisdiction', exclusive: false }), 'A', ['court-non-exclusive']],
  ['専属か不明', signed({ kind: 'jurisdiction', court: '東京地方裁判所' }), 'A', []],
  ['text', signed({ kind: 'text', summary: 'x' }), 'A', []],
  ['値なし', signed(undefined), 'A', []],
  ['引用が未検証', signed({ kind: 'permission', policy: 'free' }, { quoteVerified: false }), 'A', ['subcontract-free', 'unverified']],
];

describe('clause-tags: clauseTags', () => {
  it.each(cases)('正常: %s', (_label, clause, ourParty, expected) => {
    expect(clauseTags(clause, { legal: DEFAULT_LEGAL_SETTINGS, ...(ourParty === undefined ? {} : { ourParty }) })).toEqual(expected);
  });

  it('正常: 表の全ケースで語彙のすべてのタグが 1 回以上出る（語彙の網羅）', () => {
    const produced = new Set(cases.flatMap(([, clause, ourParty]) => clauseTags(clause, { legal: DEFAULT_LEGAL_SETTINGS, ...(ourParty === undefined ? {} : { ourParty }) })));
    expect([...produced].sort()).toEqual([...CLAUSE_TAGS].sort());
  });

  it('境界: 月締めの許容 off なら月末締め翌月末払いも payment-over-limit', () => {
    const clause = signed({ kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 1, payDay: 'month_end' });
    expect(clauseTags(clause, { legal: { ...DEFAULT_LEGAL_SETTINGS, allowMonthEndNextMonthEnd: false } })).toEqual(['payment-over-limit']);
  });

  it('正常: 手形かつ超過なら両方のタグ', () => {
    const clause = signed({ kind: 'payment_terms', basis: 'delivery', daysAfterBasis: 90, method: 'promissory_note' });
    expect(clauseTags(clause, { legal: DEFAULT_LEGAL_SETTINGS })).toEqual(['payment-over-limit', 'promissory-note']);
  });
});

describe('clause-tags: formatTags', () => {
  it.each([
    [[], ''], [['no-cap'], ',no-cap,'], [['no-cap', 'unverified'], ',no-cap,unverified,'],
  ])('正常: %o → "%s"（前後にカンマを付けて 1 タグで当てやすくする）', (tags, expected) => {
    expect(formatTags(tags)).toBe(expected);
  });
});
