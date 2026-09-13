/**
 * ドメイン: 消費税まわりの決定的な計算（純関数）。
 *
 * - 適格請求書等保存方式の経過措置（免税事業者等からの仕入の控除割合）は取引日で決まる定数表。
 * - インボイス区分は「登録番号の有無 × 取引日 × 収入/支出」から決める。
 * - 税額は税込金額から切り捨てで求める（帳票に税額欄があればそちらを優先するのは呼び出し側）。
 */
import type { Direction, DocumentFacts, DocumentKind, InvoiceStatus } from './document';

/** 経過措置の控除割合（docs/20 §4）。上限日を含む。 */
export const TRANSITIONAL_DEDUCTION_TABLE: readonly { readonly until: string; readonly rate: number }[] = [
  { until: '2023-09-30', rate: 1 },
  { until: '2026-09-30', rate: 0.8 },
  { until: '2028-09-30', rate: 0.7 },
  { until: '2030-09-30', rate: 0.5 },
  { until: '2031-09-30', rate: 0.3 },
];

/**
 * 取引日における免税事業者等からの仕入の控除割合。
 * 2023-09-30 以前は制度開始前なので全額（1）。2031-10-01 以後は控除なし（0）。
 */
export function transitionalDeductionRate(transactionDate: string): number {
  for (const { until, rate } of TRANSITIONAL_DEDUCTION_TABLE) if (transactionDate <= until) return rate;
  return 0;
}

/** 控除割合 → 課税仕入の税区分コード（`default-chart.ts` の seed と対応）。 */
export function taxCodeForTransitional(rate: number): string {
  if (rate >= 1) return 'JP-IN-10-S';
  if (rate >= 0.8) return 'JP-IN-10-S-D80';
  if (rate >= 0.7) return 'JP-IN-10-S-D70';
  if (rate >= 0.5) return 'JP-IN-10-S-D50';
  if (rate >= 0.3) return 'JP-IN-10-S-D30';
  return 'JP-IN-10-S-D0';
}

export interface ResolveInvoiceStatusInput {
  readonly registrationNumber?: string;
  readonly transactionDate?: string;
  readonly direction?: Direction;
  /** 帳票種別。登録番号を載せない帳票（銀行・カード明細など）を経過措置と誤判定しないために見る。 */
  readonly kind?: DocumentKind;
}

/**
 * そもそも登録番号を載せない帳票。番号が無くても「免税事業者からの仕入」とは限らないので、
 * インボイス区分は元の証憑（請求書・レシート）側で決める＝ここでは not_required にする。
 */
const KINDS_WITHOUT_REGISTRATION_NUMBER: ReadonlySet<DocumentKind> = new Set(['bank_statement', 'card_statement', 'payslip', 'slip_transfer', 'slip_cash_in', 'slip_cash_out', 'other', 'unknown']);

/**
 * インボイス区分。収入（自分が発行する側）は `not_required`。支出は登録番号があれば `qualified`、
 * 無ければ取引日の経過措置で `transitional`（控除割合 > 0）か `none`（控除なし）。
 * 取引日が無いときは `today`（省略時は判定不能なので `transitional` 側へ倒す）で決める。
 */
export function resolveInvoiceStatus(input: ResolveInvoiceStatusInput, today?: string): InvoiceStatus {
  if (input.direction === 'in') return 'not_required';
  if (input.registrationNumber !== undefined && input.registrationNumber.length > 0) return 'qualified';
  if (input.kind !== undefined && KINDS_WITHOUT_REGISTRATION_NUMBER.has(input.kind)) return 'not_required';
  const date = input.transactionDate ?? today;
  if (date === undefined) return 'transitional';
  return transitionalDeductionRate(date) > 0 ? 'transitional' : 'none';
}

/** 税込金額に含まれる税額（切り捨て）。rate は % 表記（10 / 8）。 */
export function taxAmountFromInclusive(amount: number, rate: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || rate <= 0) return 0;
  const sign = amount < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(amount) * rate) / (100 + rate));
}

export interface TotalsSplit {
  /** 10% 対象の税込金額。 */
  readonly taxable10: number;
  /** 8%（軽減）対象の税込金額。 */
  readonly taxable8: number;
  readonly tax10: number;
  readonly tax8: number;
  /** 非課税・不課税（0%）の金額。 */
  readonly taxable0: number;
}

/**
 * facts から税率別の税込金額と税額を求める。
 * 優先順位: `totalsByRate`（帳票の税率別集計欄）→ `lines[].taxRate` → 全額 10%。
 * `amountIncludesTax: false` の集計は税抜なので税額を足して税込にする。
 */
export function splitTotalsByRate(facts: DocumentFacts): TotalsSplit {
  const split = { taxable10: 0, taxable8: 0, tax10: 0, tax8: 0, taxable0: 0 };
  const add = (rate: number, inclusive: number, tax: number): void => {
    if (rate === 10) { split.taxable10 += inclusive; split.tax10 += tax; }
    else if (rate === 8) { split.taxable8 += inclusive; split.tax8 += tax; }
    else split.taxable0 += inclusive;
  };
  if (facts.totalsByRate !== undefined && facts.totalsByRate.length > 0) {
    for (const entry of facts.totalsByRate) {
      if (entry.amountIncludesTax) {
        add(entry.rate, entry.taxableAmount, entry.taxAmount ?? taxAmountFromInclusive(entry.taxableAmount, entry.rate));
      } else {
        const tax = entry.taxAmount ?? Math.floor((entry.taxableAmount * entry.rate) / 100);
        add(entry.rate, entry.taxableAmount + tax, tax);
      }
    }
    return split;
  }
  if (facts.lines !== undefined && facts.lines.length > 0 && facts.lines.some((line) => line.taxRate !== undefined)) {
    for (const line of facts.lines) {
      const rate = line.taxRate ?? (line.reducedRateMark === true ? 8 : 10);
      add(rate, line.amount, taxAmountFromInclusive(line.amount, rate));
    }
    return split;
  }
  const total = facts.grandTotal ?? 0;
  add(10, total, taxAmountFromInclusive(total, 10));
  return split;
}
