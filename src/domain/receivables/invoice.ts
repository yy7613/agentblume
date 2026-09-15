/**
 * ドメイン: 請求書（Invoice）集約（docs/22 §2.3 / §3.5）。
 *
 * 状態: `draft` → `issued` → `partially_paid` → `paid`。`issued` / `partially_paid`（入金確定が 1 件も無いときに限る）→ `void`。
 * `draft` は削除のみ。発行済みの明細・日付・宛名は変えられない（直すなら取消 → 複製して再作成）。
 *
 * `totals` は**常にドメインが計算した値**で、生成のたびに明細・税抜 / 税込・丸めモードから再計算する
 * （クライアントや取込元の申告値を採らない。申告値は `declared` に入れて検査にだけ使い、発行時に消す）。
 * 丸めモードは下書きでは設定の現在値、発行時に `snapshot` と一緒に凍結する（以後の設定変更で発行済みの税額が変わらない）。
 *
 * 下書きは記載事項が欠けたままでも保存できる（ツールの請求書案・JSON 貼付は発行日や取引先を空で渡す）。
 * 欠けているものは `checkInvoice` が違反として示し、発行だけを止める。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { ReceivablesDomainError, ReceivablesStateError } from './errors';
import type { CustomerId, InvoiceId } from './ids';
import {
  computeInvoiceTotals, INVOICE_TAX_RATES, lineAmountFromUnitPrice, PRICING_MODES, ROUNDING_MODES,
  type InvoiceTaxRate, type InvoiceTotals, type Pricing, type RoundingMode, type TaxableLine,
} from './invoice-tax';
import type { IssuerSettings } from './settings';

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
/** 入金を受け付ける（未入金一覧・消込の対象になる）状態。 */
export const OPEN_INVOICE_STATUSES: readonly InvoiceStatus[] = ['issued', 'partially_paid'];

export const ZERO_RATE_KINDS = ['exempt', 'non-taxable', 'export'] as const;
export type ZeroRateKind = (typeof ZERO_RATE_KINDS)[number];

/** 保存できる明細行の上限（検査の上限 200 行より緩い。越えた下書きは検査が `amount-out-of-range` にする）。 */
const STORAGE_MAX_LINES = 500;

export interface InvoiceLine {
  readonly description: string;
  readonly quantity?: number;
  readonly unit?: string;
  readonly unitPrice?: number;
  /** 整数円（値引は負）。省略時は単価 × 数量（割り切れるときだけ）。 */
  readonly amount?: number;
  readonly taxRate?: InvoiceTaxRate;
  readonly zeroRateKind?: ZeroRateKind;
}

/** 外から持ち込んだ下書きが申告していた税額（検査にだけ使う。docs/22 §3.3）。 */
export interface DeclaredTaxes {
  readonly lineTaxAmounts?: readonly (number | null)[];
  readonly taxByRate?: readonly { readonly rate: InvoiceTaxRate; readonly taxAmount: number }[];
  readonly grandTotal?: number;
}

export interface InvoiceSnapshot {
  readonly issuer: IssuerSettings;
  readonly customer: { readonly name: string; readonly honorific: string; readonly address?: string; readonly registrationNumber?: string };
  readonly roundingMode: RoundingMode;
  readonly issuedAt: IsoDateTime;
}

/** 下書きで編集できる部分（画面の入力と同じ形）。 */
export interface InvoiceContent {
  readonly customerId?: CustomerId;
  readonly issueDate?: string;
  readonly transactionDate?: string;
  readonly transactionPeriod?: { readonly from: string; readonly to: string };
  readonly dueDate?: string;
  readonly pricing: Pricing;
  readonly lines: readonly InvoiceLine[];
  readonly declared?: DeclaredTaxes;
  readonly note?: string;
}

/** 仕訳連携の結果。`salesEntryKept` は確定済みの仕訳を上書きしなかったことを示す（画面が要対応に出す）。 */
export interface InvoiceJournalLink {
  readonly salesEntryId?: string;
  readonly salesEntryKept?: boolean;
}

export interface Invoice extends InvoiceContent {
  readonly tenant: TenantScope;
  readonly id: InvoiceId;
  readonly number?: string;
  readonly status: InvoiceStatus;
  readonly roundingMode: RoundingMode;
  readonly totals: InvoiceTotals;
  readonly snapshot?: InvoiceSnapshot;
  readonly paidAmount: number;
  readonly journal: InvoiceJournalLink;
  readonly voided?: { readonly at: IsoDateTime; readonly reason: string };
  readonly duplicatedFrom?: InvoiceId;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateInvoiceProps extends InvoiceContent {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly number?: string;
  readonly status?: InvoiceStatus;
  readonly roundingMode: RoundingMode;
  readonly snapshot?: InvoiceSnapshot;
  readonly paidAmount?: number;
  readonly journal?: InvoiceJournalLink;
  readonly voided?: { readonly at: string; readonly reason: string };
  readonly duplicatedFrom?: string;
  /** 読み戻しで渡されても使わない（常に再計算する）。 */
  readonly totals?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const fail: ErrorFactory = (message) => new ReceivablesDomainError(message);

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  if (value.length > max) throw fail(`${label} must be at most ${max} characters`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isIsoDate(value)) throw fail(`${label} must be a date in YYYY-MM-DD`);
  return value;
}

function optionalFinite(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`${label} must be a number`);
  return value;
}

function optionalSafeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw fail(`${label} must be an integer`);
  return value;
}

function validateLine(line: InvoiceLine, index: number): InvoiceLine {
  const label = `invoice lines[${index}]`;
  if (line === null || typeof line !== 'object') throw fail(`${label} must be an object`);
  if (typeof line.description !== 'string') throw fail(`${label}.description must be a string`);
  if (line.description.length > 500) throw fail(`${label}.description must be at most 500 characters`);
  if (line.taxRate !== undefined && line.taxRate !== null && !INVOICE_TAX_RATES.includes(line.taxRate)) throw fail(`${label}.taxRate must be one of 10, 8, 0`);
  if (line.zeroRateKind !== undefined && line.zeroRateKind !== null && !ZERO_RATE_KINDS.includes(line.zeroRateKind)) throw fail(`${label}.zeroRateKind must be one of ${ZERO_RATE_KINDS.join(', ')}`);
  const quantity = optionalFinite(line.quantity, `${label}.quantity`);
  const unitPrice = optionalFinite(line.unitPrice, `${label}.unitPrice`);
  const amount = optionalSafeInteger(line.amount, `${label}.amount`);
  const unit = optionalText(line.unit, `${label}.unit`, 20);
  return {
    description: line.description.trim(),
    ...(quantity === undefined ? {} : { quantity }),
    ...(unit === undefined ? {} : { unit }),
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(amount === undefined ? {} : { amount }),
    ...(line.taxRate === undefined || line.taxRate === null ? {} : { taxRate: line.taxRate }),
    ...(line.zeroRateKind === undefined || line.zeroRateKind === null ? {} : { zeroRateKind: line.zeroRateKind }),
  };
}

function validateDeclared(value: DeclaredTaxes | undefined): DeclaredTaxes | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw fail('invoice declared must be an object');
  const lineTaxAmounts = value.lineTaxAmounts === undefined ? undefined : (() => {
    if (!Array.isArray(value.lineTaxAmounts)) throw fail('invoice declared.lineTaxAmounts must be an array');
    return value.lineTaxAmounts.map((entry, index) => entry === null ? null : optionalSafeInteger(entry, `invoice declared.lineTaxAmounts[${index}]`) ?? null);
  })();
  const taxByRate = value.taxByRate === undefined ? undefined : (() => {
    if (!Array.isArray(value.taxByRate)) throw fail('invoice declared.taxByRate must be an array');
    return value.taxByRate.map((entry, index) => {
      if (entry === null || typeof entry !== 'object' || !INVOICE_TAX_RATES.includes(entry.rate)) throw fail(`invoice declared.taxByRate[${index}].rate must be one of 10, 8, 0`);
      return { rate: entry.rate, taxAmount: optionalSafeInteger(entry.taxAmount, `invoice declared.taxByRate[${index}].taxAmount`) ?? 0 };
    });
  })();
  const grandTotal = optionalSafeInteger(value.grandTotal, 'invoice declared.grandTotal');
  if (lineTaxAmounts === undefined && taxByRate === undefined && grandTotal === undefined) return undefined;
  return {
    ...(lineTaxAmounts === undefined ? {} : { lineTaxAmounts }),
    ...(taxByRate === undefined ? {} : { taxByRate }),
    ...(grandTotal === undefined ? {} : { grandTotal }),
  };
}

/** 明細の金額（直接の金額か、割り切れる単価 × 数量）。決まらなければ undefined。 */
export function resolveLineAmount(line: InvoiceLine): number | undefined {
  if (line.amount !== undefined) return line.amount;
  if (line.quantity !== undefined && line.unitPrice !== undefined) return lineAmountFromUnitPrice(line.quantity, line.unitPrice);
  return undefined;
}

/** 集計に使える明細（金額と税率が決まっているもの）。 */
export function taxableLines(lines: readonly InvoiceLine[]): readonly TaxableLine[] {
  return lines.flatMap((line) => {
    const amount = resolveLineAmount(line);
    return amount === undefined || line.taxRate === undefined ? [] : [{ amount, taxRate: line.taxRate }];
  });
}

/** 明細・税抜 / 税込・丸めモードから集計する（負の税率合計は除く。検査が違反にする）。 */
export function totalsOf(content: Pick<InvoiceContent, 'lines' | 'pricing'>, roundingMode: RoundingMode): InvoiceTotals {
  return computeInvoiceTotals(taxableLines(content.lines), content.pricing, roundingMode).totals;
}

function validateContent(props: InvoiceContent): InvoiceContent {
  if (!PRICING_MODES.includes(props.pricing)) throw fail(`invoice pricing must be one of ${PRICING_MODES.join(', ')}`);
  if (!Array.isArray(props.lines) || props.lines.length > STORAGE_MAX_LINES) throw fail(`invoice lines must be an array of at most ${STORAGE_MAX_LINES}`);
  const period = props.transactionPeriod;
  let transactionPeriod: InvoiceContent['transactionPeriod'];
  if (period !== undefined && period !== null) {
    if (typeof period !== 'object' || !isIsoDate(period.from) || !isIsoDate(period.to)) throw fail('invoice transactionPeriod must have from and to dates in YYYY-MM-DD');
    if (period.from > period.to) throw fail('invoice transactionPeriod.from must not be after to');
    transactionPeriod = { from: period.from, to: period.to };
  }
  const customerId = optionalText(props.customerId, 'invoice customerId', 200);
  const issueDate = optionalDate(props.issueDate, 'invoice issueDate');
  const transactionDate = optionalDate(props.transactionDate, 'invoice transactionDate');
  const dueDate = optionalDate(props.dueDate, 'invoice dueDate');
  const declared = validateDeclared(props.declared);
  const note = optionalText(props.note, 'invoice note', 2000);
  return {
    ...(customerId === undefined ? {} : { customerId }),
    ...(issueDate === undefined ? {} : { issueDate }),
    ...(transactionDate === undefined ? {} : { transactionDate }),
    ...(transactionPeriod === undefined ? {} : { transactionPeriod }),
    ...(dueDate === undefined ? {} : { dueDate }),
    pricing: props.pricing,
    lines: props.lines.map(validateLine),
    ...(declared === undefined ? {} : { declared }),
    ...(note === undefined ? {} : { note }),
  };
}

/** 請求書を組み立てて不変条件を検証する（totals は必ず再計算）。 */
export function createInvoice(props: CreateInvoiceProps, makeId?: () => string): Invoice {
  if (props === null || typeof props !== 'object') throw fail('createInvoice: props are required');
  assertNonEmpty(props.tenant?.tenantId, 'createInvoice: tenant.tenantId', fail);
  assertNonEmpty(props.tenant?.workspaceId, 'createInvoice: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createInvoice: id', fail);
  const status = props.status ?? 'draft';
  if (!INVOICE_STATUSES.includes(status)) throw fail(`invoice status must be one of ${INVOICE_STATUSES.join(', ')}`);
  if (!ROUNDING_MODES.includes(props.roundingMode)) throw fail(`invoice roundingMode must be one of ${ROUNDING_MODES.join(', ')}`);
  assertIsoDateTime(props.createdAt, 'createInvoice: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createInvoice: updatedAt', fail);
  const content = validateContent(props);
  const totals = totalsOf(content, props.roundingMode);
  const paidAmount = props.paidAmount ?? 0;
  if (!Number.isSafeInteger(paidAmount) || paidAmount < 0 || paidAmount > Math.max(totals.grandTotal, 0)) throw fail('invoice paidAmount must be an integer between 0 and grandTotal');
  const number = optionalText(props.number, 'invoice number', 80);

  if (status === 'draft') {
    if (number !== undefined || props.snapshot !== undefined) throw fail('a draft invoice must not have a number or a snapshot');
    if (paidAmount !== 0) throw fail('a draft invoice cannot have payments');
  } else {
    if (number === undefined) throw fail(`a ${status} invoice must have a number`);
    if (props.snapshot === undefined || props.snapshot === null || typeof props.snapshot !== 'object') throw fail(`a ${status} invoice must have a snapshot`);
    if (content.issueDate === undefined || content.customerId === undefined) throw fail(`a ${status} invoice must have an issue date and a customer`);
    if (props.snapshot.roundingMode !== props.roundingMode) throw fail('invoice roundingMode must equal snapshot.roundingMode once issued');
    assertIsoDateTime(props.snapshot.issuedAt, 'invoice snapshot.issuedAt', fail);
    const expected = paidAmount === 0 ? 'issued' : paidAmount === totals.grandTotal ? 'paid' : 'partially_paid';
    if (status === 'void') {
      if (paidAmount !== 0) throw fail('a void invoice cannot have payments');
      if (props.voided === undefined || typeof props.voided.reason !== 'string') throw fail('a void invoice must have voided.reason');
      assertIsoDateTime(props.voided.at, 'invoice voided.at', fail);
    } else if (status !== expected) {
      throw fail(`invoice status ${status} does not match paidAmount ${paidAmount} of ${totals.grandTotal}`);
    }
  }
  const journal = props.journal ?? {};
  const salesEntryId = optionalText(journal.salesEntryId, 'invoice journal.salesEntryId', 200);
  const duplicatedFrom = optionalText(props.duplicatedFrom, 'invoice duplicatedFrom', 200);
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    ...(number === undefined ? {} : { number }),
    status,
    ...content,
    roundingMode: props.roundingMode,
    totals,
    ...(props.snapshot === undefined ? {} : { snapshot: structuredClone(props.snapshot) }),
    paidAmount,
    journal: {
      ...(salesEntryId === undefined ? {} : { salesEntryId }),
      ...(journal.salesEntryKept === true ? { salesEntryKept: true } : {}),
    },
    ...(status === 'void' && props.voided !== undefined ? { voided: { at: props.voided.at, reason: props.voided.reason.trim() } } : {}),
    ...(duplicatedFrom === undefined ? {} : { duplicatedFrom }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

function rebuild(invoice: Invoice, patch: Partial<CreateInvoiceProps>): Invoice {
  const { totals: _totals, ...rest } = invoice;
  return createInvoice({ ...rest, ...patch } as CreateInvoiceProps);
}

/** 下書きの中身を差し替える（丸めモードは設定の現在値で再計算）。 */
export function updateInvoiceDraft(invoice: Invoice, content: InvoiceContent, roundingMode: RoundingMode, at: string): Invoice {
  if (invoice.status !== 'draft') throw new ReceivablesStateError('invoice-not-draft', `invoice ${invoice.number ?? invoice.id} is ${invoice.status}; only a draft can be edited (void it and duplicate to fix)`);
  const cleared: Invoice = {
    tenant: invoice.tenant, id: invoice.id, status: invoice.status, roundingMode, totals: invoice.totals, paidAmount: 0, journal: invoice.journal,
    pricing: content.pricing, lines: content.lines,
    ...(invoice.duplicatedFrom === undefined ? {} : { duplicatedFrom: invoice.duplicatedFrom }),
    createdAt: invoice.createdAt, updatedAt: at,
  };
  return rebuild(cleared, { ...content, roundingMode, updatedAt: at });
}

/** 発行（draft → issued）。申告値を消し、丸めモードを写しと一緒に凍結する。 */
export function issueInvoice(invoice: Invoice, input: { readonly number: string; readonly snapshot: InvoiceSnapshot; readonly at: string }): Invoice {
  if (invoice.status !== 'draft') throw new ReceivablesStateError('invoice-not-draft', `invoice ${invoice.number ?? invoice.id} is already ${invoice.status}`);
  const { declared: _declared, ...rest } = invoice;
  return rebuild(rest as Invoice, { status: 'issued', number: input.number, snapshot: input.snapshot, roundingMode: input.snapshot.roundingMode, updatedAt: input.at });
}

/** 取消（issued / partially_paid → void）。入金が確定していれば拒否する（先に消込を取り消す）。 */
export function voidInvoice(invoice: Invoice, reason: string, at: string): Invoice {
  if (invoice.status !== 'issued' && invoice.status !== 'partially_paid') throw new ReceivablesStateError('invoice-not-issued', `invoice ${invoice.number ?? invoice.id} is ${invoice.status}; only an issued invoice can be voided`);
  if (invoice.paidAmount > 0) throw new ReceivablesStateError('invoice-has-payments', `invoice ${invoice.number} has confirmed payments; cancel the matchings first`);
  assertNonEmpty(reason, 'void reason', fail);
  return rebuild(invoice, { status: 'void', voided: { at, reason }, updatedAt: at });
}

/** 未入金額（下書き・取消は 0）。 */
export function invoiceOutstanding(invoice: Pick<Invoice, 'status' | 'totals' | 'paidAmount'>): number {
  return invoice.status === 'draft' || invoice.status === 'void' ? 0 : invoice.totals.grandTotal - invoice.paidAmount;
}

function statusFor(paidAmount: number, grandTotal: number): InvoiceStatus {
  return paidAmount === 0 ? 'issued' : paidAmount === grandTotal ? 'paid' : 'partially_paid';
}

/** 入金の配分を反映する。残高を超える配分は拒否する。 */
export function applyInvoicePayment(invoice: Invoice, amount: number, at: string): Invoice {
  if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) throw new ReceivablesStateError('invoice-not-issued', `invoice ${invoice.number ?? invoice.id} is ${invoice.status}; payments can only be applied to an issued invoice`);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw fail('payment amount must be a positive integer');
  const outstanding = invoiceOutstanding(invoice);
  if (amount > outstanding) throw new ReceivablesStateError('allocation-exceeds-outstanding', `allocation ${amount} exceeds the outstanding ${outstanding} of invoice ${invoice.number}`, { invoiceId: invoice.id, outstanding, amount });
  const paidAmount = invoice.paidAmount + amount;
  return rebuild(invoice, { paidAmount, status: statusFor(paidAmount, invoice.totals.grandTotal), updatedAt: at });
}

/** 消込の取消で入金額を戻す。 */
export function revertInvoicePayment(invoice: Invoice, amount: number, at: string): Invoice {
  if (invoice.status === 'draft' || invoice.status === 'void') throw fail(`cannot revert a payment on a ${invoice.status} invoice`);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > invoice.paidAmount) throw fail('reverted amount must be a positive integer not exceeding paidAmount');
  const paidAmount = invoice.paidAmount - amount;
  return rebuild(invoice, { paidAmount, status: statusFor(paidAmount, invoice.totals.grandTotal), updatedAt: at });
}

/** 仕訳連携の結果を記録する。 */
export function withInvoiceJournal(invoice: Invoice, journal: InvoiceJournalLink, at: string): Invoice {
  return rebuild(invoice, { journal, updatedAt: at });
}

/** `YYYY-MM-DD` に日数を足す。 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** 期日超過日数（未到来・期日なし・入金済みは 0）。保存しない計算値（docs/22 §2.3）。 */
export function daysOverdue(invoice: Pick<Invoice, 'status' | 'dueDate' | 'totals' | 'paidAmount'>, today: string): number {
  if (!OPEN_INVOICE_STATUSES.includes(invoice.status) || invoice.dueDate === undefined || invoiceOutstanding(invoice) <= 0) return 0;
  return Math.max(0, dayNumber(today) - dayNumber(invoice.dueDate));
}

export function isOverdue(invoice: Pick<Invoice, 'status' | 'dueDate' | 'totals' | 'paidAmount'>, today: string): boolean {
  return daysOverdue(invoice, today) > 0;
}

/** 複製して再作成するときの中身（番号・日付の発行日・申告値は引き継がない）。 */
export function duplicateInvoiceContent(invoice: Invoice): InvoiceContent {
  return {
    ...(invoice.customerId === undefined ? {} : { customerId: invoice.customerId }),
    ...(invoice.transactionDate === undefined ? {} : { transactionDate: invoice.transactionDate }),
    ...(invoice.transactionPeriod === undefined ? {} : { transactionPeriod: invoice.transactionPeriod }),
    ...(invoice.dueDate === undefined ? {} : { dueDate: invoice.dueDate }),
    pricing: invoice.pricing,
    lines: invoice.lines.map((line) => ({ ...line })),
    ...(invoice.note === undefined ? {} : { note: invoice.note }),
  };
}

/** 記載事項としての取引年月日（期間なら末日）。 */
export function effectiveTransactionDate(content: Pick<InvoiceContent, 'transactionDate' | 'transactionPeriod'>): string | undefined {
  return content.transactionPeriod?.to ?? content.transactionDate;
}
