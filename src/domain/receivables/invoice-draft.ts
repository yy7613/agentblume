/**
 * ドメイン: 注文書・見積書の読み取り結果から請求書案を組み立てる（docs/22 §10.3 `receivables_invoice_draft`）。純関数。
 *
 * 読み取り（vision）は application のポートが行い、ここは結果を請求書の下書きの形へ写して検査するだけ。
 * **保存しない**（取引先も請求書も作らない）。読み取った税額・合計は `declared` に入れて `checkInvoice` にかけ、
 * 12B 級 vision の既知の誤読（税率別金額の読み違い）を違反 / 警告として必ず表に出す。値は自動補正しない。
 *
 * 取引先の決め方: 読み取った発行者が自社（登録番号か正規化した名前が一致）なら「自社の見積書」として宛名側を、
 * そうでなければ「相手の注文書」として発行者側を取引先名にする。発行日は人が決めるので常に空にする。
 */
import { normalizeRegistrationNumber } from '../journal/normalize';
import type { Customer } from './customer';
import { addDays, type DeclaredTaxes, type InvoiceContent, type InvoiceLine } from './invoice';
import { checkInvoice, type InvoiceCheck } from './invoice-check';
import { INVOICE_TAX_RATES, type InvoiceTaxRate, type Pricing } from './invoice-tax';
import { customerMatchKeys } from './customer';
import { normalizePayerName } from './payer-name';
import type { ReceivablesSettings } from './settings';

/** 読み取りの結果（receivables が定義する最小の形。値は仕訳の抽出で正規化済み）。 */
export interface OrderDocumentRead {
  readonly issuerName?: string;
  readonly recipientName?: string;
  readonly registrationNumber?: string;
  readonly issueDate?: string;
  readonly transactionDate?: string;
  readonly dueDate?: string;
  readonly grandTotal?: number;
  readonly totalsByRate?: readonly { readonly rate: number; readonly taxableAmount: number; readonly taxAmount?: number; readonly amountIncludesTax: boolean }[];
  readonly lines: readonly { readonly description?: string; readonly quantity?: number; readonly unitPrice?: number; readonly amount?: number; readonly taxRate?: number }[];
  readonly warnings: readonly string[];
}

export interface InvoiceDraftProposal {
  /** 下書きフォームへ渡す中身（発行日は空）。 */
  readonly content: InvoiceContent;
  readonly customerName?: string;
  readonly customerId?: string;
  readonly check: InvoiceCheck;
  /** 添付に印字されていた合計（無ければ undefined）。 */
  readonly documentTotal?: number;
  readonly warnings: readonly string[];
}

const isRate = (value: number | undefined): value is InvoiceTaxRate => value !== undefined && (INVOICE_TAX_RATES as readonly number[]).includes(value);

function isOwnDocument(read: OrderDocumentRead, settings: Pick<ReceivablesSettings, 'issuer'>): boolean {
  const own = normalizeRegistrationNumber(settings.issuer.registrationNumber);
  if (own !== undefined && read.registrationNumber !== undefined && normalizeRegistrationNumber(read.registrationNumber) === own) return true;
  const ownName = normalizePayerName(settings.issuer.name);
  return ownName !== '' && normalizePayerName(read.issuerName) === ownName;
}

export function draftInvoiceFromOrder(read: OrderDocumentRead, settings: Pick<ReceivablesSettings, 'issuer' | 'rounding'>, customers: readonly Customer[]): InvoiceDraftProposal {
  const warnings = [...read.warnings];
  const customerName = (isOwnDocument(read, settings) ? read.recipientName : read.issuerName)?.trim() || undefined;
  const key = normalizePayerName(customerName);
  const matches = key === '' ? [] : customers.filter((customer) => customer.enabled && (normalizePayerName(customer.name) === key || customerMatchKeys(customer).includes(key)));
  const customer = matches.length === 1 ? matches[0] : undefined;
  if (customerName !== undefined && matches.length > 1) warnings.push(`several customers match ${customerName}; choose one`);

  const rates = (read.totalsByRate ?? []).filter((entry) => isRate(entry.rate));
  const pricing: Pricing = rates.length === 0 ? settings.rounding.defaultPricing : rates.some((entry) => entry.amountIncludesTax) ? 'inclusive' : 'exclusive';
  const onlyRate = rates.length === 1 ? rates[0]!.rate as InvoiceTaxRate : undefined;
  const lines: InvoiceLine[] = read.lines.map((line) => {
    const taxRate = isRate(line.taxRate) ? line.taxRate : onlyRate;
    return {
      description: line.description ?? '',
      ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
      ...(line.unitPrice === undefined ? {} : { unitPrice: line.unitPrice }),
      ...(line.amount === undefined ? {} : { amount: line.amount }),
      ...(taxRate === undefined ? {} : { taxRate }),
    };
  });
  const taxByRate = rates.filter((entry) => entry.taxAmount !== undefined).map((entry) => ({ rate: entry.rate as InvoiceTaxRate, taxAmount: entry.taxAmount! }));
  const declared: DeclaredTaxes | undefined = taxByRate.length === 0 && read.grandTotal === undefined
    ? undefined
    : { ...(taxByRate.length === 0 ? {} : { taxByRate }), ...(read.grandTotal === undefined ? {} : { grandTotal: read.grandTotal }) };
  const dueDate = read.dueDate ?? (customer?.paymentTermDays !== undefined && read.transactionDate !== undefined ? addDays(read.transactionDate, customer.paymentTermDays) : undefined);
  const content: InvoiceContent = {
    ...(customer === undefined ? {} : { customerId: customer.id }),
    ...(read.transactionDate === undefined ? {} : { transactionDate: read.transactionDate }),
    ...(dueDate === undefined ? {} : { dueDate }),
    pricing,
    lines,
    ...(declared === undefined ? {} : { declared }),
  };
  const check = checkInvoice({
    invoice: content,
    settings,
    // 取引先が見つからなくても、読み取った名前があれば宛名はある（保存前に取引先を選んでもらう）。
    customer: customer ?? (customerName === undefined ? undefined : { name: customerName, enabled: true }),
  });
  return {
    content,
    ...(customerName === undefined ? {} : { customerName }),
    ...(customer === undefined ? {} : { customerId: customer.id }),
    check,
    ...(read.grandTotal === undefined ? {} : { documentTotal: read.grandTotal }),
    warnings,
  };
}
