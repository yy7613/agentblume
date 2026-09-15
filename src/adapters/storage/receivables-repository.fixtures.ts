/**
 * adapters層: 入金消込リポジトリの共有契約テストが使う組み立て（テスト専用）。
 *
 * すべて domain の create* を通すので、契約テストが「保存できるはずのない値」を保存して実装差を見逃すことがない。
 */
import { createBankCsvProfile, type BankCsvProfile, type CreateBankCsvProfileProps } from '../../domain/receivables/bank-csv-profile';
import { createBankTransaction, type BankTransaction, type CreateBankTransactionProps } from '../../domain/receivables/bank-transaction';
import { createCustomer, type CreateCustomerProps, type Customer } from '../../domain/receivables/customer';
import { createInvoice, type CreateInvoiceProps, type Invoice } from '../../domain/receivables/invoice';
import { createMatching, type CreateMatchingProps, type Matching } from '../../domain/receivables/matching-aggregate';
import { defaultReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
export const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };
export const AT = '2026-09-14T00:00:00.000Z';

export function customerFixture(id: string, overrides: Partial<CreateCustomerProps> = {}): Customer {
  return createCustomer({
    tenant: scope, id, name: `取引先 ${id}`, kana: 'テスト', registrationNumber: 'T1234567890123', paymentTermDays: 30,
    payerAliases: [{ id: `${id}-alias`, text: 'ﾃｽﾄｼﾖｳｼﾞ', origin: 'learned', matchingId: 'm-1', createdAt: AT, lastMatchedAt: AT }],
    createdAt: AT, updatedAt: AT, ...overrides,
  });
}

export function invoiceFixture(id: string, overrides: Partial<CreateInvoiceProps> = {}): Invoice {
  return createInvoice({
    tenant: scope, id, customerId: 'c-1', issueDate: '2026-09-10', transactionDate: '2026-09-10', dueDate: '2026-10-10', pricing: 'exclusive',
    lines: [{ description: '開発', quantity: 1, unit: '式', unitPrice: 100_000, amount: 100_000, taxRate: 10 }, { description: '立替', amount: 500, taxRate: 0, zeroRateKind: 'non-taxable' }],
    declared: { taxByRate: [{ rate: 10, taxAmount: 10_000 }], grandTotal: 110_500 },
    roundingMode: 'floor', createdAt: AT, updatedAt: AT, ...overrides,
  });
}

export function issuedInvoiceFixture(id: string, number: string, overrides: Partial<CreateInvoiceProps> = {}): Invoice {
  return invoiceFixture(id, {
    status: 'issued', number, declared: undefined,
    snapshot: { issuer: defaultReceivablesSettings().issuer, customer: { name: '山田商事', honorific: '御中' }, roundingMode: 'floor', issuedAt: AT },
    journal: { salesEntryId: 'entry-1' },
    ...overrides,
  });
}

export function profileFixture(id: string, overrides: Partial<CreateBankCsvProfileProps> = {}): BankCsvProfile {
  return createBankCsvProfile({
    tenant: scope, id, name: `地銀 ${id}`, mapping: { date: '取引日', deposit: '入金額', withdrawal: '出金額', payerName: '振込依頼人名', balance: '残高' },
    headerRow: 4, accountKey: 'main', createdAt: AT, updatedAt: AT, ...overrides,
  });
}

export function transactionFixture(id: string, overrides: Partial<CreateBankTransactionProps> = {}): BankTransaction {
  return createBankTransaction({
    tenant: scope, id, accountKey: 'main', date: '2026-09-30', amount: 110_000, description: 'ﾌﾘｺﾐ ﾃｽﾄｼﾖｳｼﾞ', payerName: 'テストシヨウジ', payerNameNorm: 'テストシヨウジ', balance: 500_000,
    source: { fileName: 'bank.csv', profileId: 'builtin:generic', row: { 摘要: 'ﾌﾘｺﾐ ﾃｽﾄｼﾖｳｼﾞ' }, rowNumber: 2 },
    fingerprint: `fp-${id}`,
    judgment: { stage: 'decided', reason: 'exact-amount-and-name', candidates: [{ invoiceIds: ['i-1'], allocations: [{ invoiceId: 'i-1', amount: 110_000 }], candidateTotal: 110_000, difference: 0, feeAmount: 0, customerId: 'c-1', nameMatch: 'alias', nameScore: 1, rank: 1 }], judgedAt: AT },
    createdAt: AT, updatedAt: AT, ...overrides,
  });
}

export function matchingFixture(id: string, overrides: Partial<CreateMatchingProps> = {}): Matching {
  return createMatching({
    tenant: scope, id, transactionId: 'tx-1', transactionAmount: 54_560, customerId: 'c-1',
    allocations: [{ invoiceId: 'i-1', amount: 33_000 }, { invoiceId: 'i-2', amount: 22_000 }], feeAmount: 440,
    decidedBy: 'judgment', judgmentReason: 'combined-payment-with-fee', learnedAlias: { customerId: 'c-1', aliasId: 'a-1' },
    journal: { entryId: 'entry-2', outcome: 'created' }, confirmedAt: AT, createdAt: AT, updatedAt: AT, ...overrides,
  });
}
