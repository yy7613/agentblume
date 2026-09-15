/**
 * application層: 請求書（docs/22 §2.3 / §3.5）の検査・下書き・発行・取消・複製・一覧。
 *
 * ## 発行は 1 トランザクション
 *
 * 採番（系列の連番を +1）→ 発行（写しの凍結）→ 売上仕訳の下書き → 保存 を同じ UnitOfWork で行う。
 * 仕訳の科目が無ければ**発行ごと巻き戻し**て `journal-account-missing` を返す（発行済みなのに仕訳が無い状態を作らない）。
 * 仕訳のリポジトリは同じ SQLite 接続なので、仕訳の書き込みも一緒に巻き戻る（ADR-0041 決定 5）。
 *
 * ## 取消は欠番を残す
 *
 * 番号は再利用しない（監査で欠番の理由を問われたとき、取消の記録で答えられるように）。売上仕訳が下書きなら消し、
 * 確定・出力済みなら残して「仕訳側で取消の仕訳を作ってください」を返す。
 */
import { randomUUID } from 'node:crypto';
import type { Customer } from '../../domain/receivables/customer';
import { InvoiceComplianceError, InvoiceNotFoundError, ReceivablesStateError } from '../../domain/receivables/errors';
import {
  createInvoice, daysOverdue, duplicateInvoiceContent, invoiceOutstanding, issueInvoice, updateInvoiceDraft, voidInvoice, withInvoiceJournal,
  type Invoice, type InvoiceContent, type InvoiceStatus,
} from '../../domain/receivables/invoice';
import { checkInvoice, type InvoiceCheck } from '../../domain/receivables/invoice-check';
import { salesJournalEntry } from '../../domain/receivables/journal-lines';
import { formatInvoiceNumber, numberingSeriesKey } from '../../domain/receivables/numbering';
import type { CustomerRepository, InvoiceRepository, MatchingRepository, ReceivablesSettingsRepository } from '../../domain/receivables/repositories';
import { defaultReceivablesSettings, type ReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { assertJournalLink, localIsoDate, settingsOrDefault, type JournalDraftSink, type JournalFollowUp } from './ports';

export interface InvoiceDependencies {
  readonly invoices: InvoiceRepository;
  readonly customers: CustomerRepository;
  readonly settings: ReceivablesSettingsRepository;
  readonly matchings: MatchingRepository;
  readonly journal: JournalDraftSink;
  readonly unitOfWork: UnitOfWorkPort;
  readonly makeId?: () => string;
  readonly now?: () => Date;
}

abstract class InvoiceUseCase {
  protected readonly makeId: () => string;
  protected readonly now: () => Date;
  constructor(protected readonly deps: InvoiceDependencies) {
    this.makeId = deps.makeId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }
  protected async loadSettings(scope: TenantScope): Promise<ReceivablesSettings> {
    return (await settingsOrDefault(this.deps.settings, scope, () => defaultReceivablesSettings())).settings;
  }
  protected async customerOf(scope: TenantScope, customerId: string | undefined): Promise<Customer | undefined> {
    return customerId === undefined ? undefined : (await this.deps.customers.findById(scope, customerId)) ?? undefined;
  }
  protected async requireInvoice(scope: TenantScope, id: string): Promise<Invoice> {
    const invoice = await this.deps.invoices.findById(scope, id);
    if (invoice === null) throw new InvoiceNotFoundError(`invoice not found: ${id}`);
    return invoice;
  }
  protected async check(scope: TenantScope, content: InvoiceContent, settings?: ReceivablesSettings): Promise<InvoiceCheck> {
    const resolved = settings ?? await this.loadSettings(scope);
    return checkInvoice({ invoice: content, settings: resolved, customer: await this.customerOf(scope, content.customerId) });
  }
}

/** 保存しない検査と集計（`POST /receivables/invoices/check`）。 */
export class CheckInvoiceUseCase extends InvoiceUseCase {
  async execute(input: { readonly scope: TenantScope; readonly content: InvoiceContent }): Promise<InvoiceCheck> {
    return this.check(input.scope, input.content);
  }
}

export class CreateInvoiceDraftUseCase extends InvoiceUseCase {
  async execute(input: { readonly scope: TenantScope; readonly content: InvoiceContent }): Promise<{ readonly invoice: Invoice; readonly check: InvoiceCheck }> {
    const settings = await this.loadSettings(input.scope);
    const at = this.now().toISOString();
    const invoice = createInvoice({ tenant: input.scope, ...input.content, roundingMode: settings.rounding.mode, createdAt: at, updatedAt: at }, this.makeId);
    await this.deps.invoices.save(invoice);
    return { invoice, check: await this.check(input.scope, invoice, settings) };
  }
}

export class UpdateInvoiceDraftUseCase extends InvoiceUseCase {
  async execute(input: { readonly scope: TenantScope; readonly id: string; readonly content: InvoiceContent }): Promise<{ readonly invoice: Invoice; readonly check: InvoiceCheck }> {
    const settings = await this.loadSettings(input.scope);
    const invoice = updateInvoiceDraft(await this.requireInvoice(input.scope, input.id), input.content, settings.rounding.mode, this.now().toISOString());
    await this.deps.invoices.save(invoice);
    return { invoice, check: await this.check(input.scope, invoice, settings) };
  }
}

export interface InvoicePayment {
  readonly matchingId: string;
  readonly transactionId: string;
  readonly amount: number;
  readonly feeAmount: number;
  readonly status: 'confirmed' | 'cancelled';
  readonly confirmedAt: string;
}

export class GetInvoiceUseCase extends InvoiceUseCase {
  async execute(scope: TenantScope, id: string): Promise<{ readonly invoice: Invoice; readonly check?: InvoiceCheck; readonly payments: readonly InvoicePayment[] }> {
    const invoice = await this.requireInvoice(scope, id);
    const matchings = await this.deps.matchings.list(scope, { invoiceId: id });
    const payments = matchings.map((matching) => ({
      matchingId: matching.id, transactionId: matching.transactionId,
      amount: matching.allocations.find((allocation) => allocation.invoiceId === id)?.amount ?? 0,
      feeAmount: matching.feeAmount, status: matching.status, confirmedAt: matching.confirmedAt,
    }));
    return { invoice, ...(invoice.status === 'draft' ? { check: await this.check(scope, invoice) } : {}), payments };
  }
}

export interface InvoiceSummary {
  readonly invoice: Invoice;
  readonly customerName?: string;
  readonly outstanding: number;
  readonly daysOverdue: number;
  /** 下書きの違反の件数（発行ボタンを押せるか）。発行済みは 0。 */
  readonly violationCount: number;
}

export interface ListInvoicesOptions {
  readonly status?: InvoiceStatus;
  readonly customerId?: string;
  readonly overdue?: boolean;
  readonly from?: string;
  readonly to?: string;
}

export class ListInvoicesUseCase extends InvoiceUseCase {
  async execute(scope: TenantScope, options: ListInvoicesOptions = {}): Promise<readonly InvoiceSummary[]> {
    const today = localIsoDate(this.now());
    const [settings, customers, invoices] = await Promise.all([
      this.loadSettings(scope),
      this.deps.customers.list(scope),
      this.deps.invoices.list(scope, {
        ...(options.status === undefined ? options.overdue === true ? { statuses: ['issued', 'partially_paid'] } : {} : { statuses: [options.status] }),
        ...(options.customerId === undefined ? {} : { customerId: options.customerId }),
        ...(options.from === undefined ? {} : { from: options.from }),
        ...(options.to === undefined ? {} : { to: options.to }),
        ...(options.overdue === true ? { dueBefore: today } : {}),
      }),
    ]);
    const byId = new Map(customers.map((customer) => [customer.id, customer]));
    return invoices.map((invoice) => {
      const customer = invoice.customerId === undefined ? undefined : byId.get(invoice.customerId);
      const customerName = customer?.name ?? invoice.snapshot?.customer.name;
      const violationCount = invoice.status === 'draft' ? checkInvoice({ invoice, settings, customer }).violations.length : 0;
      return {
        invoice,
        ...(customerName === undefined ? {} : { customerName }),
        outstanding: invoiceOutstanding(invoice),
        daysOverdue: daysOverdue(invoice, today),
        violationCount,
      };
    }).filter((summary) => options.overdue !== true || summary.daysOverdue > 0);
  }
}

export class DeleteInvoiceDraftUseCase extends InvoiceUseCase {
  async execute(scope: TenantScope, id: string): Promise<void> {
    const invoice = await this.requireInvoice(scope, id);
    if (invoice.status !== 'draft') throw new ReceivablesStateError('invoice-not-draft', `invoice ${invoice.number ?? id} is ${invoice.status}; only a draft can be deleted (void it instead)`);
    await this.deps.invoices.delete(scope, id);
  }
}

export interface IssueInvoiceResult {
  readonly invoice: Invoice;
  readonly journal?: { readonly status: 'created' | 'updated' | 'kept' | 'disabled'; readonly entryId?: string };
  readonly journalFollowUp?: JournalFollowUp;
}

export class IssueInvoiceUseCase extends InvoiceUseCase {
  async execute(input: { readonly scope: TenantScope; readonly id: string }): Promise<IssueInvoiceResult> {
    const { scope } = input;
    return this.deps.unitOfWork.withTransaction(async () => {
      const draft = await this.requireInvoice(scope, input.id);
      if (draft.status !== 'draft') throw new ReceivablesStateError('invoice-not-draft', `invoice ${draft.number ?? draft.id} is already ${draft.status}`);
      const settings = await this.loadSettings(scope);
      const customer = await this.customerOf(scope, draft.customerId);
      const check = checkInvoice({ invoice: draft, settings, customer });
      if (check.violations.length > 0) throw new InvoiceComplianceError(`the invoice cannot be issued: ${check.violations.map((issue) => issue.code).join(', ')}`, check.violations);
      const at = this.now().toISOString();
      const seriesKey = numberingSeriesKey(settings.numbering.format, draft.issueDate!);
      // 書式を変えて過去の番号と重なる系列になっても、既存の番号を避けて採番する（一意索引で落とさない）。
      const taken = new Set((await this.deps.invoices.list(scope, { statuses: ['issued', 'partially_paid', 'paid', 'void'] })).map((invoice) => invoice.number));
      let number = formatInvoiceNumber(seriesKey, await this.deps.invoices.nextNumber(scope, seriesKey));
      while (taken.has(number)) number = formatInvoiceNumber(seriesKey, await this.deps.invoices.nextNumber(scope, seriesKey));
      let invoice = issueInvoice(draft, {
        number,
        snapshot: {
          issuer: settings.issuer,
          customer: { name: customer!.name, honorific: customer!.honorific, ...(customer!.address === undefined ? {} : { address: customer!.address }), ...(customer!.registrationNumber === undefined ? {} : { registrationNumber: customer!.registrationNumber }) },
          roundingMode: settings.rounding.mode,
          issuedAt: at,
        },
        at,
      });
      if (!settings.journal.enabled) {
        await this.deps.invoices.save(invoice);
        return { invoice, journal: { status: 'disabled' as const } };
      }
      const rates = invoice.totals.byRate.filter((entry) => entry.inclusive > 0).map((entry) => `journal.salesTaxCodes['${entry.rate}']`);
      await assertJournalLink(this.deps.journal, scope, settings, { accountPaths: ['journal.accounts.sales', 'journal.accounts.receivable'], taxPaths: [...rates, 'journal.nonTaxableTaxCode'] });
      const result = await this.deps.journal.upsertDraft(scope, salesJournalEntry(invoice, settings, customer!.name));
      invoice = withInvoiceJournal(invoice, { salesEntryId: result.entryId, ...(result.status === 'kept' ? { salesEntryKept: true } : {}) }, at);
      await this.deps.invoices.save(invoice);
      return {
        invoice,
        journal: { status: result.status, entryId: result.entryId },
        ...(result.status === 'kept' ? { journalFollowUp: { entryId: result.entryId, action: 'review' as const, entryStatus: result.entryStatus } } : {}),
      };
    });
  }
}

export class VoidInvoiceUseCase extends InvoiceUseCase {
  async execute(input: { readonly scope: TenantScope; readonly id: string; readonly reason: string }): Promise<{ readonly invoice: Invoice; readonly journalFollowUp?: JournalFollowUp }> {
    const { scope } = input;
    return this.deps.unitOfWork.withTransaction(async () => {
      const invoice = await this.requireInvoice(scope, input.id);
      const confirmed = await this.deps.matchings.list(scope, { invoiceId: invoice.id, status: 'confirmed' });
      if (confirmed.length > 0) throw new ReceivablesStateError('invoice-has-payments', `invoice ${invoice.number} has ${confirmed.length} confirmed matchings; cancel them first`, { matchings: confirmed.length });
      const at = this.now().toISOString();
      let voided = voidInvoice(invoice, input.reason, at);
      let followUp: JournalFollowUp | undefined;
      const entryId = invoice.journal.salesEntryId;
      if (entryId !== undefined) {
        const outcome = await this.deps.journal.discardDraft(scope, entryId);
        if (outcome === 'kept') {
          followUp = { entryId, action: 'reverse' };
          voided = withInvoiceJournal(voided, { salesEntryId: entryId, salesEntryKept: true }, at);
        } else {
          voided = withInvoiceJournal(voided, {}, at);
        }
      }
      await this.deps.invoices.save(voided);
      return { invoice: voided, ...(followUp === undefined ? {} : { journalFollowUp: followUp }) };
    });
  }
}

/** 取消 → 複製して再作成の「複製」。発行日は今日、番号と申告値は引き継がない。 */
export class DuplicateInvoiceUseCase extends InvoiceUseCase {
  async execute(input: { readonly scope: TenantScope; readonly id: string }): Promise<{ readonly invoice: Invoice; readonly check: InvoiceCheck }> {
    const source = await this.requireInvoice(input.scope, input.id);
    const settings = await this.loadSettings(input.scope);
    const at = this.now().toISOString();
    const invoice = createInvoice({
      tenant: input.scope, ...duplicateInvoiceContent(source), issueDate: localIsoDate(this.now()), duplicatedFrom: source.id,
      roundingMode: settings.rounding.mode, createdAt: at, updatedAt: at,
    }, this.makeId);
    await this.deps.invoices.save(invoice);
    return { invoice, check: await this.check(input.scope, invoice, settings) };
  }
}
