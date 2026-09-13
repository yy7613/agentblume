/**
 * ドメイン: 仕訳 BC の直列化。
 *
 * 永続化アダプタは Serialized 型を JSON 化して 1 列（record_json）に保存する。復元は必ず create* を通し、
 * 保存済みデータにも同じ不変条件を課す。zod は**形**（トップレベルの型と必須キー）だけを見て未知のキーを落とし、
 * 値の不変条件（日付形式・貸借一致・科目の一意性 …）は create* が検証する。
 */
import { z } from 'zod';
import { createChartOfAccounts, type ChartOfAccounts } from './chart-of-accounts';
import { createJournalDocument, type JournalDocument } from './document';
import { createJournalEntry, type JournalEntry } from './entry';
import { JournalDomainError } from './errors';
import { createHearingSession, type HearingSession } from './hearing';
import { createJournalRule, type JournalRule } from './rule';

export type SerializedChartOfAccounts = ChartOfAccounts;
export type SerializedJournalDocument = JournalDocument;
export type SerializedJournalRule = JournalRule;
export type SerializedJournalEntry = JournalEntry;
export type SerializedHearingSession = HearingSession;

const tenantSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });

const chartSchema = z.object({
  accounts: z.array(z.object({
    id: z.string(), code: z.string().optional(), name: z.string(), category: z.string(), defaultTaxCode: z.string().optional(),
    aliases: z.array(z.string()), enabled: z.boolean(), sortOrder: z.number(), note: z.string().optional(),
  })),
  dimensions: z.array(z.object({ id: z.string(), name: z.string(), values: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })) })),
  taxCategories: z.array(z.object({
    code: z.string(), name: z.string(), side: z.string(), rate: z.number().optional(), deductionRate: z.number().optional(), enabled: z.boolean(),
    mapping: z.object({ yayoi: z.string().optional(), freee: z.string().optional(), mf: z.string().optional() }).optional(),
  })),
  updatedAt: z.string(),
});

const documentSchema = z.object({
  tenant: tenantSchema,
  id: z.string(),
  kind: z.string(),
  source: z.object({ type: z.string(), fileName: z.string().optional(), mime: z.string().optional(), dataUrl: z.string().optional(), text: z.string().optional(), row: z.record(z.string(), z.string()).optional(), preset: z.string().optional() }),
  facts: z.record(z.string(), z.unknown()),
  extraction: z.object({
    method: z.string(), model: z.object({ provider: z.string(), model: z.string() }).optional(), confidence: z.number().optional(), warnings: z.array(z.string()),
    fieldEvidence: z.record(z.string(), z.object({ sourceText: z.string().optional(), confidence: z.number() })).optional(),
  }),
  status: z.string(),
  judgment: z.record(z.string(), z.unknown()).optional(),
  entryId: z.string().optional(),
  hearingId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const conditionSchema = z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() });

const ruleSchema = z.object({
  tenant: tenantSchema,
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  mode: z.string(),
  priority: z.number(),
  scope: z.object({ documentKinds: z.array(z.string()).optional(), direction: z.string().optional(), accountHints: z.array(z.string()).optional() }),
  conditions: z.array(conditionSchema),
  outcome: z.object({
    lines: z.array(z.object({
      side: z.string(), accountId: z.string(), dimensionValues: z.record(z.string(), z.string()).optional(), taxCode: z.string(),
      amount: z.unknown(), partnerFrom: z.unknown().optional(),
    })),
    descriptionTemplate: z.string().optional(),
    invoiceStatus: z.string().optional(),
  }),
  askIf: z.array(z.object({ conditions: z.array(conditionSchema), questionId: z.string(), prompt: z.string() })),
  requiredFacts: z.array(z.string()),
  provenance: z.object({ origin: z.string(), hearingId: z.string().optional(), exampleDocumentIds: z.array(z.string()) }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const entryLineSchema = z.object({
  side: z.string(), accountId: z.string(), accountName: z.string(), dimensionValues: z.record(z.string(), z.string()).optional(),
  taxCode: z.string(), amount: z.number(), taxAmount: z.number().optional(), partner: z.string().optional(),
});

const entrySchema = z.object({
  tenant: tenantSchema,
  id: z.string(),
  documentId: z.string().optional(),
  ruleId: z.string().optional(),
  date: z.string(),
  lines: z.array(entryLineSchema),
  description: z.string(),
  invoiceStatus: z.string(),
  registrationNumber: z.string().optional(),
  item: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string(),
  decidedBy: z.string(),
  confidence: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const hearingSchema = z.object({
  tenant: tenantSchema,
  id: z.string(),
  documentId: z.string(),
  status: z.string(),
  turns: z.array(z.record(z.string(), z.unknown())),
  proposal: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new JournalDomainError(`${label}: invalid record: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

/** zod が optional キーを `undefined` 値で残すことがあるため落とす。 */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function serializeChartOfAccounts(chart: ChartOfAccounts): SerializedChartOfAccounts { return structuredClone(chart); }
export function deserializeChartOfAccounts(value: unknown): ChartOfAccounts {
  return createChartOfAccounts(parseOrThrow(chartSchema, value, 'deserializeChartOfAccounts') as ChartOfAccounts);
}

export function serializeJournalDocument(document: JournalDocument): SerializedJournalDocument { return structuredClone(document); }
export function deserializeJournalDocument(value: unknown): JournalDocument {
  const parsed = stripUndefined(parseOrThrow(documentSchema, value, 'deserializeJournalDocument'));
  return createJournalDocument(parsed as unknown as Parameters<typeof createJournalDocument>[0]);
}

export function serializeJournalRule(rule: JournalRule): SerializedJournalRule { return structuredClone(rule); }
export function deserializeJournalRule(value: unknown): JournalRule {
  const parsed = stripUndefined(parseOrThrow(ruleSchema, value, 'deserializeJournalRule'));
  return createJournalRule(parsed as unknown as Parameters<typeof createJournalRule>[0]);
}

export function serializeJournalEntry(entry: JournalEntry): SerializedJournalEntry { return structuredClone(entry); }
export function deserializeJournalEntry(value: unknown): JournalEntry {
  const parsed = stripUndefined(parseOrThrow(entrySchema, value, 'deserializeJournalEntry'));
  return createJournalEntry(parsed as unknown as Parameters<typeof createJournalEntry>[0]);
}

export function serializeHearingSession(session: HearingSession): SerializedHearingSession { return structuredClone(session); }
export function deserializeHearingSession(value: unknown): HearingSession {
  const parsed = stripUndefined(parseOrThrow(hearingSchema, value, 'deserializeHearingSession'));
  return createHearingSession(parsed as unknown as Parameters<typeof createHearingSession>[0]);
}
