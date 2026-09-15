/**
 * api層: 経費精算（expense。docs/21-expense.md §10）のリクエスト Zod スキーマ。
 *
 * 列挙はすべて domain から import する（api に書き写すと、費目の属性や状態を足したときに
 * 「ドメインは受け付けるのに API が 400 を返す」ずれが静かに生まれる）。値の不変条件（日付の実在・上限の範囲・
 * 名前の一意性…）は domain の create* が正本で、ここは**形**と、巨大な本文を入口で断つ上限だけを見る。
 * 共通のスコープ検証は `schemas.ts` のものを使う（ADR-0039）。
 */
import { z } from 'zod';
import { EXTRACT_IMAGE_MAX_CHARS, EXTRACT_MAX_IMAGES, EXTRACT_TEXT_MAX_CHARS } from '../application/journal/extract-document';
import { CLAIM_STATUSES, ITEM_EXTRACTION_METHODS, ITEM_SOURCE_TYPES } from '../domain/expense/claim';
import { EXTRACTION_FLAGS } from '../domain/expense/detail-read';
import { VERDICTS } from '../domain/expense/judgment';
import { EXPENSE_TAX_RATES, PARTNER_FROM, PER_PERSON_BASES } from '../domain/expense/policy';
import { SEVERITY_OVERRIDES } from '../domain/expense/reason-codes';
import { RECEIPT_PAYLOAD_MAX_BYTES } from '../domain/expense/receipt';
import { DATE_SOURCES, ROUTE_FARE_TYPES, ROUTE_MAX_STATIONS } from '../domain/expense/receipt-facts';
import { SETTLEMENT_FORMATS } from '../domain/expense/settlement-csv';
import { PAYMENT_METHODS } from '../domain/journal/document';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

/** CSV 本文はデータソース・科目 CSV と同じ 5 MiB。 */
const CSV_MAX_CHARS = 5 * 1024 * 1024;

const taxRateSchema = z.union([z.literal(EXPENSE_TAX_RATES[0]), z.literal(EXPENSE_TAX_RATES[1]), z.literal(EXPENSE_TAX_RATES[2])]);
const requirementSchema = z.object({ required: z.boolean(), exemptBelow: z.number().optional() });

export const expenseCategorySchema = z.object({
  id: z.string().min(1).max(64),
  code: z.string().max(64).optional(),
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  sortOrder: z.number(),
  aliases: z.array(z.string().max(200)).max(50),
  accountId: z.string().max(128).optional(),
  defaultTaxRate: taxRateSchema,
  taxCodeByRate: z.object({ '10': z.string().max(64).optional(), '8': z.string().max(64).optional(), '0': z.string().max(64).optional() }),
  receipt: requirementSchema,
  invoice: requirementSchema,
  requires: z.object({ purpose: z.boolean(), attendees: z.boolean(), attendeeDetails: z.boolean() }),
  limits: z.object({
    perItem: z.number().optional(),
    perClaim: z.number().optional(),
    perPerson: z.number().optional(),
    perPersonBasis: z.enum(PER_PERSON_BASES),
    perUnit: z.object({ label: z.string(), amount: z.number() }).optional(),
  }),
  note: z.string().max(500).optional(),
  // 交通費の検査（§20.2.2）。null で消す（省略は現在の値を保つ。SaveExpensePolicyUseCase）。
  route: z.object({ required: z.boolean(), commuterPass: z.boolean(), fareTable: z.boolean() }).nullable().optional(),
});

export const expensePreApprovalRuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  categoryIds: z.array(z.string().min(1)).max(200),
  minAmount: z.number().optional(),
  minPerPerson: z.number().optional(),
  note: z.string().max(500).optional(),
});

export const expenseClaimRulesSchema = z.object({
  submissionDeadlineDays: z.number().optional(),
  nonReimbursablePaymentMethods: z.array(z.enum(PAYMENT_METHODS)).max(PAYMENT_METHODS.length),
  attendeesIncludeClaimant: z.boolean(),
  forbidSelfApproval: z.boolean(),
});

export const expenseJournalSettingsSchema = z.object({
  creditAccountId: z.string().min(1).max(128),
  creditTaxCode: z.string().min(1).max(64),
  partnerFrom: z.enum(PARTNER_FROM),
  descriptionTemplate: z.string().max(200),
  /** 空文字で消す（省略は現在の値を保つ）。 */
  departmentDimensionId: z.string().max(64).optional(),
});

export const expenseScopeQuerySchema = scopeQuerySchema;
export const expenseActionBodySchema = z.object({ scope: tenantScopeSchema });

export const saveExpensePolicyBodySchema = z.object({
  scope: tenantScopeSchema,
  categories: z.array(expenseCategorySchema).max(200),
  claimRules: expenseClaimRulesSchema,
  preApprovalRules: z.array(expensePreApprovalRuleSchema).max(50),
  severityOverrides: z.record(z.string(), z.enum(SEVERITY_OVERRIDES)),
  journal: expenseJournalSettingsSchema,
  // 実用化の節（§20.2.2）。中身の検証は domain の createExpensePolicy が正本なので、ここは形（オブジェクト）だけを見る。省略した節は現在の値を保つ。
  approval: z.record(z.string(), z.unknown()).optional(),
  transport: z.record(z.string(), z.unknown()).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  advance: z.record(z.string(), z.unknown()).optional(),
});

export const expensePolicyImportBodySchema = z.object({ scope: tenantScopeSchema, content: z.string().min(1).max(CSV_MAX_CHARS) });

/* 申請 --------------------------------------------------------------------- */

/** `employeeId` を指定したら、サーバーが従業員マスタから氏名・社員番号・部門の写しを埋める（本文の値は使わない。§20.9.1）。 */
export const expenseClaimantSchema = z.object({ name: z.string().max(100), employeeCode: z.string().max(100).optional(), department: z.string().max(100).optional(), employeeId: z.string().max(64).optional() });
export const expensePeriodSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

export const expenseClaimListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(CLAIM_STATUSES).optional(),
  verdict: z.enum(VERDICTS).optional(),
  claimant: z.string().max(100).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  employeeId: z.string().max(64).optional(),
  departmentId: z.string().max(64).optional(),
  advanceId: z.string().max(64).optional(),
  /** 現在の段の承認者に自分の従業員が入っている申請（単一ユーザーは checked / in-approval の全件）。 */
  awaiting: z.literal('me').optional(),
  unlinked: z.enum(['true', 'false']).optional(),
});

export const saveExpenseClaimBodySchema = z.object({
  scope: tenantScopeSchema,
  claimant: expenseClaimantSchema,
  period: expensePeriodSchema,
  title: z.string().max(200).optional(),
});

export const expenseFactsSchema = z.object({
  transactionDate: z.string().optional(),
  issueDate: z.string().optional(),
  payeeName: z.string().optional(),
  registrationNumber: z.string().max(64).optional(),
  amount: z.number().optional(),
  totalsByRate: z.array(z.object({ rate: taxRateSchema, taxableAmount: z.number(), taxAmount: z.number().optional(), amountIncludesTax: z.boolean() })).max(10).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  corporatePayment: z.boolean().optional(),
  description: z.string().optional(),
  purpose: z.string().optional(),
  attendees: z.object({ count: z.number().optional(), names: z.array(z.string()).max(50).optional(), relation: z.string().optional() }).optional(),
  unitCount: z.number().optional(),
  preApprovalRef: z.string().optional(),
  dateSource: z.enum(DATE_SOURCES).optional(),
  route: z.object({ stations: z.array(z.string().max(40)).max(ROUTE_MAX_STATIONS), trips: z.number().optional(), fareType: z.enum(ROUTE_FARE_TYPES).optional() }).optional(),
});

export const saveExpenseItemBodySchema = z.object({
  scope: tenantScopeSchema,
  itemId: z.string().min(1).max(64).optional(),
  categoryId: z.string().max(64).optional(),
  categoryText: z.string().max(200).optional(),
  facts: expenseFactsSchema,
  source: z.object({ type: z.enum(ITEM_SOURCE_TYPES), fileName: z.string().max(255).optional(), row: z.record(z.string(), z.string()).optional() }),
  extraction: z.object({
    method: z.enum(ITEM_EXTRACTION_METHODS).optional(),
    model: z.object({ provider: z.string(), model: z.string() }).optional(),
    confidence: z.number().optional(),
    warnings: z.array(z.string().max(2000)).max(50).optional(),
    documentKind: z.string().max(64).optional(),
    rejectedRegistrationNumber: z.string().max(64).optional(),
    flags: z.array(z.enum(EXTRACTION_FLAGS)).max(EXTRACTION_FLAGS.length).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  receipt: z.object({
    // SVG と外部 URL は受けない（サーバーが意図せず外へ取りに行かないため）。
    dataUrl: z.string().max(RECEIPT_PAYLOAD_MAX_BYTES).regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u),
    fileName: z.string().max(255).optional(),
    mime: z.string().max(255).optional(),
    text: z.string().max(RECEIPT_PAYLOAD_MAX_BYTES).optional(),
  }).optional(),
});

export const importExpenseCsvBodySchema = z.object({
  scope: tenantScopeSchema,
  content: z.string().min(1).max(CSV_MAX_CHARS),
  period: expensePeriodSchema,
  claimId: z.string().min(1).optional(),
  fileName: z.string().max(255).optional(),
});

export const extractExpenseReceiptBodySchema = z.object({
  scope: tenantScopeSchema,
  images: z.array(z.string().max(EXTRACT_IMAGE_MAX_CHARS).regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u)).min(1).max(EXTRACT_MAX_IMAGES),
  text: z.string().max(EXTRACT_TEXT_MAX_CHARS).optional(),
  fileName: z.string().max(255).optional(),
  /** 経費専用の追加読取も続けて行う（既定 false。§20.7.1）。 */
  detail: z.boolean().optional(),
});

export const checkExpenseClaimsBodySchema = z.object({ scope: tenantScopeSchema, claimIds: z.array(z.string().min(1)).max(500).optional() });
export const acknowledgeExpenseReasonBodySchema = z.object({ scope: tenantScopeSchema, itemId: z.string().min(1).optional(), code: z.string().min(1).max(64), note: z.string().max(500) });
export const returnExpenseClaimBodySchema = z.object({ scope: tenantScopeSchema, message: z.string().max(4000) });
export const approveExpenseClaimBodySchema = z.object({ scope: tenantScopeSchema, comment: z.string().max(500).optional(), stepId: z.string().min(1).max(64).optional() });
export const unapproveExpenseClaimBodySchema = z.object({ scope: tenantScopeSchema, note: z.string().max(500) });

export const expenseExportQuerySchema = scopeQuerySchema.extend({
  format: z.enum(SETTLEMENT_FORMATS),
  status: z.enum(['approved', 'settled']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const settleExpenseClaimsBodySchema = z.object({
  scope: tenantScopeSchema,
  claimIds: z.array(z.string().min(1)).min(1).max(500),
  exportFileName: z.string().max(255).optional(),
});
