/**
 * application層: 入金の消込判定の実行（docs/22 §4.6 `JudgeTransactionsUseCase`）と、保存しない候補計算。
 *
 * 未入金請求・取引先・設定は**1 回ずつ読んで**全入金の判定に使う（入金ごとに読むと件数に比例して遅くなる）。
 * 同じ実行内で `decided` / `candidate` になった請求は、後続の入金の候補から外さない（まだ確定していないので）。
 * 代わりに同じ請求を推す入金が 2 件以上あれば、両方に `contendedBy` を付けて画面に「他にもあります」と出させ、
 * 一括確定の対象からも外す（どちらが正しいかは人にしか分からない）。
 */
import type { BankTransaction } from '../../domain/receivables/bank-transaction';
import { withMatchJudgment } from '../../domain/receivables/bank-transaction';
import type { Customer } from '../../domain/receivables/customer';
import { BankTransactionNotFoundError } from '../../domain/receivables/errors';
import { invoiceOutstanding, OPEN_INVOICE_STATUSES, type Invoice } from '../../domain/receivables/invoice';
import { judgeTransaction, type MatchJudgment, type OpenInvoiceView } from '../../domain/receivables/matching';
import type { BankTransactionRepository, CustomerRepository, InvoiceRepository, ReceivablesSettingsRepository } from '../../domain/receivables/repositories';
import { defaultReceivablesSettings, type ReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { settingsOrDefault } from './ports';

export interface MatchingContext {
  readonly settings: ReceivablesSettings;
  readonly customers: readonly Customer[];
  readonly openInvoices: readonly Invoice[];
  readonly views: readonly OpenInvoiceView[];
}

export interface MatchingReaders {
  readonly settings: ReceivablesSettingsRepository;
  readonly customers: CustomerRepository;
  readonly invoices: InvoiceRepository;
  readonly transactions: BankTransactionRepository;
}

export async function loadMatchingContext(readers: MatchingReaders, scope: TenantScope): Promise<MatchingContext> {
  const [{ settings }, customers, openInvoices] = await Promise.all([
    settingsOrDefault(readers.settings, scope, () => defaultReceivablesSettings()),
    readers.customers.list(scope),
    readers.invoices.list(scope, { statuses: OPEN_INVOICE_STATUSES }),
  ]);
  const views = openInvoices.flatMap((invoice) => invoice.customerId === undefined || invoice.issueDate === undefined ? [] : [{
    id: invoice.id, customerId: invoice.customerId, outstanding: invoiceOutstanding(invoice), issueDate: invoice.issueDate,
    ...(invoice.dueDate === undefined ? {} : { dueDate: invoice.dueDate }), status: invoice.status,
  }]);
  return { settings, customers, openInvoices, views };
}

export function judgeWith(context: MatchingContext, transaction: Pick<BankTransaction, 'amount' | 'date' | 'payerNameNorm'>): MatchJudgment {
  return judgeTransaction({ transaction, openInvoices: context.views, customers: context.customers, settings: context.settings });
}

export interface JudgeTransactionsResult {
  readonly judged: readonly { readonly transactionId: string; readonly stage: string; readonly reason: string; readonly contendedBy?: readonly string[] }[];
  readonly counts: { readonly decided: number; readonly candidate: number; readonly unmatched: number };
}

export class JudgeTransactionsUseCase {
  constructor(private readonly readers: MatchingReaders, private readonly now: () => Date = () => new Date()) {}

  async execute(input: { readonly scope: TenantScope; readonly transactionIds?: readonly string[] }): Promise<JudgeTransactionsResult> {
    const { scope } = input;
    const context = await loadMatchingContext(this.readers, scope);
    const targets = await this.readers.transactions.list(scope, { status: 'unmatched', ...(input.transactionIds === undefined ? {} : { ids: input.transactionIds }) });
    const judgments = targets.map((transaction) => ({ transaction, judgment: judgeWith(context, transaction) }));
    // 推しの請求 → それを推す入金。2 件以上なら競合。
    const backers = new Map<string, string[]>();
    for (const { transaction, judgment } of judgments) {
      if (judgment.stage === 'unmatched') continue;
      for (const invoiceId of judgment.candidates[0]?.invoiceIds ?? []) backers.set(invoiceId, [...(backers.get(invoiceId) ?? []), transaction.id]);
    }
    const at = this.now().toISOString();
    const judged: JudgeTransactionsResult['judged'][number][] = [];
    const counts = { decided: 0, candidate: 0, unmatched: 0 };
    for (const { transaction, judgment } of judgments) {
      const contendedBy = judgment.stage === 'unmatched' ? [] : [...new Set((judgment.candidates[0]?.invoiceIds ?? []).flatMap((invoiceId) => backers.get(invoiceId) ?? []))].filter((id) => id !== transaction.id);
      await this.readers.transactions.save(withMatchJudgment(transaction, { ...judgment, judgedAt: at, ...(contendedBy.length === 0 ? {} : { contendedBy }) }, at));
      counts[judgment.stage] += 1;
      judged.push({ transactionId: transaction.id, stage: judgment.stage, reason: judgment.reason, ...(contendedBy.length === 0 ? {} : { contendedBy }) });
    }
    return { judged, counts };
  }
}

/** 保存せずに 1 件の候補を計算する（配分を編集する画面用）。 */
export class MatchCandidatesUseCase {
  constructor(private readonly readers: MatchingReaders) {}
  async execute(scope: TenantScope, transactionId: string): Promise<{ readonly transaction: BankTransaction; readonly judgment: MatchJudgment; readonly invoices: readonly Invoice[] }> {
    const transaction = await this.readers.transactions.findById(scope, transactionId);
    if (transaction === null) throw new BankTransactionNotFoundError(`bank transaction not found: ${transactionId}`);
    const context = await loadMatchingContext(this.readers, scope);
    return { transaction, judgment: judgeWith(context, transaction), invoices: context.openInvoices };
  }
}
