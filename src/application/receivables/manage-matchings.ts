/**
 * application層: 消込の確定・一括確定・取消・対象外（docs/22 §4.5 / §4.6）。
 *
 * ## 確定は 1 トランザクション
 *
 * 前提チェック → 消込の記録 → 明細を消込済みに → 請求の入金額と状態 →（選ばれていれば）名義の学習 → 入金仕訳の下書き を
 * 同じ UnitOfWork で行う。科目が無ければ確定ごと巻き戻す。
 *
 * ## 楽観的な同時更新の検出
 *
 * 画面は判定の時点の各請求の残高を `expectedOutstanding` として送る。UoW 内で読み直した残高と違えば
 * `invoice-outstanding-changed`（別の入金が先に確定された）で断り、画面は「再判定」ボタンを出す。
 *
 * ## 一括確定は 1 件ずつ
 *
 * `decided` かつ競合の無い明細だけを 1 件ずつ別の UoW で確定し、途中の失敗は結果に積んで続ける（再実行で残りだけ確定される）。
 */
import { randomUUID } from 'node:crypto';
import {
  ignoreTransaction, markTransactionMatched, markTransactionUnmatched, unignoreTransaction, type BankTransaction, type BankTransactionStatus,
} from '../../domain/receivables/bank-transaction';
import { learnPayerAlias, removePayerAlias } from '../../domain/receivables/customer';
import {
  BankTransactionNotFoundError, CustomerNotFoundError, InvoiceNotFoundError, MatchingNotFoundError, ReceivablesStateError,
} from '../../domain/receivables/errors';
import { applyInvoicePayment, invoiceOutstanding, OPEN_INVOICE_STATUSES, revertInvoicePayment } from '../../domain/receivables/invoice';
import { receiptJournalEntry } from '../../domain/receivables/journal-lines';
import type { MatchCandidate } from '../../domain/receivables/matching';
import { allocationSumMatches, cancelMatching, createMatching, type Matching, type MatchingStatus } from '../../domain/receivables/matching-aggregate';
import { normalizePayerName } from '../../domain/receivables/payer-name';
import type {
  BankTransactionRepository, CustomerRepository, InvoiceRepository, MatchingRepository, ReceivablesSettingsRepository,
} from '../../domain/receivables/repositories';
import { defaultReceivablesSettings, HARD_MAX_COMBINATION_SIZE } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { assertJournalLink, settingsOrDefault, type JournalDraftSink, type JournalFollowUp } from './ports';

export interface MatchingDependencies {
  readonly settings: ReceivablesSettingsRepository;
  readonly customers: CustomerRepository;
  readonly invoices: InvoiceRepository;
  readonly transactions: BankTransactionRepository;
  readonly matchings: MatchingRepository;
  readonly journal: JournalDraftSink;
  readonly unitOfWork: UnitOfWorkPort;
  readonly makeId?: () => string;
  readonly now?: () => Date;
}

export interface ConfirmMatchingInput {
  readonly scope: TenantScope;
  readonly transactionId: string;
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: number }[];
  readonly feeAmount: number;
  /** 判定の時点の請求残高（invoiceId → 残高）。 */
  readonly expectedOutstanding?: Readonly<Record<string, number>>;
  /** この確定で振込名義を取引先の別名として覚える。 */
  readonly learnAlias?: { readonly customerId: string };
}

export interface ConfirmMatchingResult {
  readonly matching: Matching;
  readonly journal: { readonly status: 'created' | 'updated' | 'kept' | 'disabled'; readonly entryId?: string };
  readonly journalFollowUp?: JournalFollowUp;
  readonly learnedAlias?: { readonly customerId: string; readonly aliasId: string; readonly created: boolean };
}

/** 候補の配分と判定時点の残高（単独の請求なら候補の残高合計、合算なら各配分 = 残高）。 */
export function expectedOutstandingOf(candidate: MatchCandidate): Readonly<Record<string, number>> {
  return candidate.invoiceIds.length === 1
    ? { [candidate.invoiceIds[0]!]: candidate.candidateTotal }
    : Object.fromEntries(candidate.allocations.map((allocation) => [allocation.invoiceId, allocation.amount]));
}

function sameAllocations(left: readonly { invoiceId: string; amount: number }[], right: readonly { invoiceId: string; amount: number }[]): boolean {
  const key = (list: readonly { invoiceId: string; amount: number }[]) => list.map((entry) => `${entry.invoiceId}:${entry.amount}`).sort().join('|');
  return key(left) === key(right);
}

export class ConfirmMatchingUseCase {
  private readonly makeId: () => string;
  private readonly now: () => Date;
  constructor(private readonly deps: MatchingDependencies) {
    this.makeId = deps.makeId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(input: ConfirmMatchingInput): Promise<ConfirmMatchingResult> {
    const { scope } = input;
    return this.deps.unitOfWork.withTransaction(async () => {
      const transaction = await this.deps.transactions.findById(scope, input.transactionId);
      if (transaction === null) throw new BankTransactionNotFoundError(`bank transaction not found: ${input.transactionId}`);
      if (transaction.status !== 'unmatched') throw new ReceivablesStateError('transaction-not-unmatched', `bank transaction ${transaction.id} is already ${transaction.status}`, { transactionId: transaction.id });
      const { settings } = await settingsOrDefault(this.deps.settings, scope, () => defaultReceivablesSettings());
      if (input.allocations.length === 0 || input.allocations.length > HARD_MAX_COMBINATION_SIZE) throw new ReceivablesStateError('allocation-sum-mismatch', `allocations must have 1 to ${HARD_MAX_COMBINATION_SIZE} invoices`);
      const invoices = await this.deps.invoices.findByIds(scope, input.allocations.map((allocation) => allocation.invoiceId));
      const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
      for (const allocation of input.allocations) {
        const invoice = byId.get(allocation.invoiceId);
        if (invoice === undefined) throw new InvoiceNotFoundError(`invoice not found: ${allocation.invoiceId}`);
        if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) throw new ReceivablesStateError('invoice-outstanding-changed', `invoice ${invoice.number ?? invoice.id} is ${invoice.status}`, { invoiceId: invoice.id });
        const outstanding = invoiceOutstanding(invoice);
        const expected = input.expectedOutstanding?.[invoice.id];
        if (expected !== undefined && expected !== outstanding) throw new ReceivablesStateError('invoice-outstanding-changed', `the outstanding of invoice ${invoice.number} changed from ${expected} to ${outstanding}; judge again`, { invoiceId: invoice.id, expected, outstanding });
        if (allocation.amount > outstanding) throw new ReceivablesStateError('allocation-exceeds-outstanding', `allocation ${allocation.amount} exceeds the outstanding ${outstanding} of invoice ${invoice.number}`, { invoiceId: invoice.id, outstanding, amount: allocation.amount });
      }
      if (!Number.isSafeInteger(input.feeAmount) || input.feeAmount < 0 || !allocationSumMatches(input.allocations, transaction.amount, input.feeAmount)) {
        const total = input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
        throw new ReceivablesStateError('allocation-sum-mismatch', `allocations (${total}) minus the fee (${input.feeAmount}) must equal the deposit (${transaction.amount})`, { total, fee: input.feeAmount, amount: transaction.amount });
      }
      const { min, max } = settings.matching.feeTolerance;
      if (input.feeAmount > 0 && (input.feeAmount < min || input.feeAmount > max)) throw new ReceivablesStateError('fee-out-of-tolerance', `fee ${input.feeAmount} is outside the tolerance ${min}..${max}`, { fee: input.feeAmount, min, max });

      const at = this.now().toISOString();
      const matchingId = this.makeId();
      const customerIds = [...new Set(invoices.map((invoice) => invoice.customerId).filter((id): id is string => id !== undefined))];
      const customerId = customerIds.length === 1 ? customerIds[0] : undefined;
      const customer = customerId === undefined ? null : await this.deps.customers.findById(scope, customerId);

      let learnedAlias: ConfirmMatchingResult['learnedAlias'];
      if (input.learnAlias !== undefined && normalizePayerName(transaction.payerName) !== '') {
        const target = await this.deps.customers.findById(scope, input.learnAlias.customerId);
        if (target === null) throw new CustomerNotFoundError(`customer not found: ${input.learnAlias.customerId}`);
        const learned = learnPayerAlias(target, { text: transaction.payerName, aliasId: this.makeId(), matchingId, at });
        await this.deps.customers.save(learned.customer);
        learnedAlias = { customerId: target.id, aliasId: learned.aliasId, created: learned.created };
      }

      for (const allocation of input.allocations) await this.deps.invoices.save(applyInvoicePayment(byId.get(allocation.invoiceId)!, allocation.amount, at));
      await this.deps.transactions.save(markTransactionMatched(transaction, matchingId, at));

      const judged = transaction.judgment?.candidates[0];
      const decidedBy = judged !== undefined && judged.feeAmount === input.feeAmount && sameAllocations(judged.allocations, input.allocations) ? 'judgment' : 'manual';
      let journal: ConfirmMatchingResult['journal'] = { status: 'disabled' };
      let followUp: JournalFollowUp | undefined;
      if (settings.journal.enabled) {
        const fee = input.feeAmount > 0;
        await assertJournalLink(this.deps.journal, scope, settings, {
          accountPaths: ['journal.accounts.deposit', 'journal.accounts.receivable', ...(fee ? ['journal.accounts.fee'] : [])],
          taxPaths: ['journal.nonTaxableTaxCode', ...(fee ? ['journal.feeTaxCode'] : [])],
        });
        const feeTaxRate = fee ? await this.deps.journal.taxRateOf(scope, settings.journal.feeTaxCode) : undefined;
        const result = await this.deps.journal.upsertDraft(scope, receiptJournalEntry({
          transaction, matching: { id: matchingId, allocations: input.allocations, feeAmount: input.feeAmount },
          invoiceNumbers: new Map(invoices.map((invoice) => [invoice.id, invoice.number ?? invoice.id])),
          customerName: customer?.name ?? invoices[0]?.snapshot?.customer.name ?? transaction.payerName,
          settings, ...(feeTaxRate === undefined ? {} : { feeTaxRate }),
        }));
        journal = { status: result.status, entryId: result.entryId };
        if (result.status === 'kept') followUp = { entryId: result.entryId, action: 'review', entryStatus: result.entryStatus };
      }

      const matching = createMatching({
        tenant: scope, id: matchingId, transactionId: transaction.id, transactionAmount: transaction.amount,
        ...(customerId === undefined ? {} : { customerId }),
        allocations: input.allocations, feeAmount: input.feeAmount, decidedBy,
        ...(transaction.judgment === undefined ? {} : { judgmentReason: transaction.judgment.reason }),
        ...(learnedAlias?.created === true ? { learnedAlias: { customerId: learnedAlias.customerId, aliasId: learnedAlias.aliasId } } : {}),
        journal: { ...(journal.entryId === undefined ? {} : { entryId: journal.entryId }), outcome: journal.status },
        confirmedAt: at, createdAt: at, updatedAt: at,
      });
      await this.deps.matchings.save(matching);
      return { matching, journal, ...(followUp === undefined ? {} : { journalFollowUp: followUp }), ...(learnedAlias === undefined ? {} : { learnedAlias }) };
    });
  }
}

export interface ConfirmDecidedResult {
  readonly confirmed: readonly { readonly transactionId: string; readonly matchingId: string }[];
  readonly failed: readonly { readonly transactionId: string; readonly code: string; readonly reason?: string; readonly message: string }[];
}

export class ConfirmDecidedMatchingsUseCase {
  constructor(private readonly transactions: BankTransactionRepository, private readonly confirm: ConfirmMatchingUseCase) {}

  async execute(scope: TenantScope): Promise<ConfirmDecidedResult> {
    const targets = (await this.transactions.list(scope, { status: 'unmatched' }))
      .filter((transaction) => transaction.judgment?.stage === 'decided' && (transaction.judgment.contendedBy ?? []).length === 0);
    const confirmed: { transactionId: string; matchingId: string }[] = [];
    const failed: { transactionId: string; code: string; reason?: string; message: string }[] = [];
    for (const transaction of targets) {
      const candidate = transaction.judgment!.candidates[0]!;
      try {
        const result = await this.confirm.execute({ scope, transactionId: transaction.id, allocations: candidate.allocations, feeAmount: candidate.feeAmount, expectedOutstanding: expectedOutstandingOf(candidate) });
        confirmed.push({ transactionId: transaction.id, matchingId: result.matching.id });
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL';
        const reason = (error as { reason?: unknown }).reason;
        failed.push({ transactionId: transaction.id, code, ...(typeof reason === 'string' ? { reason } : {}), message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { confirmed, failed };
  }
}

export class CancelMatchingUseCase {
  private readonly now: () => Date;
  constructor(private readonly deps: MatchingDependencies) { this.now = deps.now ?? (() => new Date()); }

  async execute(input: { readonly scope: TenantScope; readonly matchingId: string; readonly removeLearnedAlias?: boolean }): Promise<{ readonly matching: Matching; readonly journalFollowUp?: JournalFollowUp; readonly removedAlias: boolean }> {
    const { scope } = input;
    return this.deps.unitOfWork.withTransaction(async () => {
      const matching = await this.deps.matchings.findById(scope, input.matchingId);
      if (matching === null) throw new MatchingNotFoundError(`matching not found: ${input.matchingId}`);
      const at = this.now().toISOString();
      const cancelled = cancelMatching(matching, at);
      const transaction = await this.deps.transactions.findById(scope, matching.transactionId);
      if (transaction !== null && transaction.status === 'matched') await this.deps.transactions.save(markTransactionUnmatched(transaction, at));
      const invoices = await this.deps.invoices.findByIds(scope, matching.allocations.map((allocation) => allocation.invoiceId));
      for (const invoice of invoices) {
        const amount = matching.allocations.find((allocation) => allocation.invoiceId === invoice.id)!.amount;
        await this.deps.invoices.save(revertInvoicePayment(invoice, amount, at));
      }
      let followUp: JournalFollowUp | undefined;
      if (matching.journal.entryId !== undefined) {
        const outcome = await this.deps.journal.discardDraft(scope, matching.journal.entryId);
        if (outcome === 'kept') followUp = { entryId: matching.journal.entryId, action: 'reverse' };
      }
      let removedAlias = false;
      if (input.removeLearnedAlias === true && matching.learnedAlias !== undefined) {
        const customer = await this.deps.customers.findById(scope, matching.learnedAlias.customerId);
        const alias = customer?.payerAliases.find((entry) => entry.id === matching.learnedAlias!.aliasId);
        // 学習した別名で、この消込が作ったものだけを消す（利用者が手で登録し直した別名は残す）。
        if (customer !== null && customer !== undefined && alias?.origin === 'learned' && alias.matchingId === matching.id) {
          await this.deps.customers.save(removePayerAlias(customer, alias.id, at));
          removedAlias = true;
        }
      }
      await this.deps.matchings.save(cancelled);
      return { matching: cancelled, ...(followUp === undefined ? {} : { journalFollowUp: followUp }), removedAlias };
    });
  }
}

export class ListMatchingsUseCase {
  constructor(private readonly matchings: MatchingRepository) {}
  async execute(scope: TenantScope, options: { readonly status?: MatchingStatus; readonly invoiceId?: string; readonly transactionId?: string } = {}): Promise<readonly Matching[]> {
    return this.matchings.list(scope, options);
  }
}

export class ListBankTransactionsUseCase {
  constructor(private readonly transactions: BankTransactionRepository) {}
  async execute(scope: TenantScope, options: { readonly status?: BankTransactionStatus; readonly from?: string; readonly to?: string; readonly accountKey?: string } = {}): Promise<readonly BankTransaction[]> {
    return this.transactions.list(scope, options);
  }
}

abstract class TransactionStateUseCase {
  constructor(protected readonly transactions: BankTransactionRepository, protected readonly now: () => Date = () => new Date()) {}
  protected async require(scope: TenantScope, id: string): Promise<BankTransaction> {
    const transaction = await this.transactions.findById(scope, id);
    if (transaction === null) throw new BankTransactionNotFoundError(`bank transaction not found: ${id}`);
    return transaction;
  }
}

export class IgnoreTransactionUseCase extends TransactionStateUseCase {
  async execute(input: { readonly scope: TenantScope; readonly id: string; readonly note?: string }): Promise<BankTransaction> {
    const updated = ignoreTransaction(await this.require(input.scope, input.id), input.note, this.now().toISOString());
    await this.transactions.save(updated);
    return updated;
  }
}

export class UnignoreTransactionUseCase extends TransactionStateUseCase {
  async execute(input: { readonly scope: TenantScope; readonly id: string }): Promise<BankTransaction> {
    const updated = unignoreTransaction(await this.require(input.scope, input.id), this.now().toISOString());
    await this.transactions.save(updated);
    return updated;
  }
}

/** 取り込み違いの訂正。消込済みは先に消込を取り消してもらう。 */
export class DeleteBankTransactionUseCase extends TransactionStateUseCase {
  async execute(scope: TenantScope, id: string): Promise<void> {
    const transaction = await this.require(scope, id);
    if (transaction.status === 'matched') throw new ReceivablesStateError('transaction-not-unmatched', `bank transaction ${id} is matched; cancel the matching first`, { transactionId: id });
    await this.transactions.delete(scope, id);
  }
}
