/**
 * ドメイン: 請求書の記載事項チェックと税額の検査（docs/22 §3.1〜§3.4）。純関数。
 *
 * `POST /receivables/invoices/check`（保存しない）・下書き保存（結果を返すだけ）・発行（違反があれば拒否）が同じ関数を呼ぶ。
 * 違反は 1 件でもあれば発行不可、警告は発行できるが確認を促す。文言は UI が code + params から組み立てる
 * （サーバーの英語の要約を画面の正本にしない）。
 *
 * 外から持ち込んだ下書きの申告税額（`declared`）は**値を補正しない**。発行する値は常に §3.2 の計算値で、
 * 差額と「明細ごとに丸めたらその値になる」ことを params に入れて人に見せる（仕訳の抽出整合チェックと同じ方針）。
 */
import { normalizeRegistrationNumber } from '../journal/normalize';
import type { InvoiceIssue } from './errors';
import { effectiveTransactionDate, resolveLineAmount, type InvoiceContent } from './invoice';
import {
  computeInvoiceTotals, MAX_GRAND_TOTAL, MAX_INVOICE_LINES, MAX_LINE_AMOUNT, perLineRoundedTax, ROUNDING_MODES,
  taxForRate, type InvoiceTaxRate, type InvoiceTotals, type RoundingMode, type TaxableLine,
} from './invoice-tax';
import type { ReceivablesSettings } from './settings';

export const INVOICE_VIOLATION_CODES = [
  'issuer-name-missing', 'issuer-registration-number-missing', 'issuer-registration-number-invalid', 'recipient-missing',
  'customer-disabled', 'issue-date-missing', 'transaction-date-missing', 'lines-empty', 'line-description-missing',
  'line-amount-missing', 'line-amount-not-integer', 'line-tax-rate-missing', 'rate-total-negative', 'grand-total-not-positive',
  'amount-out-of-range', 'per-line-rounding', 'declared-tax-mismatch', 'due-date-before-issue-date',
] as const;
export const INVOICE_WARNING_CODES = [
  'issuer-not-registered', 'rounding-mode-differs', 'declared-total-mismatch', 'zero-rate-lines', 'due-date-missing', 'transaction-date-after-issue-date',
] as const;
export type InvoiceViolationCode = (typeof INVOICE_VIOLATION_CODES)[number];
export type InvoiceWarningCode = (typeof INVOICE_WARNING_CODES)[number];

export interface InvoiceCheck {
  readonly totals: InvoiceTotals;
  readonly violations: readonly InvoiceIssue[];
  readonly warnings: readonly InvoiceIssue[];
}

/** 検査に要る取引先の部分。 */
export interface CheckCustomer {
  readonly name: string;
  readonly enabled: boolean;
}

export interface CheckInvoiceInput {
  readonly invoice: InvoiceContent;
  readonly settings: Pick<ReceivablesSettings, 'issuer' | 'rounding'>;
  /** 取引先が見つからない（未選択・削除済み）なら undefined。 */
  readonly customer: CheckCustomer | undefined;
  /** 丸めモードを明示するとき（既定は設定の現在値）。 */
  readonly roundingMode?: RoundingMode;
}

const issue = (code: string, params: Record<string, string | number> = {}, path?: string): InvoiceIssue => ({ code, ...(path === undefined ? {} : { path }), params });

/** 記載事項（発行者・宛名・日付）の検査。 */
function checkParties(input: CheckInvoiceInput, violations: InvoiceIssue[], warnings: InvoiceIssue[]): void {
  const { issuer } = input.settings;
  if (issuer.name.trim() === '') violations.push(issue('issuer-name-missing', {}, 'settings.issuer.name'));
  if (issuer.registered) {
    const raw = issuer.registrationNumber?.trim() ?? '';
    if (raw === '') violations.push(issue('issuer-registration-number-missing', {}, 'settings.issuer.registrationNumber'));
    else if (normalizeRegistrationNumber(raw) === undefined) {
      violations.push(issue('issuer-registration-number-invalid', { value: raw, digits: raw.replace(/\D/gu, '').length }, 'settings.issuer.registrationNumber'));
    }
  } else {
    warnings.push(issue('issuer-not-registered', {}, 'settings.issuer.registered'));
  }
  const { invoice, customer } = input;
  if (customer === undefined || customer.name.trim() === '') violations.push(issue('recipient-missing', {}, 'customerId'));
  else if (!customer.enabled) violations.push(issue('customer-disabled', { customer: customer.name }, 'customerId'));
  if (invoice.issueDate === undefined) violations.push(issue('issue-date-missing', {}, 'issueDate'));
  const transactionDate = effectiveTransactionDate(invoice);
  if (transactionDate === undefined) violations.push(issue('transaction-date-missing', {}, 'transactionDate'));
  if (invoice.dueDate === undefined) warnings.push(issue('due-date-missing', {}, 'dueDate'));
  else if (invoice.issueDate !== undefined && invoice.dueDate < invoice.issueDate) violations.push(issue('due-date-before-issue-date', { dueDate: invoice.dueDate, issueDate: invoice.issueDate }, 'dueDate'));
  if (transactionDate !== undefined && invoice.issueDate !== undefined && transactionDate > invoice.issueDate) {
    warnings.push(issue('transaction-date-after-issue-date', { transactionDate, issueDate: invoice.issueDate }, 'transactionDate'));
  }
}

/** 明細の検査。集計に使える明細を返す。 */
function checkLines(input: CheckInvoiceInput, violations: InvoiceIssue[], warnings: InvoiceIssue[]): { readonly lines: readonly TaxableLine[]; readonly indexOf: readonly number[] } {
  const { lines } = input.invoice;
  if (lines.length === 0) violations.push(issue('lines-empty', {}, 'lines'));
  if (lines.length > MAX_INVOICE_LINES) violations.push(issue('amount-out-of-range', { lines: lines.length, maxLines: MAX_INVOICE_LINES }, 'lines'));
  const taxable: TaxableLine[] = [];
  const indexOf: number[] = [];
  const zeroRateRows: number[] = [];
  lines.forEach((line, index) => {
    const row = index + 1;
    const path = `lines[${index}]`;
    if (line.description.trim() === '') violations.push(issue('line-description-missing', { row }, `${path}.description`));
    const amount = resolveLineAmount(line);
    if (amount === undefined) {
      if (line.amount === undefined && line.quantity !== undefined && line.unitPrice !== undefined) violations.push(issue('line-amount-not-integer', { row, quantity: line.quantity, unitPrice: line.unitPrice }, `${path}.amount`));
      else violations.push(issue('line-amount-missing', { row }, `${path}.amount`));
    } else if (Math.abs(amount) > MAX_LINE_AMOUNT) {
      violations.push(issue('amount-out-of-range', { row, amount, maxAmount: MAX_LINE_AMOUNT }, `${path}.amount`));
    }
    if (line.taxRate === undefined) violations.push(issue('line-tax-rate-missing', { row }, `${path}.taxRate`));
    else if (line.taxRate === 0 && line.zeroRateKind === undefined) zeroRateRows.push(row);
    if (amount !== undefined && line.taxRate !== undefined && Math.abs(amount) <= MAX_LINE_AMOUNT) {
      taxable.push({ amount, taxRate: line.taxRate });
      indexOf.push(index);
    }
  });
  if (zeroRateRows.length > 0) warnings.push(issue('zero-rate-lines', { rows: zeroRateRows.join(', '), row: zeroRateRows[0]! }, `lines[${zeroRateRows[0]! - 1}].zeroRateKind`));
  return { lines: taxable, indexOf };
}

/** 申告税額との突き合わせ（§3.3）。 */
function checkDeclared(input: CheckInvoiceInput, mode: RoundingMode, taxable: { readonly lines: readonly TaxableLine[]; readonly indexOf: readonly number[] }, totals: InvoiceTotals, violations: InvoiceIssue[], warnings: InvoiceIssue[]): void {
  const declared = input.invoice.declared;
  if (declared === undefined) return;
  const { pricing } = input.invoice;
  const flagged = new Set<InvoiceTaxRate>();
  const computedTax = (rate: InvoiceTaxRate) => totals.byRate.find((entry) => entry.rate === rate)?.tax ?? 0;

  if (declared.lineTaxAmounts !== undefined) {
    for (const rate of [10, 8] as const) {
      const declaredForRate = taxable.lines
        .map((line, position) => ({ line, lineTax: declared.lineTaxAmounts?.[taxable.indexOf[position]!] }))
        .filter((entry) => entry.line.taxRate === rate && entry.lineTax !== undefined && entry.lineTax !== null);
      if (declaredForRate.length === 0) continue;
      const declaredTax = declaredForRate.reduce((total, entry) => total + (entry.lineTax as number), 0);
      const once = computedTax(rate);
      if (declaredTax === once) continue;
      const perLine = perLineRoundedTax(taxable.lines, rate, pricing, mode);
      flagged.add(rate);
      violations.push(declaredTax === perLine
        ? issue('per-line-rounding', { rate, declared: declaredTax, perLine, once, difference: declaredTax - once }, 'totals')
        : issue('declared-tax-mismatch', { rate, declared: declaredTax, computed: once, difference: declaredTax - once }, 'totals'));
    }
  }

  for (const entry of declared.taxByRate ?? []) {
    if (entry.rate === 0 || flagged.has(entry.rate)) continue;
    const computed = computedTax(entry.rate);
    if (entry.taxAmount === computed) continue;
    const sum = taxable.lines.filter((line) => line.taxRate === entry.rate).reduce((total, line) => total + line.amount, 0);
    const matchingMode = Math.abs(entry.taxAmount - computed) === 1 && sum >= 0
      ? ROUNDING_MODES.find((other) => other !== mode && taxForRate(sum, entry.rate, pricing, other) === entry.taxAmount)
      : undefined;
    if (matchingMode !== undefined) warnings.push(issue('rounding-mode-differs', { rate: entry.rate, declared: entry.taxAmount, computed, mode: matchingMode, currentMode: mode }, 'settings.rounding.mode'));
    else violations.push(issue('declared-tax-mismatch', { rate: entry.rate, declared: entry.taxAmount, computed, difference: entry.taxAmount - computed }, 'totals'));
  }

  if (declared.grandTotal !== undefined && declared.grandTotal !== totals.grandTotal) {
    warnings.push(issue('declared-total-mismatch', { declared: declared.grandTotal, computed: totals.grandTotal, difference: declared.grandTotal - totals.grandTotal }, 'lines'));
  }
}

/** 記載事項と税額を検査し、集計を返す。 */
export function checkInvoice(input: CheckInvoiceInput): InvoiceCheck {
  const violations: InvoiceIssue[] = [];
  const warnings: InvoiceIssue[] = [];
  const mode = input.roundingMode ?? input.settings.rounding.mode;
  checkParties(input, violations, warnings);
  const taxable = checkLines(input, violations, warnings);
  const { totals, negativeRates } = computeInvoiceTotals(taxable.lines, input.invoice.pricing, mode);
  for (const rate of negativeRates) violations.push(issue('rate-total-negative', { rate }, 'lines'));
  if (input.invoice.lines.length > 0 && totals.grandTotal <= 0 && negativeRates.length === 0) violations.push(issue('grand-total-not-positive', { grandTotal: totals.grandTotal }, 'lines'));
  if (totals.grandTotal > MAX_GRAND_TOTAL) violations.push(issue('amount-out-of-range', { grandTotal: totals.grandTotal, maxGrandTotal: MAX_GRAND_TOTAL }, 'lines'));
  checkDeclared(input, mode, taxable, totals, violations, warnings);
  return { totals, violations, warnings };
}
