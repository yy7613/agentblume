import { describe, expect, it } from 'vitest';
import {
  computeInvoiceTotals, lineAmountFromUnitPrice, perLineRoundedTax, roundDivide, sumByRate, taxForRate,
  type Pricing, type RoundingMode,
} from './invoice-tax';

describe('roundDivide（整数の丸め）', () => {
  it.each([
    ['floor', 70350, 100, 703], ['round-half-up', 70350, 100, 704], ['ceil', 70350, 100, 704],
    ['floor', 1050, 100, 10], ['round-half-up', 1050, 100, 11], ['ceil', 1050, 100, 11],
    ['floor', 1049, 100, 10], ['round-half-up', 1049, 100, 10], ['ceil', 1000, 100, 10],
    ['round-half-up', 0, 110, 0], ['ceil', 1, 110, 1],
  ] as const)('%s: %d / %d = %d', (mode, n, d, expected) => {
    expect(roundDivide(n, d, mode)).toBe(expected);
  });
});

describe('computeInvoiceTotals（税率ごとに 1 回）', () => {
  it('正常: §3.2 の例は 1 回の丸めで 703 円、明細ごとなら 702 円', () => {
    const lines = [{ amount: 1234, taxRate: 10 as const }, { amount: 2345, taxRate: 10 as const }, { amount: 3456, taxRate: 10 as const }];
    const { totals } = computeInvoiceTotals(lines, 'exclusive', 'floor');
    expect(totals).toEqual({ byRate: [{ rate: 10, taxable: 7035, tax: 703, inclusive: 7738 }], taxTotal: 703, grandTotal: 7738 });
    expect(perLineRoundedTax(lines, 10, 'exclusive', 'floor')).toBe(702);
  });

  it.each<[Pricing, RoundingMode, number, number, number]>([
    ['exclusive', 'floor', 105, 10, 115],
    ['exclusive', 'round-half-up', 105, 11, 116],
    ['exclusive', 'ceil', 105, 11, 116],
    ['inclusive', 'floor', 1000, 90, 1000],
    ['inclusive', 'round-half-up', 1000, 91, 1000],
    ['inclusive', 'ceil', 1000, 91, 1000],
    ['inclusive', 'floor', 1100, 100, 1100],
  ])('境界: %s × %s で 10%% の合計 %d → 税 %d / 税込 %d', (pricing, mode, sum, tax, inclusive) => {
    const { totals } = computeInvoiceTotals([{ amount: sum, taxRate: 10 }], pricing, mode);
    expect(totals.byRate[0]).toMatchObject({ tax, inclusive, taxable: inclusive - tax });
  });

  it('正常: 10% / 8% / 0% の混在は税率ごとに集計し、10 → 8 → 0 の順で返す', () => {
    const { totals } = computeInvoiceTotals([{ amount: 500, taxRate: 0 }, { amount: 1080, taxRate: 8 }, { amount: 1000, taxRate: 10 }], 'exclusive', 'floor');
    expect(totals.byRate.map((entry) => entry.rate)).toEqual([10, 8, 0]);
    expect(totals.byRate[2]).toEqual({ rate: 0, taxable: 500, tax: 0, inclusive: 500 });
    expect(totals).toMatchObject({ taxTotal: 186, grandTotal: 1100 + 1166 + 500 });
  });

  it('境界: 値引で税率の合計が 0 なら税額 0。負になる税率は計算せず返す', () => {
    expect(computeInvoiceTotals([{ amount: 1000, taxRate: 10 }, { amount: -1000, taxRate: 10 }], 'exclusive', 'floor').totals).toEqual({ byRate: [{ rate: 10, taxable: 0, tax: 0, inclusive: 0 }], taxTotal: 0, grandTotal: 0 });
    const negative = computeInvoiceTotals([{ amount: 100, taxRate: 8 }, { amount: -200, taxRate: 8 }, { amount: 100, taxRate: 10 }], 'exclusive', 'floor');
    expect(negative.negativeRates).toEqual([8]);
    expect(negative.totals.byRate.map((entry) => entry.rate)).toEqual([10]);
  });

  it('境界: 明細が無ければ空の集計。安全域の上限でも整数のまま計算できる', () => {
    expect(computeInvoiceTotals([], 'exclusive', 'floor').totals).toEqual({ byRate: [], taxTotal: 0, grandTotal: 0 });
    const big = computeInvoiceTotals(Array.from({ length: 200 }, () => ({ amount: 100_000_000_000, taxRate: 10 as const })), 'exclusive', 'ceil').totals;
    expect(big.taxTotal).toBe(2_000_000_000_000);
    expect(Number.isSafeInteger(big.grandTotal)).toBe(true);
  });

  it('正常: sumByRate は明細の無い税率を含めない。taxForRate は 0% なら 0', () => {
    expect([...sumByRate([{ amount: 10, taxRate: 8 }, { amount: 5, taxRate: 8 }])]).toEqual([[8, 15]]);
    expect(taxForRate(1000, 0, 'exclusive', 'ceil')).toBe(0);
  });

  it('正常: 明細ごとの丸めは値引行を負のまま丸める', () => {
    expect(perLineRoundedTax([{ amount: 1005, taxRate: 10 }, { amount: -1005, taxRate: 10 }, { amount: 999, taxRate: 8 }], 10, 'exclusive', 'floor')).toBe(0);
    expect(perLineRoundedTax([{ amount: -1005, taxRate: 10 }], 10, 'exclusive', 'floor')).toBe(-100);
  });
});

describe('lineAmountFromUnitPrice（単価 × 数量）', () => {
  it.each([
    [2, 500, 1000], [1.1, 1000, 1100], [1.5, 1000, 1500], [0.25, 4000, 1000], [3, -200, -600],
  ])('正常: %d × %d = %d（浮動小数の誤差を持ち込まない）', (quantity, unitPrice, expected) => {
    expect(lineAmountFromUnitPrice(quantity, unitPrice)).toBe(expected);
  });

  it.each([
    [3, 333.33], [1.5, 1001], [0.1234, 0.1234], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY],
  ])('異常: %d × %d は円未満が残るか扱えないので undefined（黙って丸めない）', (quantity, unitPrice) => {
    expect(lineAmountFromUnitPrice(quantity, unitPrice)).toBeUndefined();
  });
});
