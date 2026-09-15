/**
 * api層: 仕訳（journal。docs/20-journal.md §9）のリクエスト Zod スキーマ。
 *
 * 業務のスキーマは業務ごとのファイルに置く（ADR-0039）。共通のスコープ検証は `schemas.ts` のものを使う
 * （スコープの扱い＝「受け取るが読まない」は全ルートで同じでなければならないため）。
 */
import { z } from 'zod';
import { ACCOUNT_CATEGORIES, TAX_SIDES } from '../domain/journal/chart-of-accounts';
import { JOURNAL_CSV_PRESET_IDS } from '../domain/journal/csv-presets';
import {
  DIRECTIONS, DOCUMENT_KINDS, DOCUMENT_PAYLOAD_MAX_BYTES, DOCUMENT_SOURCE_TYPES, DOCUMENT_STATUSES,
  EXTRACTION_METHODS, INVOICE_STATUSES, PAYMENT_METHODS, type JsonValue,
} from '../domain/journal/document';
import { DECIDED_BY, ENTRY_STATUSES } from '../domain/journal/entry';
import { AMOUNT_SPEC_KEYWORDS, CONDITION_OPS, ENTRY_SIDES, RULE_MODES, RULE_ORIGINS } from '../domain/journal/rule';
import { JOURNAL_EXPORT_FORMATS } from '../application/journal/export-presets';
import {
  EXTRACT_IMAGE_MAX_CHARS as JOURNAL_EXTRACT_IMAGE_MAX_CHARS,
  EXTRACT_MAX_IMAGES as JOURNAL_EXTRACT_MAX_IMAGES,
  EXTRACT_TEXT_MAX_CHARS as JOURNAL_EXTRACT_TEXT_MAX_CHARS,
} from '../application/journal/extract-document';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

// ---------------------------------------------------------------------------
// 仕訳（journal。docs/20-journal.md §9）
//
// 列挙はすべて domain から import する（api に書き写すと、種別や税区分を足したときに
// 「ドメインは受け付けるのに API が 400 を返す」というずれが静かに生まれる）。
// 値の不変条件（日付の実在・貸借一致・科目 id の一意性…）は domain の create* が正本で、
// ここは**形**だけを見る。金額・日付を `z.number()` / `z.string()` のまま通すのはそのため。
// ---------------------------------------------------------------------------

/**
 * facts の `extra` とルール条件の値（任意の JSON）。
 *
 * **domain の `JsonValue` として型付けする**。`z.ZodType<unknown>` にすると、パース結果が
 * `unknown` のまま `DocumentFacts.extra` や `RuleCondition.value` へ流れて型が合わなくなる
 * （実行時の検証は同じでも、境界で型が消えるとルート側が `as` だらけになる）。
 */
const journalJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(journalJsonValueSchema), z.record(z.string(), journalJsonValueSchema),
])) as z.ZodType<JsonValue>;

const journalTaxRateSchema = z.union([z.literal(10), z.literal(8), z.literal(0)]);

/** 正規化済み事実（§2.2）。 */
export const journalFactsSchema = z.object({
  direction: z.enum(DIRECTIONS).optional(),
  issuerName: z.string().optional(),
  recipientName: z.string().optional(),
  registrationNumber: z.string().optional(),
  issueDate: z.string().optional(),
  transactionDate: z.string().optional(),
  dueDate: z.string().optional(),
  grandTotal: z.number().optional(),
  totalsByRate: z.array(z.object({
    rate: journalTaxRateSchema, taxableAmount: z.number(), taxAmount: z.number().optional(), amountIncludesTax: z.boolean(),
  })).max(10).optional(),
  lines: z.array(z.object({
    description: z.string(), quantity: z.number().optional(), unitPrice: z.number().optional(),
    amount: z.number(), taxRate: journalTaxRateSchema.optional(), reducedRateMark: z.boolean().optional(),
  })).max(500).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  accountHint: z.string().optional(),
  description: z.string().optional(),
  descriptionNorm: z.string().optional(),
  counterpartyHint: z.string().optional(),
  extra: z.record(z.string(), journalJsonValueSchema).optional(),
});

/**
 * 証憑本体。`dataUrl`（画像）と `text`（原文）は domain と同じ 8 MiB を上限にする
 * （domain の検証にも同じ上限があるが、巨大な本文を JSON パース後まで運ばずに入口で断つ）。
 */
export const journalDocumentSourceSchema = z.object({
  type: z.enum(DOCUMENT_SOURCE_TYPES),
  fileName: z.string().max(255).optional(),
  mime: z.string().max(255).optional(),
  dataUrl: z.string().max(DOCUMENT_PAYLOAD_MAX_BYTES).optional(),
  text: z.string().max(DOCUMENT_PAYLOAD_MAX_BYTES).optional(),
  row: z.record(z.string(), z.string()).optional(),
  preset: z.string().max(64).optional(),
});

export const journalExtractionSchema = z.object({
  method: z.enum(EXTRACTION_METHODS),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  confidence: z.number().optional(),
  warnings: z.array(z.string()),
  fieldEvidence: z.record(z.string(), z.object({ sourceText: z.string().optional(), confidence: z.number() })).optional(),
});

/* 科目マスタ -------------------------------------------------------------- */

export const journalAccountSchema = z.object({
  id: z.string().min(1), code: z.string().optional(), name: z.string().min(1),
  category: z.enum(ACCOUNT_CATEGORIES), defaultTaxCode: z.string().optional(),
  aliases: z.array(z.string()), enabled: z.boolean(), sortOrder: z.number(), note: z.string().optional(),
});
export const journalDimensionSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  values: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), enabled: z.boolean() })).max(1000),
});
export const journalTaxCategorySchema = z.object({
  code: z.string().min(1), name: z.string().min(1), side: z.enum(TAX_SIDES),
  rate: z.number().optional(), deductionRate: z.number().optional(), enabled: z.boolean(),
  mapping: z.object({ yayoi: z.string().optional(), freee: z.string().optional(), mf: z.string().optional() }).optional(),
});

export const journalChartQuerySchema = scopeQuerySchema;
export const saveJournalChartBodySchema = z.object({
  scope: tenantScopeSchema,
  accounts: z.array(journalAccountSchema).max(2000),
  dimensions: z.array(journalDimensionSchema).max(50),
  taxCategories: z.array(journalTaxCategorySchema).max(200),
});
export const journalChartActionBodySchema = z.object({ scope: tenantScopeSchema });
/** 科目 CSV の本文はデータソースと同じ 5 MiB を上限にする。 */
export const journalChartImportBodySchema = z.object({
  scope: tenantScopeSchema,
  content: z.string().min(1).max(5 * 1024 * 1024),
});

/* ルール ------------------------------------------------------------------ */

export const journalConditionSchema = z.object({
  field: z.string().min(1), op: z.enum(CONDITION_OPS), value: journalJsonValueSchema.optional(),
});
const journalAmountSpecSchema = z.union([
  z.enum(AMOUNT_SPEC_KEYWORDS),
  z.object({ fixed: z.number() }),
  z.object({ ratio: z.number() }),
]);
export const journalOutcomeLineSchema = z.object({
  side: z.enum(ENTRY_SIDES),
  accountId: z.string().min(1),
  dimensionValues: z.record(z.string(), z.string()).optional(),
  taxCode: z.string().min(1),
  amount: journalAmountSpecSchema,
  partnerFrom: z.union([z.literal('issuerName'), z.literal('counterpartyHint'), z.object({ fixed: z.string() })]).optional(),
});
export const journalRuleDraftSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  enabled: z.boolean(),
  mode: z.enum(RULE_MODES),
  priority: z.number(),
  scope: z.object({
    documentKinds: z.array(z.enum(DOCUMENT_KINDS)).optional(),
    direction: z.enum(DIRECTIONS).optional(),
    accountHints: z.array(z.string()).max(50).optional(),
  }),
  conditions: z.array(journalConditionSchema).max(50),
  outcome: z.object({
    lines: z.array(journalOutcomeLineSchema).min(1).max(100),
    descriptionTemplate: z.string().optional(),
    invoiceStatus: z.union([z.enum(INVOICE_STATUSES), z.literal('auto')]).optional(),
  }),
  askIf: z.array(z.object({
    conditions: z.array(journalConditionSchema).max(50), questionId: z.string().min(1), prompt: z.string().min(1),
  })).max(20),
  requiredFacts: z.array(z.string().min(1)).max(50),
  provenance: z.object({
    origin: z.enum(RULE_ORIGINS), hearingId: z.string().optional(), exampleDocumentIds: z.array(z.string()).max(100),
  }).optional(),
});

export const journalRuleListQuerySchema = scopeQuerySchema;
export const saveJournalRuleBodySchema = z.object({ scope: tenantScopeSchema, rule: journalRuleDraftSchema });
export const journalRuleTestBodySchema = z.object({
  scope: tenantScopeSchema,
  rule: journalRuleDraftSchema,
  documentIds: z.array(z.string().min(1)).max(200),
});

/* 文書 -------------------------------------------------------------------- */

export const journalDocumentListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(0).max(1000).optional(),
});
export const journalDocumentActionQuerySchema = scopeQuerySchema;
export const saveJournalDocumentBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1).optional(),
  kind: z.enum(DOCUMENT_KINDS),
  source: journalDocumentSourceSchema,
  facts: journalFactsSchema,
  extraction: journalExtractionSchema.optional(),
});
/** CSV 本文はデータソース・科目 CSV と同じ 5 MiB。 */
export const journalImportCsvBodySchema = z.object({
  scope: tenantScopeSchema,
  preset: z.enum(JOURNAL_CSV_PRESET_IDS).optional(),
  content: z.string().min(1).max(5 * 1024 * 1024),
  fileName: z.string().max(255).optional(),
  accountHint: z.string().max(255).optional(),
  columnMapping: z.object({
    date: z.string().min(1), description: z.string().min(1),
    withdrawal: z.string().optional(), deposit: z.string().optional(), amount: z.string().optional(),
    balance: z.string().optional(), detail: z.string().optional(),
  }).optional(),
});
export const journalJudgeBodySchema = z.object({
  scope: tenantScopeSchema,
  documentIds: z.array(z.string().min(1)).max(1000).optional(),
});

/* 仕訳 -------------------------------------------------------------------- */

export const journalEntryLineSchema = z.object({
  side: z.enum(ENTRY_SIDES),
  accountId: z.string().min(1),
  /** 応答では確定時の名称を返すが、保存ではマスタから写し直すので受け取っても使わない。 */
  accountName: z.string().optional(),
  dimensionValues: z.record(z.string(), z.string()).optional(),
  taxCode: z.string().min(1),
  amount: z.number(),
  taxAmount: z.number().optional(),
  partner: z.string().optional(),
});
export const journalEntryListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(ENTRY_STATUSES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  documentId: z.string().min(1).optional(),
});
export const saveJournalEntryBodySchema = z.object({
  scope: tenantScopeSchema,
  id: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  ruleId: z.string().min(1).optional(),
  date: z.string().min(1),
  lines: z.array(journalEntryLineSchema).min(1).max(100),
  description: z.string(),
  invoiceStatus: z.enum(INVOICE_STATUSES),
  registrationNumber: z.string().optional(),
  item: z.string().optional(),
  tags: z.array(z.string()).max(50).optional(),
  decidedBy: z.enum(DECIDED_BY).optional(),
});
export const journalEntryActionBodySchema = z.object({ scope: tenantScopeSchema });

/**
 * 仕訳 CSV の出力。`markExported` はクエリなので文字列で受ける
 * （`z.coerce.boolean()` は `'false'` を true にするため使わない）。
 */
export const journalExportQuerySchema = scopeQuerySchema.extend({
  format: z.enum(JOURNAL_EXPORT_FORMATS).optional(),
  status: z.enum(ENTRY_STATUSES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  markExported: z.enum(['true', 'false']).optional(),
});

/* 帳票の LLM 読取（フェーズ 2。docs/20 §6） -------------------------------- */

/**
 * 画像はチャット添付と同じ上限（data URL で 4,200,000 文字）。**SVG と外部 URL は受けない**
 * （サーバーが意図せず外へ取りに行かないため。UI は長辺 2000px の JPEG へ縮小して送る）。
 * 保存はしないので `source` ではなく画像とテキストだけを受け取る。
 */
export const extractJournalDocumentBodySchema = z.object({
  scope: tenantScopeSchema,
  images: z.array(z.string().max(JOURNAL_EXTRACT_IMAGE_MAX_CHARS).regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/)).max(JOURNAL_EXTRACT_MAX_IMAGES).optional(),
  text: z.string().max(JOURNAL_EXTRACT_TEXT_MAX_CHARS).optional(),
  fileName: z.string().max(255).optional(),
  hintKind: z.enum(DOCUMENT_KINDS).optional(),
});

/* ヒアリング（Stage 2。docs/20 §7） ---------------------------------------- */

/** 仕訳の草案（`saveJournalEntryBodySchema` から scope と保存用の id を除いた形）。 */
export const journalEntryDraftSchema = z.object({
  date: z.string().min(1),
  lines: z.array(journalEntryLineSchema).min(1).max(100),
  description: z.string(),
  invoiceStatus: z.enum(INVOICE_STATUSES),
  registrationNumber: z.string().optional(),
  item: z.string().optional(),
  tags: z.array(z.string()).max(50).optional(),
});

export const journalHearingListQuerySchema = scopeQuerySchema.extend({
  documentId: z.string().min(1).optional(),
});
export const journalHearingActionQuerySchema = scopeQuerySchema;
export const startJournalHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  documentId: z.string().min(1),
});
export const answerJournalHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  answers: z.array(z.object({ questionId: z.string().min(1), value: journalJsonValueSchema })).min(1).max(10),
});
/**
 * 受け入れ。`register*` は**利用者が明示的に選んだ id だけ**を並べる
 * （提案に載っていても選ばれなければマスタへ入らない。モデルが科目体系を勝手に増やせない要）。
 */
export const acceptJournalHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  registerAccountIds: z.array(z.string().min(1)).max(10).optional(),
  registerDimensionValueIds: z.array(z.string().min(1)).max(10).optional(),
  registerTaxCodes: z.array(z.string().min(1)).max(5).optional(),
  rule: journalRuleDraftSchema.optional(),
  entry: journalEntryDraftSchema.optional(),
});
export const journalHearingActionBodySchema = z.object({ scope: tenantScopeSchema });
