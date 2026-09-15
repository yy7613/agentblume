/**
 * ドメイン: 請求書の税率別集計と端数処理（docs/22 §3.2 / ADR-0041 決定 4）。純関数・整数演算のみ。
 *
 * 国税庁 Q&A 問 57: 消費税額の 1 円未満の端数処理は**一の適格請求書につき税率ごとに 1 回**。
 * 明細ごとに丸めて合算してはならないので、税率ごとに明細金額を合計してから 1 回だけ丸める。
 *
 * 仕訳の `tax.ts` を再利用しないのは、あちらが「税込額からの切り捨て」専用で丸めモードを持たず、
 * 受け取った帳票（DocumentFacts）を入力に取るため（発行側は税抜 / 税込 × 丸めモードが要る）。
 * 浮動小数を使わないのは、10^12 円規模の除算で丸めの境界が 1 円ずれるのを避けるため。
 */

export const ROUNDING_MODES = ['floor', 'round-half-up', 'ceil'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const PRICING_MODES = ['exclusive', 'inclusive'] as const;
export type Pricing = (typeof PRICING_MODES)[number];

export const INVOICE_TAX_RATES = [10, 8, 0] as const;
export type InvoiceTaxRate = (typeof INVOICE_TAX_RATES)[number];

/** 安全域（`S_r × r` が Number.MAX_SAFE_INTEGER を超えないため）。 */
export const MAX_LINE_AMOUNT = 100_000_000_000;
export const MAX_INVOICE_LINES = 200;
export const MAX_GRAND_TOTAL = 1_000_000_000_000;

/** 税率 1 つぶんの集計。 */
export interface RateTotal {
  readonly rate: InvoiceTaxRate;
  /** 税抜の対象額。 */
  readonly taxable: number;
  readonly tax: number;
  /** 税込の対象額。 */
  readonly inclusive: number;
}

export interface InvoiceTotals {
  /** 明細がある税率だけ（10 → 8 → 0 の順）。 */
  readonly byRate: readonly RateTotal[];
  readonly taxTotal: number;
  readonly grandTotal: number;
}

export const EMPTY_TOTALS: InvoiceTotals = { byRate: [], taxTotal: 0, grandTotal: 0 };

/** 整数の割り算を丸めモードで丸める（n ≥ 0、d > 0）。 */
export function roundDivide(numerator: number, denominator: number, mode: RoundingMode): number {
  if (mode === 'round-half-up') {
    const doubled = 2 * numerator + denominator;
    const twice = 2 * denominator;
    return (doubled - (doubled % twice)) / twice;
  }
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  return mode === 'ceil' && remainder > 0 ? quotient + 1 : quotient;
}

/** 税率 r・対象合計 S の税額（税抜なら S×r/100、税込なら S×r/(100+r)）。 */
export function taxForRate(sum: number, rate: InvoiceTaxRate, pricing: Pricing, mode: RoundingMode): number {
  if (rate === 0) return 0;
  return roundDivide(sum * rate, pricing === 'exclusive' ? 100 : 100 + rate, mode);
}

/** 小数の桁数（`1.25` → 2）。指数表記は安全域の外なので扱わない。 */
function decimals(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * 単価 × 数量を整数円で返す。円未満が残るなら undefined（黙って丸めない。明細の丸めは税の端数処理ではない）。
 * 浮動小数の積（1.1 × 1000 = 1100.0000000000002）を避けるため、小数を整数に直してから掛ける。
 */
export function lineAmountFromUnitPrice(quantity: number, unitPrice: number): number | undefined {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return undefined;
  const qDigits = decimals(quantity);
  const uDigits = decimals(unitPrice);
  if (qDigits + uDigits > 6) return undefined;
  const qScaled = Math.round(quantity * 10 ** qDigits);
  const uScaled = Math.round(unitPrice * 10 ** uDigits);
  const product = qScaled * uScaled;
  const divisor = 10 ** (qDigits + uDigits);
  if (!Number.isSafeInteger(product) || product % divisor !== 0) return undefined;
  return product / divisor;
}

/** 集計に使える明細（金額と税率が確定しているもの）。 */
export interface TaxableLine {
  readonly amount: number;
  readonly taxRate: InvoiceTaxRate;
}

/** 税率ごとの対象合計（値引の負値を含む）。明細の無い税率は含めない。 */
export function sumByRate(lines: readonly TaxableLine[]): ReadonlyMap<InvoiceTaxRate, number> {
  const sums = new Map<InvoiceTaxRate, number>();
  for (const rate of INVOICE_TAX_RATES) {
    const matched = lines.filter((line) => line.taxRate === rate);
    if (matched.length > 0) sums.set(rate, matched.reduce((total, line) => total + line.amount, 0));
  }
  return sums;
}

/**
 * 税率別集計（§3.2 の表）。合計が負の税率は計算せず `negativeRates` に返す（呼び出し側が違反にする）。
 */
export function computeInvoiceTotals(lines: readonly TaxableLine[], pricing: Pricing, mode: RoundingMode): { readonly totals: InvoiceTotals; readonly negativeRates: readonly InvoiceTaxRate[] } {
  const byRate: RateTotal[] = [];
  const negativeRates: InvoiceTaxRate[] = [];
  for (const [rate, sum] of sumByRate(lines)) {
    if (sum < 0) { negativeRates.push(rate); continue; }
    const tax = taxForRate(sum, rate, pricing, mode);
    byRate.push(pricing === 'exclusive'
      ? { rate, taxable: sum, tax, inclusive: sum + tax }
      : { rate, taxable: sum - tax, tax, inclusive: sum });
  }
  return {
    totals: {
      byRate,
      taxTotal: byRate.reduce((total, entry) => total + entry.tax, 0),
      grandTotal: byRate.reduce((total, entry) => total + entry.inclusive, 0),
    },
    negativeRates,
  };
}

/** 明細ごとに丸めて合計した税額（§3.3 の P_r。違反の検出にだけ使う）。 */
export function perLineRoundedTax(lines: readonly TaxableLine[], rate: InvoiceTaxRate, pricing: Pricing, mode: RoundingMode): number {
  return lines
    .filter((line) => line.taxRate === rate)
    .reduce((total, line) => total + (line.amount < 0 ? -taxForRate(-line.amount, rate, pricing, mode) : taxForRate(line.amount, rate, pricing, mode)), 0);
}
