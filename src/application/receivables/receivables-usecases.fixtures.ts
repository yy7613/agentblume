/**
 * application層: 入金消込のユースケースのテストが共有する組み立て（テスト専用。domain だけに依存する）。
 */
import { createCustomer, type CreateCustomerProps, type Customer } from '../../domain/receivables/customer';
import type { InvoiceContent } from '../../domain/receivables/invoice';
import { defaultReceivablesSettings, type ReceivablesSettings } from '../../domain/receivables/settings';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { JournalDraftRequest, JournalDraftResult, JournalDraftSink } from './ports';

export const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
/** ローカル日付がどのタイムゾーンでも 2026-09-30 になる時刻。 */
export const NOW = new Date('2026-09-30T03:00:00.000Z');
export const AT = NOW.toISOString();

export const issuerSettings = (overrides: Partial<ReceivablesSettings> = {}): ReceivablesSettings => ({
  ...defaultReceivablesSettings(AT),
  issuer: { name: '株式会社サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] },
  ...overrides,
});

export function customerOf(id: string, overrides: Partial<CreateCustomerProps> = {}): Customer {
  return createCustomer({ tenant: scope, id, name: `取引先${id}`, createdAt: AT, updatedAt: AT, ...overrides });
}

export const invoiceContent = (overrides: Partial<InvoiceContent> = {}): InvoiceContent => ({
  customerId: 'c1', issueDate: '2026-09-30', transactionDate: '2026-09-30', dueDate: '2026-10-31', pricing: 'exclusive',
  lines: [{ description: '開発費', amount: 100_000, taxRate: 10 }],
  ...overrides,
});

/** 仕訳の偽物。呼び出しを記録し、科目の欠落・確定済み・消去の結果を切り替えられる。 */
export class FakeJournalSink implements JournalDraftSink {
  missing: { kind: 'account' | 'tax'; id: string }[] = [];
  rates = new Map<string, number>([['JP-IN-10-S', 10]]);
  keep = false;
  discardOutcome: 'deleted' | 'kept' | 'not-found' = 'deleted';
  readonly drafts: JournalDraftRequest[] = [];
  readonly discarded: string[] = [];
  readonly checked: { accountIds: readonly string[]; taxCodes: readonly string[] }[] = [];
  private counter = 0;

  async checkAccounts(_scope: TenantScope, refs: { readonly accountIds: readonly string[]; readonly taxCodes: readonly string[] }) {
    this.checked.push({ accountIds: refs.accountIds, taxCodes: refs.taxCodes });
    return this.missing;
  }
  async taxRateOf(_scope: TenantScope, taxCode: string) { return this.rates.get(taxCode); }
  async upsertDraft(_scope: TenantScope, request: JournalDraftRequest): Promise<JournalDraftResult> {
    this.drafts.push(request);
    if (this.keep) return { status: 'kept', entryId: request.existingEntryId ?? 'confirmed-entry', entryStatus: 'confirmed' };
    this.counter += 1;
    return { status: 'created', entryId: `entry-${this.counter}` };
  }
  async discardDraft(_scope: TenantScope, entryId: string) {
    this.discarded.push(entryId);
    return this.discardOutcome;
  }
}

export function sequentialIds(prefix = 'id'): () => string {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}
