/**
 * ドメイン: 入金消込 BC の直列化（仕訳 `serialization.ts` と同じ規律）。
 *
 * 永続化アダプタは Serialized 型を JSON 化して 1 列（record_json）に保存する。復元は必ず create* を通し、
 * 保存済みデータにも同じ不変条件を課す。zod は**形**（トップレベルの型と必須キー）だけを見て、
 * 値の不変条件（日付・配分の合計・状態と入金額の整合・税額の再計算）は create* が検証する。
 */
import { z } from 'zod';
import { createBankCsvProfile, BUILTIN_BANK_CSV_PROFILES, type BankCsvProfile } from './bank-csv-profile';
import { createBankTransaction, type BankTransaction } from './bank-transaction';
import { createCustomer, type Customer } from './customer';
import { ReceivablesDomainError } from './errors';
import { createInvoice, type Invoice } from './invoice';
import { createMatching, type Matching } from './matching-aggregate';
import { createReceivablesSettings, type ReceivablesSettings } from './settings';

const tenantSchema = z.object({ tenantId: z.string(), workspaceId: z.string() });

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ReceivablesDomainError(`${label}: invalid record: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

export function serializeReceivablesSettings(settings: ReceivablesSettings): ReceivablesSettings { return structuredClone(settings); }
export function deserializeReceivablesSettings(value: unknown): ReceivablesSettings {
  const parsed = parseOrThrow(z.object({ issuer: z.record(z.string(), z.unknown()), rounding: z.record(z.string(), z.unknown()), matching: z.record(z.string(), z.unknown()), journal: z.record(z.string(), z.unknown()), numbering: z.record(z.string(), z.unknown()), updatedAt: z.string() }).loose(), value, 'deserializeReceivablesSettings');
  return createReceivablesSettings(parsed as unknown as ReceivablesSettings);
}

export function serializeCustomer(customer: Customer): Customer { return structuredClone(customer); }
export function deserializeCustomer(value: unknown): Customer {
  const parsed = parseOrThrow(z.object({ tenant: tenantSchema, id: z.string(), name: z.string(), payerAliases: z.array(z.record(z.string(), z.unknown())), createdAt: z.string(), updatedAt: z.string() }).loose(), value, 'deserializeCustomer');
  return createCustomer(parsed as unknown as Parameters<typeof createCustomer>[0]);
}

export function serializeInvoice(invoice: Invoice): Invoice { return structuredClone(invoice); }
export function deserializeInvoice(value: unknown): Invoice {
  const parsed = parseOrThrow(z.object({ tenant: tenantSchema, id: z.string(), status: z.string(), pricing: z.string(), roundingMode: z.string(), lines: z.array(z.record(z.string(), z.unknown())), paidAmount: z.number(), createdAt: z.string(), updatedAt: z.string() }).loose(), value, 'deserializeInvoice');
  return createInvoice(parsed as unknown as Parameters<typeof createInvoice>[0]);
}

export function serializeBankCsvProfile(profile: BankCsvProfile): BankCsvProfile { return structuredClone(profile); }
export function deserializeBankCsvProfile(value: unknown): BankCsvProfile {
  const parsed = parseOrThrow(z.object({ tenant: tenantSchema, id: z.string(), name: z.string(), mapping: z.record(z.string(), z.unknown()), headerSignature: z.array(z.string()), createdAt: z.string(), updatedAt: z.string() }).loose(), value, 'deserializeBankCsvProfile');
  return createBankCsvProfile(parsed as unknown as Parameters<typeof createBankCsvProfile>[0]);
}

export function serializeBankTransaction(transaction: BankTransaction): BankTransaction { return structuredClone(transaction); }
export function deserializeBankTransaction(value: unknown): BankTransaction {
  const parsed = parseOrThrow(z.object({ tenant: tenantSchema, id: z.string(), accountKey: z.string(), date: z.string(), amount: z.number(), source: z.record(z.string(), z.unknown()), fingerprint: z.string(), status: z.string(), createdAt: z.string(), updatedAt: z.string() }).loose(), value, 'deserializeBankTransaction');
  return createBankTransaction(parsed as unknown as Parameters<typeof createBankTransaction>[0]);
}

export function serializeMatching(matching: Matching): Matching { return structuredClone(matching); }
export function deserializeMatching(value: unknown): Matching {
  const parsed = parseOrThrow(z.object({ tenant: tenantSchema, id: z.string(), transactionId: z.string(), transactionAmount: z.number(), allocations: z.array(z.record(z.string(), z.unknown())), feeAmount: z.number(), status: z.string(), decidedBy: z.string(), confirmedAt: z.string(), createdAt: z.string(), updatedAt: z.string() }).loose(), value, 'deserializeMatching');
  return createMatching(parsed as unknown as Parameters<typeof createMatching>[0]);
}

/** 組込み + 利用者のプロファイルを 1 つの一覧に（利用者が先。判定の順と同じ）。 */
export function withBuiltinProfiles(user: readonly BankCsvProfile[]): readonly BankCsvProfile[] {
  return [...user, ...BUILTIN_BANK_CSV_PROFILES];
}
