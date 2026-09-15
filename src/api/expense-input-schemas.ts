/**
 * api層: 経費精算「入力と規程（追加読取・運賃マスタ・規程のヒアリング。docs/21 §20.9.4）」のリクエスト Zod スキーマ。
 *
 * 列挙は domain から import し、共通のスコープ検証は `./schemas` の `tenantScopeSchema` / `scopeQuerySchema` を使う（`expense-schemas.ts` と同じ方針）。
 * 値の不変条件（駅の数・運賃の範囲・有効期間の重なり・日付の実在）は domain の create* / validate* が正本で、ここは形と入口の上限だけを見る。
 */
import { z } from 'zod';
import { EXTRACT_IMAGE_MAX_CHARS } from '../application/journal/extract-document';
import { DETAIL_READ_MAX_IMAGES } from '../application/expense/input/detail-reader';
import { ITEM_EXTRACTION_METHODS } from '../domain/expense/claim';
import { EXTRACTION_FLAGS } from '../domain/expense/detail-read';
import { FARE_TABLE_MAX_ALIASES, FARE_TABLE_MAX_ROUTES } from '../domain/expense/fare-table';
import { HEARING_DOCUMENT_MAX, HEARING_MAX_QUESTIONS_PER_TURN, HEARING_MODES, HEARING_STATUSES } from '../domain/expense/policy-hearing';
import { ROUTE_FARE_TYPES, ROUTE_MAX_STATIONS, ROUTE_MAX_TRIPS } from '../domain/expense/receipt-facts';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

/** CSV 本文はデータソース・科目 CSV と同じ 5 MiB。 */
const CSV_MAX_CHARS = 5 * 1024 * 1024;
const imageSchema = z.string().max(EXTRACT_IMAGE_MAX_CHARS).regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u);
const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const extractExpenseDetailBodySchema = z.object({
  scope: tenantScopeSchema,
  images: z.array(imageSchema).min(1).max(DETAIL_READ_MAX_IMAGES),
  draft: z.object({
    categoryId: z.string().max(64).optional(),
    categoryText: z.string().max(200).optional(),
    facts: z.record(z.string(), z.unknown()),
    source: z.object({ type: z.enum(['image', 'pdf']), fileName: z.string().max(255).optional() }).optional(),
    extraction: z.object({
      method: z.enum(ITEM_EXTRACTION_METHODS),
      model: z.object({ provider: z.string().max(200), model: z.string().max(200) }).optional(),
      confidence: z.number().min(0).max(1).optional(),
      warnings: z.array(z.string().max(2000)).max(100),
      documentKind: z.string().max(64).optional(),
      rejectedRegistrationNumber: z.string().max(64).optional(),
      flags: z.array(z.enum(EXTRACTION_FLAGS)).max(EXTRACTION_FLAGS.length).optional(),
      detail: z.unknown().optional(),
    }),
  }),
});

const fareRouteSchema = z.object({
  id: z.string().max(64),
  stations: z.array(z.string().max(100)).max(ROUTE_MAX_STATIONS),
  fareType: z.enum(ROUTE_FARE_TYPES),
  fare: z.number(),
  bidirectional: z.boolean(),
  validFrom: optionalText(10),
  validTo: optionalText(10),
  note: optionalText(500),
});

export const saveExpenseFaresBodySchema = z.object({
  scope: tenantScopeSchema,
  routes: z.array(fareRouteSchema).max(FARE_TABLE_MAX_ROUTES),
  stationAliases: z.array(z.object({ name: z.string().max(100), aliases: z.array(z.string().max(100)).max(50) })).max(FARE_TABLE_MAX_ALIASES),
});

export const importExpenseFaresBodySchema = z.object({ scope: tenantScopeSchema, content: z.string().max(CSV_MAX_CHARS) });

export const lookupExpenseFareBodySchema = z.object({
  scope: tenantScopeSchema,
  stations: z.array(z.string().max(100)).max(ROUTE_MAX_STATIONS),
  fareType: z.enum(ROUTE_FARE_TYPES).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  trips: z.number().int().min(1).max(ROUTE_MAX_TRIPS).optional(),
  employeeId: z.string().min(1).max(64).optional(),
});

export const expenseInputScopeQuerySchema = scopeQuerySchema;

export const startExpensePolicyHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  mode: z.enum(HEARING_MODES),
  documentText: z.string().max(HEARING_DOCUMENT_MAX).optional(),
  fileName: z.string().max(255).optional(),
});

export const listExpensePolicyHearingsQuerySchema = scopeQuerySchema.extend({ status: z.enum(HEARING_STATUSES).optional() });

export const answerExpensePolicyHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  answers: z.array(z.object({
    questionId: z.string().min(1).max(64),
    value: z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(20)]),
  })).min(1).max(HEARING_MAX_QUESTIONS_PER_TURN),
});

export const acceptExpensePolicyHearingBodySchema = z.object({
  scope: tenantScopeSchema,
  changeIds: z.array(z.string().min(1).max(300)).min(1).max(500),
  basePolicyUpdatedAt: z.string().min(1).max(64),
});

export const expenseInputActionBodySchema = z.object({ scope: tenantScopeSchema });
