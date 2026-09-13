import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateConditions, hasFact, readFactPath } from './conditions';
import type { DocumentFacts } from './document';
import type { ConditionOp, RuleCondition } from './rule';

const facts: DocumentFacts = {
  direction: 'out',
  issuerName: 'ＡＢＣ商事',
  registrationNumber: 'T1234567890123',
  transactionDate: '2026-09-10',
  grandTotal: 1100,
  paymentMethod: 'credit_card',
  description: 'アマゾン ウェブ サービス',
  descriptionNorm: 'アマゾン ウェブ サービス',
  lines: [
    { description: 'ノート', amount: 300 },
    { description: 'ペン', amount: 800 },
  ],
  extra: { purpose: 'internal-meeting', headcount: 3, taxable: true, flag: false },
};

const cond = (field: string, op: ConditionOp, value?: unknown): RuleCondition =>
  ({ field, op, ...(value === undefined ? {} : { value: value as RuleCondition['value'] }) });

const check = (field: string, op: ConditionOp, value?: unknown): boolean => evaluateCondition(facts, cond(field, op, value));

describe('readFactPath', () => {
  it('正常: 素のパス・入れ子（extra.<key>）を解決する', () => {
    expect(readFactPath(facts, 'grandTotal')).toBe(1100);
    expect(readFactPath(facts, 'issuerName')).toBe('ＡＢＣ商事');
    expect(readFactPath(facts, 'extra.purpose')).toBe('internal-meeting');
    expect(readFactPath(facts, 'extra.headcount')).toBe(3);
  });

  it('正常: `lines[].x` は要素ごとの値の配列（array-any 意味論の土台）', () => {
    expect(readFactPath(facts, 'lines[].description')).toEqual(['ノート', 'ペン']);
    expect(readFactPath(facts, 'lines[].amount')).toEqual([300, 800]);
  });

  it('境界: 無いパス・無いキーは undefined。`lines[]` の無いキーは undefined の配列', () => {
    expect(readFactPath(facts, 'missing')).toBeUndefined();
    expect(readFactPath(facts, 'extra.nope')).toBeUndefined();
    expect(readFactPath(facts, 'issueDate')).toBeUndefined();
    expect(readFactPath(facts, 'lines[].nope')).toEqual([undefined, undefined]);
  });

  it('境界: 配列を持たない文書の `lines[]` は空配列。空パスは undefined', () => {
    expect(readFactPath({}, 'lines[].description')).toEqual([]);
    expect(readFactPath(facts, '')).toBeUndefined();
    expect(readFactPath(facts, '  ')).toBeUndefined();
  });

  it('境界: スカラーの先を掘ろうとしても例外にならず undefined', () => {
    expect(readFactPath(facts, 'grandTotal.nope')).toBeUndefined();
  });
});

describe('hasFact', () => {
  it('正常 / 境界: 値があれば真、無い・空文字なら偽（requiredFacts の判定）', () => {
    expect(hasFact(facts, 'grandTotal')).toBe(true);
    expect(hasFact(facts, 'extra.purpose')).toBe(true);
    expect(hasFact(facts, 'issueDate')).toBe(false);
    expect(hasFact(facts, 'missing')).toBe(false);
    expect(hasFact({ issuerName: '' }, 'issuerName')).toBe(false);
  });

  it('境界: `lines[]` は 1 要素でも値があれば真。空配列・全欠落は偽', () => {
    expect(hasFact(facts, 'lines[].description')).toBe(true);
    expect(hasFact(facts, 'lines[].nope')).toBe(false);
    expect(hasFact({}, 'lines[].description')).toBe(false);
  });

  it('境界: false や 0 は「値がある」（空とは違う）', () => {
    expect(hasFact(facts, 'extra.flag')).toBe(true);
    expect(hasFact({ grandTotal: 0 }, 'grandTotal')).toBe(true);
  });
});

describe('evaluateCondition — 文字列比較は NFKC + 大文字小文字無視', () => {
  it('正常: equals は全角・半角と大文字・小文字の違いを吸収する', () => {
    // 'ＡＢＣ商事' は NFKC で 'ABC商事' になり、小文字化して比較される。
    expect(check('issuerName', 'equals', 'abc商事')).toBe(true);
    expect(check('issuerName', 'equals', 'ＡＢＣ商事')).toBe(true);
    expect(check('issuerName', 'equals', 'ABC')).toBe(false);
  });

  it('正常: 数値・真偽値の equals', () => {
    expect(check('grandTotal', 'equals', 1100)).toBe(true);
    expect(check('grandTotal', 'equals', 1200)).toBe(false);
    expect(check('extra.taxable', 'equals', true)).toBe(true);
    expect(check('extra.taxable', 'equals', false)).toBe(false);
  });

  it('境界: 数値と数字文字列の equals は文字列化して一致する', () => {
    expect(check('grandTotal', 'equals', '1100')).toBe(true);
  });

  it('正常: contains / startsWith / endsWith', () => {
    expect(check('descriptionNorm', 'contains', 'ウェブ')).toBe(true);
    expect(check('descriptionNorm', 'contains', 'グーグル')).toBe(false);
    expect(check('issuerName', 'contains', 'abc')).toBe(true);
    expect(check('descriptionNorm', 'startsWith', 'アマゾン')).toBe(true);
    expect(check('descriptionNorm', 'startsWith', 'サービス')).toBe(false);
    expect(check('descriptionNorm', 'endsWith', 'サービス')).toBe(true);
    expect(check('descriptionNorm', 'endsWith', 'アマゾン')).toBe(false);
  });

  it('正常 / 例外: regex は大文字小文字を無視し、壊れたパターンは例外にせず false', () => {
    expect(check('descriptionNorm', 'regex', 'アマゾン|グーグル')).toBe(true);
    expect(check('issuerName', 'regex', '^abc')).toBe(true);
    expect(check('descriptionNorm', 'regex', 'マイクロソフト')).toBe(false);
    // 判定の途中で例外を投げると 1 件の壊れたルールが一括判定を止めてしまう。
    expect(check('descriptionNorm', 'regex', '(')).toBe(false);
    expect(check('descriptionNorm', 'regex', '[a-')).toBe(false);
  });

  it('境界: between は両端を含む', () => {
    expect(check('grandTotal', 'between', [1000, 2000])).toBe(true);
    expect(check('grandTotal', 'between', [1100, 2000])).toBe(true);
    expect(check('grandTotal', 'between', [0, 1100])).toBe(true);
    expect(check('grandTotal', 'between', [1101, 2000])).toBe(false);
    expect(check('grandTotal', 'between', [0, 1099])).toBe(false);
  });

  it('境界: between の値が 2 要素の配列でなければ false', () => {
    expect(check('grandTotal', 'between', [1000])).toBe(false);
    expect(check('grandTotal', 'between', 1000)).toBe(false);
  });

  it('正常: gte / lte は数値と日付文字列の両方に効く', () => {
    expect(check('grandTotal', 'gte', 1100)).toBe(true);
    expect(check('grandTotal', 'gte', 1101)).toBe(false);
    expect(check('grandTotal', 'lte', 1100)).toBe(true);
    expect(check('grandTotal', 'lte', 1099)).toBe(false);
    expect(check('transactionDate', 'gte', '2026-09-01')).toBe(true);
    expect(check('transactionDate', 'lte', '2026-09-01')).toBe(false);
  });

  it('境界: gte / lte は数値と数字文字列を突き合わせられる。比較できない組は false', () => {
    expect(check('grandTotal', 'gte', '1000')).toBe(true);
    expect(check('grandTotal', 'gte', 'abc')).toBe(false);
    expect(check('issuerName', 'gte', 100)).toBe(false);
  });

  it('正常 / 境界: in は候補のいずれかと一致すれば真。空配列・非配列は false', () => {
    expect(check('paymentMethod', 'in', ['cash', 'credit_card'])).toBe(true);
    expect(check('paymentMethod', 'in', ['cash', 'qr'])).toBe(false);
    expect(check('paymentMethod', 'in', [])).toBe(false);
    expect(check('paymentMethod', 'in', 'credit_card')).toBe(false);
  });

  it('正常 / 境界: exists / notExists（空文字は「無い」側）', () => {
    expect(check('grandTotal', 'exists')).toBe(true);
    expect(check('issueDate', 'exists')).toBe(false);
    expect(check('issueDate', 'notExists')).toBe(true);
    expect(check('grandTotal', 'notExists')).toBe(false);
    expect(evaluateCondition({ issuerName: '' }, cond('issuerName', 'exists'))).toBe(false);
    expect(evaluateCondition({ issuerName: '' }, cond('issuerName', 'notExists'))).toBe(true);
  });

  it('正常: isTrue / isFalse は真偽値にだけ一致する', () => {
    expect(check('extra.taxable', 'isTrue')).toBe(true);
    expect(check('extra.taxable', 'isFalse')).toBe(false);
    expect(check('extra.flag', 'isFalse')).toBe(true);
    expect(check('extra.flag', 'isTrue')).toBe(false);
    // 文字列 'true' は真偽値ではない。
    expect(evaluateCondition({ extra: { s: 'true' } }, cond('extra.s', 'isTrue'))).toBe(false);
  });

  it('正常: `lines[]` はどれか 1 要素が満たせば真（any 意味論）', () => {
    expect(check('lines[].description', 'equals', 'ペン')).toBe(true);
    expect(check('lines[].description', 'equals', 'ノート')).toBe(true);
    expect(check('lines[].description', 'equals', '消しゴム')).toBe(false);
    expect(check('lines[].description', 'contains', 'ペ')).toBe(true);
    expect(check('lines[].amount', 'gte', 800)).toBe(true);
    expect(check('lines[].amount', 'gte', 801)).toBe(false);
  });

  it('境界: `lines[]` の notExists は全要素が空のときだけ真（any の裏返しにしない）', () => {
    expect(check('lines[].nope', 'notExists')).toBe(true);
    expect(check('lines[].description', 'notExists')).toBe(false);
    // 片方だけ欠けている場合は「全部空」ではないので偽。
    expect(evaluateCondition({ lines: [{ description: 'a', amount: 1 }, { description: '', amount: 2 }] }, cond('lines[].description', 'notExists'))).toBe(false);
  });

  it('正常: extra.<key> をルール条件に使える（ヒアリングの回答が条件になる）', () => {
    expect(check('extra.purpose', 'equals', 'internal-meeting')).toBe(true);
    expect(check('extra.purpose', 'equals', 'entertainment')).toBe(false);
    expect(check('extra.headcount', 'lte', 5)).toBe(true);
  });

  it('境界: 無いパスは（notExists 以外）すべて false — 例外にはしない', () => {
    for (const op of ['equals', 'contains', 'startsWith', 'endsWith', 'regex', 'between', 'gte', 'lte', 'in', 'isTrue', 'isFalse'] as const) {
      expect(check('missing', op, 'x')).toBe(false);
    }
    expect(check('missing', 'notExists')).toBe(true);
  });
});

describe('evaluateConditions', () => {
  it('正常: すべて満たせば真（AND）', () => {
    expect(evaluateConditions(facts, [cond('direction', 'equals', 'out'), cond('grandTotal', 'gte', 1000)])).toBe(true);
  });

  it('異常: 1 つでも満たさなければ偽', () => {
    expect(evaluateConditions(facts, [cond('direction', 'equals', 'out'), cond('grandTotal', 'gte', 5000)])).toBe(false);
  });

  it('境界: 空の条件列は真（scope だけで一致するルール）', () => {
    expect(evaluateConditions(facts, [])).toBe(true);
  });
});