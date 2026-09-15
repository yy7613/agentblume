import { describe, expect, it } from 'vitest';
import { itemKeyOf, matchKeys, payeeKeyOf, type ItemKey } from './duplicates';

describe('payeeKeyOf', () => {
  it('正常: 半角カナと全角カナが同じキーになる', () => {
    expect(payeeKeyOf('ｻﾝﾌﾟﾙｼｮｳﾃﾝ')).toBe(payeeKeyOf('サンプルショウテン'));
  });

  it('正常: 法人略号の有無が同じキーになる', () => {
    expect(payeeKeyOf('株式会社サンプル')).toBe(payeeKeyOf('サンプル'));
    expect(payeeKeyOf('(株)サンプル')).toBe(payeeKeyOf('サンプル'));
  });

  it('正常: 空白違い・大小文字違いが同じキーになる', () => {
    expect(payeeKeyOf('Sample  Shop')).toBe(payeeKeyOf('sampleshop'));
    expect(payeeKeyOf('サンプル　商店')).toBe(payeeKeyOf('サンプル商店'));
  });

  it('境界: 空・空白だけ・undefined は undefined', () => {
    expect(payeeKeyOf(undefined)).toBeUndefined();
    expect(payeeKeyOf('')).toBeUndefined();
    expect(payeeKeyOf('   ')).toBeUndefined();
  });
});

describe('itemKeyOf', () => {
  it('正常: 取引日・金額・支払先キー・費目・sha256 を持つ', () => {
    const key = itemKeyOf({ categoryId: 'taxi', facts: { transactionDate: '2026-09-10', amount: 1000, payeeName: '株式会社甲' } }, 'a'.repeat(64));
    expect(key).toEqual({ transactionDate: '2026-09-10', amount: 1000, payeeKey: payeeKeyOf('甲'), categoryId: 'taxi', receiptSha256: 'a'.repeat(64) });
  });

  it('境界: 無い値はキーに含めない', () => {
    expect(itemKeyOf({ facts: {} })).toEqual({});
  });
});

describe('matchKeys', () => {
  const base: ItemKey = { transactionDate: '2026-09-10', amount: 1000, payeeKey: payeeKeyOf('サンプル'), categoryId: 'taxi' };

  it('正常: 支払先・日付・金額が一致すれば strong', () => {
    expect(matchKeys(base, { ...base, payeeKey: payeeKeyOf('ｻﾝﾌﾟﾙ') })).toBe('strong');
  });

  it('異常: 1 円違いは別の取引', () => {
    // 金額の許容差を持つと別の取引を重複として差し戻してしまう
    expect(matchKeys(base, { ...base, amount: 1001 })).toBeUndefined();
  });

  it('異常: 支払先が両方あって違えば費目が同じでも一致しない', () => {
    expect(matchKeys(base, { ...base, payeeKey: 'other' })).toBeUndefined();
  });

  it('正常: 片方の支払先が空なら費目一致で weak', () => {
    const { payeeKey: _omit, ...noPayee } = base;
    expect(matchKeys(noPayee, base)).toBe('weak');
    expect(matchKeys(base, noPayee)).toBe('weak');
  });

  it('異常: 片方の支払先が空で費目が違えば一致しない', () => {
    const { payeeKey: _omit, ...noPayee } = base;
    expect(matchKeys(noPayee, { ...base, categoryId: 'meal' })).toBeUndefined();
  });

  it('境界: 片方の支払先が空で費目も無ければ一致しない', () => {
    expect(matchKeys({ transactionDate: '2026-09-10', amount: 1000 }, { transactionDate: '2026-09-10', amount: 1000 })).toBeUndefined();
  });

  it('境界: 日付か金額が無ければ比べない', () => {
    const { transactionDate: _d, ...noDate } = base;
    const { amount: _a, ...noAmount } = base;
    expect(matchKeys(noDate, noDate)).toBeUndefined();
    expect(matchKeys(noAmount, noAmount)).toBeUndefined();
  });

  it('異常: 日付が違えば一致しない', () => {
    expect(matchKeys(base, { ...base, transactionDate: '2026-09-11' })).toBeUndefined();
  });
});
