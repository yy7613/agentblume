/**
 * ドメイン: 発行・消込の確定から作る仕訳の下書きの中身（docs/22 §6.3）。純関数。
 *
 * 科目 id・税区分コードはすべて設定（`settings.journal`）から取り、コードに書かない（仕訳のマスタを id で参照するだけ）。
 * 貸借一致は Matching / Invoice の不変条件から成り立つ（Σ配分 = 入金額 + 手数料、Σ税込対象額 = 請求額）。
 * 出所は仕訳側に専用の値が無いのでタグで示す（`receivables:invoice:<id>` / `receivables:matching:<id>`。ADR-0041 決定 5）。
 */
import { effectiveTransactionDate, type Invoice } from './invoice';
import type { ReceivablesSettings } from './settings';

export const RECEIVABLES_TAG = 'receivables';
export const invoiceTag = (invoiceId: string): string => `${RECEIVABLES_TAG}:invoice:${invoiceId}`;
export const matchingTag = (matchingId: string): string => `${RECEIVABLES_TAG}:matching:${matchingId}`;

export interface DraftJournalLine {
  readonly side: 'debit' | 'credit';
  readonly accountId: string;
  readonly taxCode: string;
  /** 税込整数、正。 */
  readonly amount: number;
  readonly taxAmount?: number;
  readonly partner?: string;
}

export interface DraftJournalEntry {
  readonly date: string;
  readonly description: string;
  readonly lines: readonly DraftJournalLine[];
  readonly tags: readonly string[];
}

/** 税込額に含まれる消費税（1 円未満切り捨て）。 */
export function taxIncludedFloor(amount: number, rate: number): number {
  if (rate <= 0) return 0;
  const numerator = amount * rate;
  const denominator = 100 + rate;
  return (numerator - (numerator % denominator)) / denominator;
}

/** 売上仕訳の日付（設定で取引日か発行日）。どちらかは発行済みの請求書に必ずある。 */
export function salesEntryDateOf(invoice: Pick<Invoice, 'issueDate' | 'transactionDate' | 'transactionPeriod'>, settings: Pick<ReceivablesSettings, 'journal'>): string {
  const transactionDate = effectiveTransactionDate(invoice);
  return settings.journal.salesEntryDate === 'issue-date'
    ? invoice.issueDate ?? transactionDate ?? ''
    : transactionDate ?? invoice.issueDate ?? '';
}

/** 発行 → 売上。対象額 0 の税率の行は作らない。 */
export function salesJournalEntry(invoice: Invoice, settings: Pick<ReceivablesSettings, 'journal'>, customerName: string): DraftJournalEntry {
  const { accounts, salesTaxCodes, nonTaxableTaxCode } = settings.journal;
  const credits: DraftJournalLine[] = invoice.totals.byRate
    .filter((entry) => entry.inclusive > 0)
    .map((entry) => ({
      side: 'credit' as const,
      accountId: accounts.sales,
      taxCode: salesTaxCodes[String(entry.rate) as '10' | '8' | '0'],
      amount: entry.inclusive,
      ...(entry.rate === 0 ? {} : { taxAmount: entry.tax }),
      partner: customerName,
    }));
  return {
    date: salesEntryDateOf(invoice, settings),
    description: `${invoice.number ?? ''} ${customerName}`.trim(),
    lines: [{ side: 'debit', accountId: accounts.receivable, taxCode: nonTaxableTaxCode, amount: invoice.totals.grandTotal, partner: customerName }, ...credits],
    tags: [RECEIVABLES_TAG, invoiceTag(invoice.id)],
  };
}

export interface ReceiptJournalInput {
  readonly transaction: { readonly date: string; readonly amount: number };
  readonly matching: { readonly id: string; readonly allocations: readonly { readonly invoiceId: string; readonly amount: number }[]; readonly feeAmount: number };
  /** 配分先の請求番号（摘要に並べる）。 */
  readonly invoiceNumbers: ReadonlyMap<string, string>;
  readonly customerName: string;
  readonly settings: Pick<ReceivablesSettings, 'journal'>;
  /** 手数料の税区分の税率（仕訳の税区分マスタから引く。分からなければ税額を付けない）。 */
  readonly feeTaxRate?: number;
}

/** 消込の確定 → 入金（手数料差額は支払手数料）。一部入金は配分額だけ売掛金を減らす。 */
export function receiptJournalEntry(input: ReceiptJournalInput): DraftJournalEntry {
  const { accounts, feeTaxCode, nonTaxableTaxCode } = input.settings.journal;
  const numbers = input.matching.allocations.map((allocation) => input.invoiceNumbers.get(allocation.invoiceId) ?? allocation.invoiceId);
  const debit: DraftJournalLine[] = [
    { side: 'debit', accountId: accounts.deposit, taxCode: nonTaxableTaxCode, amount: input.transaction.amount },
    ...(input.matching.feeAmount > 0
      ? [{
        side: 'debit' as const, accountId: accounts.fee, taxCode: feeTaxCode, amount: input.matching.feeAmount,
        ...(input.feeTaxRate === undefined || input.feeTaxRate <= 0 ? {} : { taxAmount: taxIncludedFloor(input.matching.feeAmount, input.feeTaxRate) }),
      }]
      : []),
  ];
  const credit: DraftJournalLine[] = input.matching.allocations.map((allocation) => ({
    side: 'credit', accountId: accounts.receivable, taxCode: nonTaxableTaxCode, amount: allocation.amount, partner: input.customerName,
  }));
  return {
    date: input.transaction.date,
    description: `入金 ${input.customerName} ${numbers.join(' ')}`.trim(),
    lines: [...debit, ...credit],
    tags: [RECEIVABLES_TAG, matchingTag(input.matching.id)],
  };
}
