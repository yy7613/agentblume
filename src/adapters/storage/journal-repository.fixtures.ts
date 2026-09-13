/**
 * adapters層: 仕訳リポジトリの共有契約テストが使う組み立て（テスト専用）。
 *
 * 5つの契約ファイルが同じ形の集約を必要とするので1箇所に置く。すべて domain の create* を通すので、
 * 契約テストが「保存できるはずのない値」を保存して実装差を見逃すことがない。
 */
import { createChartOfAccounts, type ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createJournalDocument, type CreateJournalDocumentProps, type JournalDocument } from '../../domain/journal/document';
import { createJournalEntry, type CreateJournalEntryProps, type JournalEntry } from '../../domain/journal/entry';
import { createHearingSession, type CreateHearingSessionProps, type HearingSession } from '../../domain/journal/hearing';
import { createJournalRule, type CreateJournalRuleProps, type JournalRule } from '../../domain/journal/rule';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
export const otherTenant: TenantScope = { tenantId: 'other', workspaceId: 'workspace' };
export const otherWorkspace: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

export const AT = '2026-09-13T00:00:00.000Z';

/** 1x1 の PNG（形が data URL の検証を通ればよいので中身は問わない）。 */
export const SAMPLE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

export function chartFixture(overrides: Partial<Parameters<typeof createChartOfAccounts>[0]> = {}): ChartOfAccounts {
  return createChartOfAccounts({
    accounts: DEFAULT_CHART_OF_ACCOUNTS.accounts,
    dimensions: DEFAULT_CHART_OF_ACCOUNTS.dimensions,
    taxCategories: DEFAULT_CHART_OF_ACCOUNTS.taxCategories,
    updatedAt: AT,
    ...overrides,
  });
}

export function documentFixture(id: string, overrides: Partial<CreateJournalDocumentProps> = {}): JournalDocument {
  return createJournalDocument({
    tenant: scope,
    id,
    kind: 'invoice',
    // 一覧の要約に出てはいけない3つ（data URL・原文・CSV 行）を最初から全部載せておく。
    source: { type: 'image', fileName: 'invoice.png', mime: 'image/png', dataUrl: SAMPLE_DATA_URL, text: '原文テキスト', row: { 日付: '2026-09-10' }, preset: 'generic' },
    facts: {
      direction: 'out', issuerName: '株式会社テスト', registrationNumber: 'T1234567890123',
      transactionDate: '2026-09-10', grandTotal: 1100,
      description: 'テスト仕入', descriptionNorm: 'テスト仕入', counterpartyHint: 'テスト',
    },
    extraction: { method: 'manual', warnings: [] },
    status: 'extracted',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function ruleFixture(id: string, overrides: Partial<CreateJournalRuleProps> = {}): JournalRule {
  return createJournalRule({
    tenant: scope,
    id,
    name: `rule ${id}`,
    enabled: true,
    mode: 'auto',
    priority: 100,
    scope: { documentKinds: ['invoice'], direction: 'out' },
    conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'テスト' }],
    outcome: {
      lines: [
        { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total', partnerFrom: 'issuerName' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ],
      descriptionTemplate: '{issuerName} {description}',
      invoiceStatus: 'auto',
    },
    askIf: [{ conditions: [{ field: 'grandTotal', op: 'gte', value: 100000 }], questionId: 'fixed_asset_check', prompt: '固定資産の確認' }],
    requiredFacts: ['grandTotal'],
    provenance: { origin: 'manual', exampleDocumentIds: ['doc-1'] },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function entryFixture(id: string, overrides: Partial<CreateJournalEntryProps> = {}): JournalEntry {
  return createJournalEntry({
    tenant: scope,
    id,
    documentId: 'doc-1',
    ruleId: 'rule-1',
    date: '2026-09-10',
    lines: [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', dimensionValues: { sub_account: 'sub1' }, taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100, partner: 'テスト' },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ],
    description: 'テスト仕入',
    invoiceStatus: 'qualified',
    registrationNumber: 'T1234567890123',
    item: 'ペン',
    tags: ['tag1'],
    status: 'draft',
    decidedBy: 'rule',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function hearingFixture(id: string, overrides: Partial<CreateHearingSessionProps> = {}): HearingSession {
  return createHearingSession({
    tenant: scope,
    id,
    documentId: 'doc-1',
    status: 'open',
    turns: [
      { role: 'assistant', question: { id: 'q1', text: '誰との飲食ですか', kind: 'single', options: [{ value: 'entertainment', label: '接待' }], factPath: 'extra.purpose', catalogId: 'meal_purpose' }, at: AT },
      { role: 'user', answer: { questionId: 'q1', value: 'entertainment' }, at: AT },
    ],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}