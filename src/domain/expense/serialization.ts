/**
 * ドメイン: 経費精算 BC の直列化。
 *
 * 永続化アダプタは Serialized 型を JSON 化して 1 列（record_json）に保存する。復元は必ず create* を通し、
 * 保存済みデータにも同じ不変条件を課す。zod は**形**（トップレベルの型と必須キー）だけを見て未知のキーを落とし、
 * 値の不変条件（日付の実在・遷移の整合・費目の一意性…）は create* が検証する（仕訳と同じ方針）。
 *
 * 実用化（docs/21 §20.2.13）の後方互換: 新しいキーはすべて `.optional()`。MVP で保存した規程は `createExpensePolicy` が
 * 既定値で補い（`updatedAt` は変えない）、申請は未定義のキーを書かないので再直列化がバイト同一になる
 * （`__fixtures__/v6-*.json` をテストで固定）。
 */
import { z } from 'zod';
import { createExpenseAdvance, type ExpenseAdvance } from './advance';
import { createExpenseCardImport, createExpenseCardTransaction, type ExpenseCardImport, type ExpenseCardTransaction } from './card';
import { createExpenseClaim, type ExpenseClaim } from './claim';
import { createExpenseEmployee, type ExpenseEmployee } from './employee';
import { ExpenseDomainError } from './errors';
import { createExpensePayoutBatch, type ExpensePayoutBatch } from './payout';
import { createExpensePolicy, type ExpensePolicy } from './policy';
import { createExpensePolicyHearing, type ExpensePolicyHearing } from './policy-hearing';
import { createExpenseReceipt, type ExpenseReceipt } from './receipt';
import { createExpenseSettings, type ExpenseSettingsKind, type ExpenseSettingsOf } from './settings';

export type SerializedExpensePolicy = ExpensePolicy;
export type SerializedExpenseClaim = ExpenseClaim;
export type SerializedExpenseReceipt = ExpenseReceipt;
export type SerializedExpenseEmployee = ExpenseEmployee;
export type SerializedExpenseAdvance = ExpenseAdvance;
export type SerializedExpenseCardImport = ExpenseCardImport;
export type SerializedExpenseCardTransaction = ExpenseCardTransaction;
export type SerializedExpensePayoutBatch = ExpensePayoutBatch;
export type SerializedExpensePolicyHearing = ExpensePolicyHearing;

const tenantSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });
const requirementSchema = z.object({ required: z.boolean(), exemptBelow: z.number().optional() });
const looseObject = z.record(z.string(), z.unknown());

const policySchema = z.object({
  categories: z.array(z.object({
    id: z.string(), code: z.string().optional(), name: z.string(), enabled: z.boolean(), sortOrder: z.number(), aliases: z.array(z.string()),
    accountId: z.string().optional(), defaultTaxRate: z.number(), taxCodeByRate: z.record(z.string(), z.string()),
    receipt: requirementSchema, invoice: requirementSchema,
    requires: z.object({ purpose: z.boolean(), attendees: z.boolean(), attendeeDetails: z.boolean() }),
    limits: z.object({
      perItem: z.number().optional(), perClaim: z.number().optional(), perPerson: z.number().optional(), perPersonBasis: z.string(),
      perUnit: z.object({ label: z.string(), amount: z.number() }).optional(),
    }),
    note: z.string().optional(),
    route: z.object({ required: z.boolean(), commuterPass: z.boolean(), fareTable: z.boolean() }).optional(),
  })),
  claimRules: z.object({
    submissionDeadlineDays: z.number().optional(), nonReimbursablePaymentMethods: z.array(z.string()),
    attendeesIncludeClaimant: z.boolean(), forbidSelfApproval: z.boolean(),
  }),
  preApprovalRules: z.array(z.object({
    id: z.string(), name: z.string(), enabled: z.boolean(), categoryIds: z.array(z.string()),
    minAmount: z.number().optional(), minPerPerson: z.number().optional(), note: z.string().optional(),
  })),
  severityOverrides: z.record(z.string(), z.string()),
  journal: z.object({ creditAccountId: z.string(), creditTaxCode: z.string(), partnerFrom: z.string(), descriptionTemplate: z.string(), departmentDimensionId: z.string().optional() }),
  approval: looseObject.optional(),
  transport: looseObject.optional(),
  card: looseObject.optional(),
  advance: looseObject.optional(),
  updatedAt: z.string(),
});

const claimSchema = z.object({
  tenant: tenantSchema,
  id: z.string(),
  claimant: z.object({ name: z.string(), employeeCode: z.string().optional(), department: z.string().optional(), employeeId: z.string().optional(), departmentId: z.string().optional() }),
  period: z.object({ from: z.string(), to: z.string() }),
  title: z.string().optional(),
  advanceId: z.string().optional(),
  items: z.array(z.object({
    id: z.string(), categoryId: z.string().optional(), categoryText: z.string().optional(),
    facts: z.record(z.string(), z.unknown()), receiptId: z.string().optional(),
    source: z.object({ type: z.string(), fileName: z.string().optional(), row: z.record(z.string(), z.string()).optional() }),
    extraction: z.object({
      method: z.string(), model: z.object({ provider: z.string(), model: z.string() }).optional(), confidence: z.number().optional(),
      warnings: z.array(z.string()), documentKind: z.string().optional(), rejectedRegistrationNumber: z.string().optional(),
      flags: z.array(z.string()).optional(), detail: looseObject.optional(),
    }),
    addedOn: z.string().optional(),
  })),
  status: z.string(),
  judgment: looseObject.optional(),
  acknowledgements: z.array(looseObject),
  returnNote: looseObject.optional(),
  approval: looseObject.optional(),
  approvalFlow: looseObject.optional(),
  settlement: looseObject.optional(),
  payout: looseObject.optional(),
  journalLink: looseObject.optional(),
  history: z.array(looseObject),
  submittedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const receiptSchema = z.object({
  tenant: tenantSchema,
  id: z.string(),
  claimId: z.string(),
  itemId: z.string(),
  source: z.object({ type: z.string(), fileName: z.string().optional(), mime: z.string().optional(), dataUrl: z.string(), text: z.string().optional() }),
  sha256: z.string(),
  createdAt: z.string(),
});

/** 実用化の集約はすべて tenant と id を持つ。形の細部は create* が検証する。 */
const aggregateSchema = z.object({ tenant: tenantSchema, id: z.string() }).passthrough();

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ExpenseDomainError(`${label}: invalid record: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

/** create* の検証エラーに復元元のラベルを付ける（どの行が壊れているかを運用で追えるように）。 */
function restore<T>(label: string, create: () => T): T {
  try {
    return create();
  } catch (error) {
    if (error instanceof ExpenseDomainError) throw new ExpenseDomainError(`${label}: ${error.message}`, error.row, error.details);
    throw error;
  }
}

export function serializeExpensePolicy(policy: ExpensePolicy): SerializedExpensePolicy { return structuredClone(policy); }
export function deserializeExpensePolicy(value: unknown): ExpensePolicy {
  return createExpensePolicy(parseOrThrow(policySchema, value, 'deserializeExpensePolicy') as unknown as Parameters<typeof createExpensePolicy>[0]);
}

export function serializeExpenseClaim(claim: ExpenseClaim): SerializedExpenseClaim { return structuredClone(claim); }
export function deserializeExpenseClaim(value: unknown): ExpenseClaim {
  return createExpenseClaim(parseOrThrow(claimSchema, value, 'deserializeExpenseClaim') as unknown as Parameters<typeof createExpenseClaim>[0]);
}

export function serializeExpenseReceipt(receipt: ExpenseReceipt): SerializedExpenseReceipt { return structuredClone(receipt); }
export function deserializeExpenseReceipt(value: unknown): ExpenseReceipt {
  return createExpenseReceipt(parseOrThrow(receiptSchema, value, 'deserializeExpenseReceipt') as unknown as ExpenseReceipt);
}

export function serializeExpenseEmployee(employee: ExpenseEmployee): SerializedExpenseEmployee { return structuredClone(employee); }
export function deserializeExpenseEmployee(value: unknown): ExpenseEmployee {
  const parsed = parseOrThrow(aggregateSchema, value, 'deserializeExpenseEmployee');
  return restore('deserializeExpenseEmployee', () => createExpenseEmployee(parsed as unknown as Parameters<typeof createExpenseEmployee>[0]));
}

export function serializeExpenseAdvance(advance: ExpenseAdvance): SerializedExpenseAdvance { return structuredClone(advance); }
export function deserializeExpenseAdvance(value: unknown): ExpenseAdvance {
  const parsed = parseOrThrow(aggregateSchema, value, 'deserializeExpenseAdvance');
  return restore('deserializeExpenseAdvance', () => createExpenseAdvance(parsed as unknown as Parameters<typeof createExpenseAdvance>[0]));
}

export function serializeExpenseCardImport(record: ExpenseCardImport): SerializedExpenseCardImport { return structuredClone(record); }
export function deserializeExpenseCardImport(value: unknown): ExpenseCardImport {
  const parsed = parseOrThrow(aggregateSchema, value, 'deserializeExpenseCardImport');
  return restore('deserializeExpenseCardImport', () => createExpenseCardImport(parsed as unknown as ExpenseCardImport));
}

export function serializeExpenseCardTransaction(record: ExpenseCardTransaction): SerializedExpenseCardTransaction { return structuredClone(record); }
export function deserializeExpenseCardTransaction(value: unknown): ExpenseCardTransaction {
  const parsed = parseOrThrow(aggregateSchema, value, 'deserializeExpenseCardTransaction');
  return restore('deserializeExpenseCardTransaction', () => createExpenseCardTransaction(parsed as unknown as ExpenseCardTransaction));
}

export function serializeExpensePayoutBatch(batch: ExpensePayoutBatch): SerializedExpensePayoutBatch { return structuredClone(batch); }
export function deserializeExpensePayoutBatch(value: unknown): ExpensePayoutBatch {
  const parsed = parseOrThrow(aggregateSchema, value, 'deserializeExpensePayoutBatch');
  return restore('deserializeExpensePayoutBatch', () => createExpensePayoutBatch(parsed as unknown as ExpensePayoutBatch));
}

export function serializeExpensePolicyHearing(hearing: ExpensePolicyHearing): SerializedExpensePolicyHearing { return structuredClone(hearing); }
export function deserializeExpensePolicyHearing(value: unknown): ExpensePolicyHearing {
  const parsed = parseOrThrow(aggregateSchema, value, 'deserializeExpensePolicyHearing');
  return restore('deserializeExpensePolicyHearing', () => createExpensePolicyHearing(parsed as unknown as ExpensePolicyHearing));
}

/** ワークスペースに 1 つの設定（kind ごとに型を引く）。 */
export function serializeExpenseSettings<K extends ExpenseSettingsKind>(_kind: K, value: ExpenseSettingsOf<K>): ExpenseSettingsOf<K> { return structuredClone(value); }
export function deserializeExpenseSettings<K extends ExpenseSettingsKind>(kind: K, value: unknown): ExpenseSettingsOf<K> {
  const parsed = parseOrThrow(z.object({ updatedAt: z.string() }).passthrough(), value, `deserializeExpenseSettings(${kind})`);
  return restore(`deserializeExpenseSettings(${kind})`, () => createExpenseSettings(kind, parsed));
}
