/**
 * application層: 入金消込の組込みツールが読む表（docs/22 §10）の行の組み立て。
 *
 * - `OutstandingInvoiceRowsProvider`（`receivables_outstanding`）: 未入金の請求 1 件 = 1 行。取引先名は**現在のマスタ**から引き、
 *   消えていれば発行時の写しを使う。
 * - `MatchCandidateRowsProvider`（`receivables_match_candidates`）: 未消込の入金ごとにその場で判定（保存しない）し、候補 1 件 = 1 行。
 *   候補の無い入金も候補列が null の 1 行を返す。
 * - `InvoiceDraftRowsProvider`（`receivables_invoice_draft`）: 添付を 1 枚ずつ読み、請求書案の明細 1 行 = 1 行（保存しない）。
 *
 * どれも読むだけで、請求・明細・取引先・仕訳を変えない（状態を変える操作は画面から人が押す。docs/20 §14.1）。
 * 設計書の `outstanding-rows.ts` / `match-candidate-rows.ts` / `invoice-draft-rows.ts` は同じ性質なのでここに寄せた。
 */
import type { Row } from '../../domain/data/types';
import { draftInvoiceFromOrder } from '../../domain/receivables/invoice-draft';
import { daysOverdue, invoiceOutstanding, OPEN_INVOICE_STATUSES, type Invoice } from '../../domain/receivables/invoice';
import type { MatchJudgment } from '../../domain/receivables/matching';
import { compareByDue } from '../../domain/receivables/matching';
import type {
  BankTransactionRepository, CustomerRepository, InvoiceRepository, MatchingRepository, ReceivablesSettingsRepository,
} from '../../domain/receivables/repositories';
import { defaultReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { judgeWith, loadMatchingContext, type MatchingReaders } from './judge-transactions';
import { localIsoDate, settingsOrDefault, type OrderDocumentReaderPort } from './ports';
import { matchReasonMessage } from './reason-messages';

export class OutstandingInvoiceRowsProvider {
  constructor(
    private readonly invoices: InvoiceRepository,
    private readonly customers: CustomerRepository,
    private readonly matchings: MatchingRepository,
    private readonly transactions: BankTransactionRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async rows(scope: TenantScope, options: { readonly limit?: number } = {}): Promise<readonly Row[]> {
    const today = localIsoDate(this.now());
    const [open, customers, matchings] = await Promise.all([
      this.invoices.list(scope, { statuses: OPEN_INVOICE_STATUSES }),
      this.customers.list(scope),
      this.matchings.list(scope, { status: 'confirmed' }),
    ]);
    const names = new Map(customers.map((customer) => [customer.id, customer.name]));
    const payments = await this.transactions.list(scope, { ids: [...new Set(matchings.map((matching) => matching.transactionId))] });
    const paidOn = new Map(payments.map((transaction) => [transaction.id, transaction.date]));
    const lastPayment = new Map<string, string>();
    for (const matching of matchings) {
      const date = paidOn.get(matching.transactionId) ?? matching.confirmedAt.slice(0, 10);
      for (const allocation of matching.allocations) {
        if ((lastPayment.get(allocation.invoiceId) ?? '') < date) lastPayment.set(allocation.invoiceId, date);
      }
    }
    const sorted = open
      .filter((invoice): invoice is Invoice & { customerId: string; issueDate: string; number: string } => invoice.customerId !== undefined && invoice.issueDate !== undefined && invoice.number !== undefined)
      .sort((left, right) => compareByDue({ ...left, outstanding: 0 }, { ...right, outstanding: 0 }));
    return sorted.slice(0, options.limit ?? sorted.length).map((invoice) => ({
      invoice_id: invoice.id,
      invoice_number: invoice.number,
      customer_id: invoice.customerId,
      customer_name: names.get(invoice.customerId) ?? invoice.snapshot?.customer.name ?? '',
      issue_date: invoice.issueDate,
      due_date: invoice.dueDate ?? null,
      grand_total: invoice.totals.grandTotal,
      paid_amount: invoice.paidAmount,
      outstanding_amount: invoiceOutstanding(invoice),
      days_overdue: daysOverdue(invoice, today),
      last_payment_date: lastPayment.get(invoice.id) ?? null,
      status: invoice.status,
      sales_entry_id: invoice.journal.salesEntryId ?? null,
    }));
  }
}

const EMPTY_CANDIDATE = {
  candidate_rank: null, invoice_ids: null, invoice_numbers: null, customer_id: null, customer_name: null,
  candidate_total: null, difference: null, fee_amount: null, combination_size: null, name_match: null, name_score: null,
};

export class MatchCandidateRowsProvider {
  constructor(private readonly readers: MatchingReaders) {}

  async rows(scope: TenantScope, options: { readonly limit?: number; readonly maxCandidates?: number } = {}): Promise<readonly Row[]> {
    const context = await loadMatchingContext(this.readers, scope);
    const transactions = await this.readers.transactions.list(scope, { status: 'unmatched', ...(options.limit === undefined ? {} : { limit: options.limit }) });
    const customerNames = new Map(context.customers.map((customer) => [customer.id, customer.name]));
    const numbers = new Map(context.openInvoices.map((invoice) => [invoice.id, invoice.number ?? invoice.id]));
    const rows: Row[] = [];
    for (const transaction of transactions) {
      const judgment: MatchJudgment = judgeWith(context, transaction);
      const base = {
        transaction_id: transaction.id, transaction_date: transaction.date, amount: transaction.amount, payer_name: transaction.payerName,
        stage: judgment.stage, reason: judgment.reason,
        reason_message: matchReasonMessage(judgment, {
          payerName: transaction.payerName, amount: transaction.amount,
          customerName: (id) => customerNames.get(id) ?? id, invoiceNumber: (id) => numbers.get(id) ?? id,
        }),
      };
      const candidates = judgment.candidates.slice(0, options.maxCandidates ?? judgment.candidates.length);
      if (candidates.length === 0) { rows.push({ ...base, ...EMPTY_CANDIDATE }); continue; }
      for (const candidate of candidates) {
        rows.push({
          ...base,
          candidate_rank: candidate.rank,
          invoice_ids: candidate.invoiceIds.join(','),
          invoice_numbers: candidate.invoiceIds.map((id) => numbers.get(id) ?? id).join(','),
          customer_id: candidate.customerId,
          customer_name: customerNames.get(candidate.customerId) ?? null,
          candidate_total: candidate.candidateTotal,
          difference: candidate.difference,
          fee_amount: candidate.feeAmount,
          combination_size: candidate.invoiceIds.length,
          name_match: candidate.nameMatch,
          name_score: candidate.nameScore,
        });
      }
    }
    return rows;
  }
}

export class InvoiceDraftRowsProvider {
  constructor(
    private readonly reader: OrderDocumentReaderPort,
    private readonly settings: ReceivablesSettingsRepository,
    private readonly customers: CustomerRepository,
  ) {}

  async rows(scope: TenantScope, attachments: readonly { readonly name: string; readonly dataUrl: string }[], options: { readonly limit?: number } = {}): Promise<readonly Row[]> {
    const targets = options.limit === undefined ? attachments : attachments.slice(0, options.limit);
    const [{ settings }, customers] = await Promise.all([settingsOrDefault(this.settings, scope, () => defaultReceivablesSettings()), this.customers.list(scope)]);
    const rows: Row[] = [];
    // 1 枚ずつ読む（別々の帳票を 1 回で読むと混ざる）。途中で失敗したらそのまま投げる（読めた分だけ返すと全部だと誤解される）。
    for (const attachment of targets) {
      const read = await this.reader.read({ image: attachment.dataUrl, fileName: attachment.name });
      const proposal = draftInvoiceFromOrder(read, settings, customers);
      const rate = (value: 10 | 8 | 0) => proposal.check.totals.byRate.find((entry) => entry.rate === value);
      const invoiceColumns = {
        file_name: attachment.name,
        customer_name: proposal.customerName ?? null,
        customer_id: proposal.customerId ?? null,
        transaction_date: proposal.content.transactionDate ?? null,
        due_date: proposal.content.dueDate ?? null,
        pricing: proposal.content.pricing,
        taxable_10: rate(10)?.taxable ?? 0,
        tax_10: rate(10)?.tax ?? 0,
        taxable_8: rate(8)?.taxable ?? 0,
        tax_8: rate(8)?.tax ?? 0,
        taxable_0: rate(0)?.taxable ?? 0,
        grand_total: proposal.check.totals.grandTotal,
        document_total: proposal.documentTotal ?? null,
        total_difference: proposal.documentTotal === undefined ? null : proposal.documentTotal - proposal.check.totals.grandTotal,
        violations: proposal.check.violations.map((issue) => issue.code).join(', '),
        warnings: [...proposal.check.warnings.map((issue) => issue.code), ...proposal.warnings].join(', '),
        draft_json: JSON.stringify({ ...proposal.content, ...(proposal.customerId === undefined && proposal.customerName !== undefined ? { customerNameHint: proposal.customerName } : {}) }),
      };
      if (proposal.content.lines.length === 0) {
        rows.push({ ...invoiceColumns, line_no: null, description: null, quantity: null, unit_price: null, amount: null, tax_rate: null });
        continue;
      }
      proposal.content.lines.forEach((line, index) => rows.push({
        ...invoiceColumns,
        line_no: index + 1,
        description: line.description === '' ? null : line.description,
        quantity: line.quantity ?? null,
        unit_price: line.unitPrice ?? null,
        amount: line.amount ?? null,
        tax_rate: line.taxRate ?? null,
      }));
    }
    return rows;
  }
}
