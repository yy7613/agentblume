import { describe, expect, it } from 'vitest';
import { resolveInvoiceStatus, splitTotalsByRate, taxAmountFromInclusive, taxCodeForTransitional, transitionalDeductionRate } from './tax';

describe('transitionalDeductionRate', () => {
  it('境界: 経過措置の切替日（前日は旧割合、当日から新割合）', () => {
    expect(transitionalDeductionRate('2023-09-30')).toBe(1);
    expect(transitionalDeductionRate('2023-10-01')).toBe(0.8);
    expect(transitionalDeductionRate('2026-09-30')).toBe(0.8);
    expect(transitionalDeductionRate('2026-10-01')).toBe(0.7);
    expect(transitionalDeductionRate('2028-09-30')).toBe(0.7);
    expect(transitionalDeductionRate('2028-10-01')).toBe(0.5);
    expect(transitionalDeductionRate('2030-09-30')).toBe(0.5);
    expect(transitionalDeductionRate('2030-10-01')).toBe(0.3);
    expect(transitionalDeductionRate('2031-09-30')).toBe(0.3);
    expect(transitionalDeductionRate('2031-10-01')).toBe(0);
  });
});

describe('taxCodeForTransitional', () => {
  it('正常: 控除割合 → 税区分コード', () => {
    expect(taxCodeForTransitional(1)).toBe('JP-IN-10-S');
    expect(taxCodeForTransitional(0.8)).toBe('JP-IN-10-S-D80');
    expect(taxCodeForTransitional(0.7)).toBe('JP-IN-10-S-D70');
    expect(taxCodeForTransitional(0.5)).toBe('JP-IN-10-S-D50');
    expect(taxCodeForTransitional(0.3)).toBe('JP-IN-10-S-D30');
    expect(taxCodeForTransitional(0)).toBe('JP-IN-10-S-D0');
  });
});

describe('resolveInvoiceStatus', () => {
  it('正常: 収入は not_required、登録番号ありは qualified', () => {
    expect(resolveInvoiceStatus({ direction: 'in' })).toBe('not_required');
    expect(resolveInvoiceStatus({ direction: 'out', registrationNumber: 'T1234567890123' })).toBe('qualified');
  });

  it('正常: 登録番号なしは取引日の経過措置で transitional / none', () => {
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2026-09-13' })).toBe('transitional');
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2031-10-01' })).toBe('none');
  });

  it('境界: 取引日が無ければ today、それも無ければ transitional 側へ倒す。direction 未指定は支出扱い', () => {
    expect(resolveInvoiceStatus({}, '2032-01-01')).toBe('none');
    expect(resolveInvoiceStatus({})).toBe('transitional');
  });
});

describe('taxAmountFromInclusive', () => {
  it('正常: 税込金額から切り捨てで税額を出す', () => {
    expect(taxAmountFromInclusive(1100, 10)).toBe(100);
    expect(taxAmountFromInclusive(1080, 8)).toBe(80);
    expect(taxAmountFromInclusive(1000, 10)).toBe(90);
  });

  it('境界: 0% / 負の金額 / 非数', () => {
    expect(taxAmountFromInclusive(1000, 0)).toBe(0);
    expect(taxAmountFromInclusive(-1100, 10)).toBe(-100);
    expect(taxAmountFromInclusive(Number.NaN, 10)).toBe(0);
  });
});

describe('splitTotalsByRate', () => {
  it('正常: totalsByRate（税込）を優先し、税額欄が無ければ計算する', () => {
    expect(splitTotalsByRate({ grandTotal: 2180, totalsByRate: [{ rate: 10, taxableAmount: 1100, taxAmount: 100, amountIncludesTax: true }, { rate: 8, taxableAmount: 1080, amountIncludesTax: true }] }))
      .toEqual({ taxable10: 1100, tax10: 100, taxable8: 1080, tax8: 80, taxable0: 0 });
  });

  it('正常: 税抜の集計欄は税額を足して税込にする', () => {
    expect(splitTotalsByRate({ totalsByRate: [{ rate: 10, taxableAmount: 1000, amountIncludesTax: false }] })).toEqual({ taxable10: 1100, tax10: 100, taxable8: 0, tax8: 0, taxable0: 0 });
  });

  it('正常: 集計欄が無ければ明細の税率、それも無ければ全額 10%', () => {
    expect(splitTotalsByRate({ lines: [{ description: 'a', amount: 1100, taxRate: 10 }, { description: 'b', amount: 540, reducedRateMark: true }] })).toEqual({ taxable10: 1100, tax10: 100, taxable8: 540, tax8: 40, taxable0: 0 });
    expect(splitTotalsByRate({ grandTotal: 3300 })).toEqual({ taxable10: 3300, tax10: 300, taxable8: 0, tax8: 0, taxable0: 0 });
  });

  it('境界: 0% の集計は taxable0 に入り、金額が無ければ全部 0', () => {
    expect(splitTotalsByRate({ totalsByRate: [{ rate: 0, taxableAmount: 500, amountIncludesTax: true }] })).toEqual({ taxable10: 0, tax10: 0, taxable8: 0, tax8: 0, taxable0: 500 });
    expect(splitTotalsByRate({})).toEqual({ taxable10: 0, tax10: 0, taxable8: 0, tax8: 0, taxable0: 0 });
  });
});

describe('resolveInvoiceStatus（登録番号を載せない帳票）', () => {
  it('正常: 銀行明細・カード明細の支出は、登録番号が無くても経過措置にせず not_required にする', () => {
    // 銀行 CSV の行には登録番号が載らない。ここを transitional にすると通常の支払いが一律 80% 控除で出力されてしまう。
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2026-09-02', kind: 'bank_statement' })).toBe('not_required');
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2026-09-02', kind: 'card_statement' })).toBe('not_required');
  });

  it('正常: 請求書・レシートは従来どおり、登録番号が無ければ取引日で経過措置を判定する', () => {
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2026-09-30', kind: 'invoice' })).toBe('transitional');
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2026-10-01', kind: 'simplified_invoice' })).toBe('transitional');
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2031-10-01', kind: 'invoice' })).toBe('none');
  });

  it('境界: 登録番号があれば帳票種別によらず qualified', () => {
    expect(resolveInvoiceStatus({ direction: 'out', registrationNumber: 'T1234567890123', kind: 'bank_statement' })).toBe('qualified');
  });

  it('異常: 帳票種別が不明（kind 未指定）なら従来どおり取引日で判定する', () => {
    expect(resolveInvoiceStatus({ direction: 'out', transactionDate: '2026-09-02' })).toBe('transitional');
  });
});

describe('tax（壊れた入力の扱い）', () => {
  it('例外: 日付として解釈できない文字列でも throw しない', () => {
    expect(() => transitionalDeductionRate('not-a-date')).not.toThrow();
    expect(() => transitionalDeductionRate('')).not.toThrow();
  });

  it('例外: 金額や税率が NaN・負数・0 でも throw しない', () => {
    expect(() => taxAmountFromInclusive(Number.NaN, 10)).not.toThrow();
    expect(() => taxAmountFromInclusive(-1100, 10)).not.toThrow();
    expect(() => taxAmountFromInclusive(1100, 0)).not.toThrow();
    expect(() => taxCodeForTransitional(Number.NaN)).not.toThrow();
  });

  it('例外: 事実が空でも税率別の内訳を取り出せる（throw しない）', () => {
    expect(() => splitTotalsByRate({})).not.toThrow();
  });
});
