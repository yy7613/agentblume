/**
 * api層: 契約書レビューと期限台帳（docs/23-contract.md §6）のリクエスト Zod スキーマ。
 *
 * 列挙は domain から import し（API に書き写すと、種類を足したときに「ドメインは受け付けるのに API が 400」というずれが生まれる）、
 * ここは**形**だけを見る。値の不変条件（トピック id の一意性・条件のパス・置換子・日付の実在…）は domain の create* が正本。
 * 審査基準のトピック・基準・法令設定・印紙税表と条項は入れ子が深いので、オブジェクトであることだけを見て domain へ渡す。
 */
import { z } from 'zod';
import { TRANSCRIBE_IMAGE_MAX_CHARS, TRANSCRIBE_MAX_IMAGES } from '../application/contract/transcribe-pages';
import { BODY_MAX_CHARS, CONTRACT_DOCUMENT_STATUSES, CONTRACT_SOURCE_TYPES, MAX_PAGES } from '../domain/contract/document';
import { DEADLINE_KINDS, SIGNED_CONTRACT_STATUSES } from '../domain/contract/signed-contract';
import { CONTRACT_NATURES, OUR_ROLES, PARTY_KEYS, PROFILE_ANSWERS, SIGNING_METHODS } from '../domain/contract/vocabulary';
import { scopeQuerySchema, tenantScopeSchema } from './schemas';

const scope = tenantScopeSchema.optional();
const record = z.record(z.string(), z.unknown());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be a date in YYYY-MM-DD');

export const contractScopeQuerySchema = scopeQuerySchema;
export const contractActionBodySchema = z.object({ scope }).optional();

export const savePlaybookBodySchema = z.object({
  scope,
  id: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100),
  isDefault: z.boolean(),
  ourRole: z.enum(OUR_ROLES),
  ourCompanyNames: z.array(z.string().max(100)).max(20),
  topics: z.array(record).min(1).max(50),
  criteria: z.array(record).max(200),
  legal: record,
  stampDuty: record,
  extraction: record,
  templateId: z.string().min(1).max(64).optional(),
});

export const playbookFromTemplateBodySchema = z.object({
  scope,
  templateId: z.string().min(1).max(64),
  name: z.string().max(100).optional(),
  isDefault: z.boolean().optional(),
  ourCompanyNames: z.array(z.string().min(1).max(100)).max(20).optional(),
});

export const documentListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(CONTRACT_DOCUMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const pageSchema = z.object({
  page: z.number().int().min(1).max(MAX_PAGES),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  method: z.enum(['text-layer', 'vision']),
  warnings: z.array(z.string().max(500)).max(20).default([]),
});

/** 取込と更新で同じ形（本文・ページ境界・当事者・立場・相手方区分）。 */
export const documentBodySchema = z.object({
  scope,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(BODY_MAX_CHARS, `body must be at most ${BODY_MAX_CHARS} characters; split the appendices and import them separately`),
  source: z.object({
    type: z.enum(CONTRACT_SOURCE_TYPES),
    fileName: z.string().max(200).optional(),
    pageCount: z.number().int().min(1).max(MAX_PAGES).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  }),
  pages: z.array(pageSchema).max(MAX_PAGES).optional(),
  parties: z.object({ A: z.string().max(200).optional(), B: z.string().max(200).optional() }).optional(),
  ourParty: z.enum(PARTY_KEYS).optional(),
  ourRole: z.enum(OUR_ROLES).optional(),
  counterpartyProfile: z.object({ toriteki: z.enum(PROFILE_ANSWERS), freelance: z.enum(PROFILE_ANSWERS) }).optional(),
  contractNature: z.enum(CONTRACT_NATURES).optional(),
  contractAmount: z.number().int().min(0).optional(),
  playbookId: z.string().min(1).max(100).optional(),
});

export const transcribeBodySchema = z.object({
  scope,
  images: z.array(z.string().max(TRANSCRIBE_IMAGE_MAX_CHARS)).min(1).max(TRANSCRIBE_MAX_IMAGES),
  fileName: z.string().max(200).optional(),
});

export const extractBodySchema = z.object({
  scope,
  playbookId: z.string().min(1).max(100).optional(),
  scanAllArticles: z.boolean().optional(),
  articleRefs: z.array(z.string().min(1).max(100)).min(1).max(200).optional(),
}).optional();

export const confirmClausesBodySchema = z.object({
  scope,
  clauses: z.array(record).max(100),
  ourParty: z.enum(PARTY_KEYS).optional(),
  contractNature: z.enum(CONTRACT_NATURES).optional(),
  playbookId: z.string().min(1).max(100).optional(),
});

export const runReviewBodySchema = z.object({ scope, playbookId: z.string().min(1).max(100).optional() }).optional();

export const reviewDecisionsBodySchema = z.object({
  scope,
  decisions: z.array(z.object({
    topicId: z.string().min(1).max(64),
    decision: z.enum(['accept', 'negotiate', 'reject']).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })).min(1).max(100),
});

export const deadlinePreviewBodySchema = z.object({
  scope,
  documentId: z.string().min(1),
  signedDate: isoDate.optional(),
  signingMethod: z.enum(SIGNING_METHODS).optional(),
  contractAmount: z.number().int().min(0).optional(),
  playbookId: z.string().min(1).max(100).optional(),
});

const stampDutySchema = z.object({
  documentTypeCode: z.string().max(20).optional(),
  amount: z.number().int().min(0).optional(),
  affixed: z.boolean().nullable(),
});

export const registerSignedBodySchema = z.object({
  scope,
  documentId: z.string().min(1),
  signedDate: isoDate,
  signingMethod: z.enum(SIGNING_METHODS),
  title: z.string().min(1).max(200).optional(),
  counterpartyName: z.string().min(1).max(200).optional(),
  stampDuty: stampDutySchema.optional(),
  playbookId: z.string().min(1).max(100).optional(),
});

export const signedListQuerySchema = scopeQuerySchema.extend({
  status: z.enum(SIGNED_CONTRACT_STATUSES).optional(),
  counterparty: z.string().max(200).optional(),
});

export const updateSignedBodySchema = z.object({
  scope,
  title: z.string().min(1).max(200).optional(),
  counterpartyName: z.string().min(1).max(200).optional(),
  signedDate: isoDate.optional(),
  signingMethod: z.enum(SIGNING_METHODS).optional(),
  stampDuty: stampDutySchema.optional(),
  clauses: z.array(record).max(100).optional(),
  customDeadlines: z.array(z.object({ id: z.string().min(1).max(100).optional(), dueDate: isoDate, basis: z.string().min(1).max(300), note: z.string().max(500).optional() })).max(50).optional(),
});

export const terminateSignedBodySchema = z.object({ scope, terminatedAt: isoDate, reason: z.string().max(500).optional() });

export const deadlineLedgerQuerySchema = scopeQuerySchema.extend({
  withinDays: z.coerce.number().int().min(0).max(36_500).optional(),
  includeOverdue: z.enum(['true', 'false']).optional(),
  kind: z.enum(DEADLINE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
});

export const completeDeadlineBodySchema = z.object({ scope, note: z.string().max(500).optional() }).optional();
