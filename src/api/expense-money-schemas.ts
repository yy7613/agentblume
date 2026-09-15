/**
 * api層: 経費精算「お金の流れ（仮払・カード明細・集計。docs/21 §20.9.3）」のリクエスト Zod スキーマ。
 *
 * 列挙は domain から import し、共通のスコープ検証は `./schemas` の `tenantScopeSchema` / `scopeQuerySchema` を使う（`expense-schemas.ts` と同じ方針）。
 * 値の不変条件（日付の実在・金額の範囲・精算予定日の前後）は domain の create* が正本で、ここは形と入口の上限だけを見る。
 */
import { z } from 'zod';
import { ADVANCE_AMOUNT_MAX, ADVANCE_PAYMENT_METHODS, ADVANCE_PURPOSE_MAX, ADVANCE_STATUSES } from '../domain/expense/advance';
import { CARD_AMOUNT_SIGNS, CARD_SETTINGS_MAX_CARDS, CARD_SETTINGS_MAX_PROFILES, CARD_SKIP_LINES_MAX, CARD_TRANSACTION_STATUSES } from '../domain/expense/card';
import { SUMMARY_BASES } from '../domain/expense/money/summary';
import { PAYOUT_BATCH_STATUSES, PAYOUT_MAX_RECORDS_LIMIT, PAYOUT_SOURCE_ACCOUNT_TYPES } from '../domain/expense/payout';
import { ZENGIN_CHARSETS } from '../domain/expense/zengin-charset';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

/** CSV 本文はデータソース・科目 CSV と同じ 5 MiB。 */
const CSV_MAX_CHARS = 5 * 1024 * 1024;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be a date in YYYY-MM-DD');
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/u, 'must be a month in YYYY-MM');
const idSchema = z.string().min(1).max(128);
const noteSchema = z.string().trim().min(1).max(500);

export const moneyScopeQuerySchema = scopeQuerySchema;
export const moneyActionBodySchema = z.object({ scope: tenantScopeSchema });

/* 仮払 ------------------------------------------------------------------- */

export const advanceListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(ADVANCE_STATUSES).optional(),
  employeeId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const advanceFields = {
  purpose: z.string().min(1).max(ADVANCE_PURPOSE_MAX),
  amount: z.number().int().min(1).max(ADVANCE_AMOUNT_MAX),
  neededOn: dateSchema,
  plannedSettleBy: dateSchema,
};

export const createAdvanceBodySchema = z.object({ scope: tenantScopeSchema, employeeId: idSchema, ...advanceFields });
export const updateAdvanceBodySchema = z.object({ scope: tenantScopeSchema, ...advanceFields });
export const approveAdvanceBodySchema = z.object({ scope: tenantScopeSchema, comment: z.string().max(500).optional() });
export const advanceNoteBodySchema = z.object({ scope: tenantScopeSchema, note: noteSchema });
export const advancePaymentBodySchema = z.object({ scope: tenantScopeSchema, paidOn: dateSchema, method: z.enum(ADVANCE_PAYMENT_METHODS) });
export const advanceRefundBodySchema = z.object({ scope: tenantScopeSchema, receivedOn: dateSchema });
export const advanceJournalBodySchema = z.object({ scope: tenantScopeSchema, stage: z.enum(['payment', 'settlement']) });
export const claimAdvanceBodySchema = z.object({ scope: tenantScopeSchema, advanceId: idSchema.nullable() });

/* カード ----------------------------------------------------------------- */

const columnName = z.string().min(1).max(200);
const cardColumnsSchema = z.object({
  usedOn: columnName, merchant: columnName, amount: columnName,
  postedOn: columnName.optional(), cardLast4: columnName.optional(), memo: columnName.optional(),
});

export const cardMappingSchema = z.object({
  columns: cardColumnsSchema,
  amountSign: z.enum(CARD_AMOUNT_SIGNS),
  skipLinesBefore: z.number().int().min(0).max(CARD_SKIP_LINES_MAX),
});

export const cardSettingsBodySchema = z.object({
  scope: tenantScopeSchema,
  cards: z.array(z.object({
    id: z.string().min(1).max(64), label: z.string().min(1).max(100), issuerName: z.string().max(100).optional(),
    last4: z.string().regex(/^\d{4}$/u, 'must be 4 digits'), holderEmployeeId: z.string().max(64).optional(), enabled: z.boolean(),
  })).max(CARD_SETTINGS_MAX_CARDS),
  profiles: z.array(z.object({
    id: z.string().min(1).max(64), name: z.string().min(1).max(100), headerSignature: z.array(z.string().max(200)).min(1).max(100),
    columns: cardColumnsSchema, amountSign: z.enum(CARD_AMOUNT_SIGNS), skipLinesBefore: z.number().int().min(0).max(CARD_SKIP_LINES_MAX),
  })).max(CARD_SETTINGS_MAX_PROFILES),
});

export const cardStatementPreviewBodySchema = z.object({
  scope: tenantScopeSchema,
  content: z.string().min(1).max(CSV_MAX_CHARS),
  profileId: z.string().min(1).max(64).optional(),
  mapping: cardMappingSchema.optional(),
  cardId: z.string().min(1).max(64).optional(),
});

export const cardStatementImportBodySchema = cardStatementPreviewBodySchema.extend({
  fileName: z.string().min(1).max(255),
  saveProfileAs: z.string().max(100).optional(),
});

export const cardImportListQuerySchema = scopeQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(1000).optional() });

export const cardTransactionListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(CARD_TRANSACTION_STATUSES).optional(),
  cardId: z.string().min(1).max(64).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  claimId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const cardMatchBodySchema = z.object({ scope: tenantScopeSchema, from: dateSchema.optional(), to: dateSchema.optional() });
export const cardExcludeBodySchema = z.object({ scope: tenantScopeSchema, reason: z.string().trim().min(1).max(200) });
export const cardLinkBodySchema = z.object({ scope: tenantScopeSchema, claimId: idSchema, itemId: idSchema });

/* 振込データ（UC3） ------------------------------------------------------ */

const kanaSchema = z.string().max(100);
const idListSchema = z.array(idSchema).max(500);

export const payoutSettingsBodySchema = z.object({
  scope: tenantScopeSchema,
  source: z.object({
    bankCode: z.string().max(10), bankNameKana: kanaSchema.optional(), branchCode: z.string().max(10), branchNameKana: kanaSchema.optional(),
    accountType: z.enum(PAYOUT_SOURCE_ACCOUNT_TYPES),
    // 平文。省略 = 既存の口座番号を保つ。
    accountNumber: z.string().max(20).optional(),
  }).nullable().optional(),
  requesterCode: z.string().max(20).optional(),
  requesterNameKana: kanaSchema.optional(),
  format: z.object({
    lineEnding: z.enum(['crlf', 'none']).optional(), eofMark: z.boolean().optional(), includeBankNames: z.boolean().optional(),
    clearingHouse: z.enum(['zeros', 'spaces']).optional(), transferKind: z.enum(['7', '8', 'space']).optional(), newCode: z.enum(['0', '1', '2']).optional(),
    customerCode1: z.enum(['none', 'employee-code']).optional(), charset: z.enum(ZENGIN_CHARSETS).optional(), maxRecords: z.number().int().min(1).max(PAYOUT_MAX_RECORDS_LIMIT).optional(),
  }).optional(),
  journal: z.object({ createPaymentEntry: z.boolean().optional(), sourceAccountId: z.string().min(1).max(128).optional() }).optional(),
});

export const payoutPreviewBodySchema = z.object({ scope: tenantScopeSchema, claimIds: idListSchema.optional(), advanceIds: idListSchema.optional(), transferDate: dateSchema });
export const payoutCreateBodySchema = payoutPreviewBodySchema.extend({ acknowledgedWarnings: z.array(z.string().max(64)).max(20) });
export const payoutListQuerySchema = scopeQuerySchema.extend({ status: z.enum(PAYOUT_BATCH_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
export const payoutConfirmBodySchema = z.object({ scope: tenantScopeSchema, note: z.string().max(500).optional() });
export const payoutCancelBodySchema = z.object({ scope: tenantScopeSchema, note: noteSchema });

/* 集計 ------------------------------------------------------------------- */

export const summaryQuerySchema = scopeQuerySchema.extend({
  from: monthSchema,
  to: monthSchema,
  groupBy: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  basis: z.enum(SUMMARY_BASES).optional(),
});
