/**
 * api層: 入金消込（docs/22-receivables.md §7）のリクエスト Zod スキーマ。
 *
 * 業務のスキーマは業務ごとのファイルに置く（ADR-0039）。共通のスコープ検証は `schemas.ts` のものを使う。
 * 列挙は domain から import し（API に書き写すと「ドメインは受け付けるのに API が 400」のずれが生まれる）、
 * 値の不変条件（日付の実在・配分の合計・税額）は domain / ユースケースが正本で、ここは**形**だけを見る。
 */
import { z } from 'zod';
import { CSV_ENCODING_HINTS } from '../application/receivables/bank-csv-decode';
import { HONORIFICS } from '../domain/receivables/customer';
import { INVOICE_STATUSES, ZERO_RATE_KINDS } from '../domain/receivables/invoice';
import { PRICING_MODES, ROUNDING_MODES } from '../domain/receivables/invoice-tax';
import { BANK_TRANSACTION_STATUSES } from '../domain/receivables/bank-transaction';
import { MATCHING_STATUSES } from '../domain/receivables/matching-aggregate';
import { SALES_ENTRY_DATES } from '../domain/receivables/settings';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

const taxRateSchema = z.union([z.literal(10), z.literal(8), z.literal(0)]);
const dateText = z.string().max(20);
const booleanText = z.enum(['true', 'false']);

export const receivablesScopeQuerySchema = scopeQuerySchema;
export const receivablesActionBodySchema = z.object({ scope: tenantScopeSchema.optional() }).optional();

export const saveReceivablesSettingsBodySchema = z.object({
  scope: tenantScopeSchema.optional(),
  settings: z.object({
    issuer: z.object({
      name: z.string().max(200),
      registered: z.boolean(),
      registrationNumber: z.string().max(30).optional(),
      address: z.string().max(500).optional(),
      tel: z.string().max(40).optional(),
      transferAccounts: z.array(z.object({ bankName: z.string(), branchName: z.string(), accountType: z.string(), accountNumber: z.string(), holderKana: z.string() })).max(5),
      note: z.string().max(1000).optional(),
    }),
    rounding: z.object({ mode: z.enum(ROUNDING_MODES), defaultPricing: z.enum(PRICING_MODES) }),
    matching: z.object({ feeTolerance: z.object({ min: z.number(), max: z.number() }), maxCombinationSize: z.number(), partialNameMinLength: z.number() }),
    journal: z.object({
      enabled: z.boolean(),
      accounts: z.object({ sales: z.string(), receivable: z.string(), deposit: z.string(), fee: z.string() }),
      salesTaxCodes: z.object({ '10': z.string(), '8': z.string(), '0': z.string() }),
      feeTaxCode: z.string(),
      nonTaxableTaxCode: z.string(),
      salesEntryDate: z.enum(SALES_ENTRY_DATES),
    }),
    numbering: z.object({ format: z.string().max(100) }),
  }),
});

export const receivablesCustomerListQuerySchema = scopeQuerySchema.extend({ enabled: booleanText.optional() });

export const saveReceivablesCustomerBodySchema = z.object({
  scope: tenantScopeSchema.optional(),
  name: z.string().max(200),
  honorific: z.enum(HONORIFICS).optional(),
  kana: z.string().max(100).optional(),
  registrationNumber: z.string().max(30).optional(),
  paymentTermDays: z.number().optional(),
  address: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
  payerAliases: z.array(z.object({ id: z.string().max(200).optional(), text: z.string().max(200) })).max(50).optional(),
  enabled: z.boolean().optional(),
});

/** 請求書の中身（`SaveInvoiceDto`。ツールの `draft_json` もこの形）。 */
export const receivablesInvoiceContentSchema = z.object({
  customerId: z.string().max(200).optional(),
  issueDate: dateText.optional(),
  transactionDate: dateText.optional(),
  transactionPeriod: z.object({ from: dateText, to: dateText }).optional(),
  dueDate: dateText.optional(),
  pricing: z.enum(PRICING_MODES),
  lines: z.array(z.object({
    description: z.string().max(500),
    quantity: z.number().optional(),
    unit: z.string().max(20).optional(),
    unitPrice: z.number().optional(),
    amount: z.number().optional(),
    taxRate: taxRateSchema.optional(),
    zeroRateKind: z.enum(ZERO_RATE_KINDS).optional(),
  })).max(500),
  declared: z.object({
    lineTaxAmounts: z.array(z.number().nullable()).max(500).optional(),
    taxByRate: z.array(z.object({ rate: taxRateSchema, taxAmount: z.number() })).max(3).optional(),
    grandTotal: z.number().optional(),
  }).optional(),
  note: z.string().max(2000).optional(),
});

export const saveReceivablesInvoiceBodySchema = receivablesInvoiceContentSchema.extend({ scope: tenantScopeSchema.optional() });

export const receivablesInvoiceListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  customerId: z.string().max(200).optional(),
  overdue: booleanText.optional(),
  from: dateText.optional(),
  to: dateText.optional(),
});

export const voidReceivablesInvoiceBodySchema = z.object({ scope: tenantScopeSchema.optional(), reason: z.string().min(1).max(500) });

const columnMappingSchema = z.object({
  date: z.string().max(100),
  description: z.string().max(100).optional(),
  deposit: z.string().max(100).optional(),
  withdrawal: z.string().max(100).optional(),
  amount: z.string().max(100).optional(),
  balance: z.string().max(100).optional(),
  detail: z.string().max(100).optional(),
  payerName: z.string().max(100).optional(),
});

export const saveReceivablesBankCsvProfileBodySchema = z.object({
  scope: tenantScopeSchema.optional(),
  id: z.string().max(200).optional(),
  name: z.string().max(100),
  mapping: columnMappingSchema,
  headerSignature: z.array(z.string().max(100)).max(50).optional(),
  headerRow: z.union([z.number(), z.literal('auto')]).optional(),
  accountKey: z.string().max(100).optional(),
});

/** 生バイト 5 MiB の base64（4/3 倍 + パディング）。 */
const BASE64_MAX_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

export const receivablesBankCsvReadBodySchema = z.object({
  scope: tenantScopeSchema.optional(),
  contentBase64: z.string().min(1).max(BASE64_MAX_CHARS),
  encoding: z.enum(CSV_ENCODING_HINTS).optional(),
  profileId: z.string().max(200).optional(),
  mapping: columnMappingSchema.optional(),
  headerRow: z.number().int().min(1).max(21).optional(),
  accountKey: z.string().max(100).optional(),
  fileName: z.string().max(260).optional(),
});

export const receivablesBankCsvImportBodySchema = receivablesBankCsvReadBodySchema.extend({ forceRows: z.array(z.number().int().min(1)).max(10_000).optional() });

export const receivablesBankTransactionListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(BANK_TRANSACTION_STATUSES).optional(),
  from: dateText.optional(),
  to: dateText.optional(),
  accountKey: z.string().max(100).optional(),
});

export const ignoreReceivablesTransactionBodySchema = z.object({ scope: tenantScopeSchema.optional(), note: z.string().max(500).optional() }).optional();

export const judgeReceivablesBodySchema = z.object({ scope: tenantScopeSchema.optional(), transactionIds: z.array(z.string().max(200)).max(1000).optional() }).optional();

export const receivablesCandidatesQuerySchema = scopeQuerySchema.extend({ transactionId: z.string().min(1).max(200) });

export const confirmReceivablesMatchingBodySchema = z.object({
  scope: tenantScopeSchema.optional(),
  transactionId: z.string().min(1).max(200),
  allocations: z.array(z.object({ invoiceId: z.string().min(1).max(200), amount: z.number().int() })).min(1).max(5),
  feeAmount: z.number().int(),
  expectedOutstanding: z.record(z.string(), z.number().int()).optional(),
  learnAlias: z.object({ customerId: z.string().min(1).max(200) }).optional(),
});

export const receivablesMatchingListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(MATCHING_STATUSES).optional(),
  invoiceId: z.string().max(200).optional(),
  transactionId: z.string().max(200).optional(),
});

export const cancelReceivablesMatchingBodySchema = z.object({ scope: tenantScopeSchema.optional(), removeLearnedAlias: z.boolean().optional() }).optional();
