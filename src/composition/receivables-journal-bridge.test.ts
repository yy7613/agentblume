/**
 * 入金消込 → 仕訳の橋渡し（composition のアダプタ）を**実物の仕訳ユースケース**と突き合わせる（docs/22 §12）。
 *
 * - 下書きは作られ、draft なら差し替え、確定済みなら書かずに kept（SaveJournalEntryUseCase は状態を保って上書きするので、
 *   この規律がアダプタ側に無いと確定済みの仕訳が黙って書き換わる）。
 * - SQLite の配線で、科目が無いと発行ごと巻き戻る（採番も仕訳も残らない）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JournalExtractionUnavailableError } from '../application/journal/errors';
import { ReceivablesExtractionUnavailableError } from '../application/receivables/errors';
import { JOURNAL_CSV_PRESETS, normalizeHeader } from '../domain/journal/csv-presets';
import { DEFAULT_ACCOUNTS, DEFAULT_DIMENSIONS, DEFAULT_TAX_CATEGORIES } from '../domain/journal/default-chart';
import { BUILTIN_BANK_CSV_PROFILES } from '../domain/receivables/bank-csv-profile';
import { JournalLinkError } from '../domain/receivables/errors';
import { defaultReceivablesSettings } from '../domain/receivables/settings';
import { createJournalDraftSink, createOrderDocumentReader } from './receivables';
import { createApp, type App } from './root';

const scope = { tenantId: 'tenant-r', workspaceId: 'ws-r' };
let app: App | undefined;
afterEach(() => { app?.close(); app = undefined; });

const request = { date: '2026-09-30', description: 'INV-1 山田商事', tags: ['receivables', 'receivables:invoice:i1'], lines: [
  { side: 'debit' as const, accountId: 'asset.receivables', taxCode: 'JP-NA', amount: 1_100, partner: '山田商事' },
  { side: 'credit' as const, accountId: 'revenue.sales', taxCode: 'JP-OUT-10-S', amount: 1_100, taxAmount: 100, partner: '山田商事' },
] };

describe('createJournalDraftSink（実物の仕訳ユースケース）', () => {
  it('正常: 標準の科目マスタで科目・税区分を確かめ、税率を引く。無い / 無効なものだけ返す', async () => {
    app = createApp({ profile: 'test' });
    const sink = createJournalDraftSink(app);
    expect(await sink.checkAccounts(scope, { accountIds: ['revenue.sales', 'nope'], taxCodes: ['JP-OUT-10-S', 'JP-XX'] })).toEqual([{ kind: 'account', id: 'nope' }, { kind: 'tax', id: 'JP-XX' }]);
    expect(await sink.taxRateOf(scope, 'JP-IN-10-S')).toBe(10);
    expect(await sink.taxRateOf(scope, 'JP-XX')).toBeUndefined();
    await app.saveJournalChart.execute({ scope, accounts: DEFAULT_ACCOUNTS.map((account) => account.id === 'expense.fees' ? { ...account, enabled: false } : account), dimensions: DEFAULT_DIMENSIONS, taxCategories: DEFAULT_TAX_CATEGORIES });
    expect(await sink.checkAccounts(scope, { accountIds: ['expense.fees'], taxCodes: [] })).toEqual([{ kind: 'account', id: 'expense.fees' }]);
  });

  it('正常: 下書きを作り、draft なら差し替え、確定済みは書かずに kept。消去は draft だけ', async () => {
    app = createApp({ profile: 'test' });
    const sink = createJournalDraftSink(app);
    const created = await sink.upsertDraft(scope, request);
    expect(created.status).toBe('created');
    const [entry] = await app.listJournalEntries.execute(scope);
    expect(entry).toMatchObject({ id: created.entryId, status: 'draft', decidedBy: 'manual', invoiceStatus: 'not_required', tags: request.tags, lines: [{ accountName: '売掛金' }, { accountName: '売上高', taxAmount: 100 }] });
    expect(await sink.upsertDraft(scope, { ...request, description: '差し替え', existingEntryId: created.entryId })).toEqual({ status: 'updated', entryId: created.entryId });
    expect((await app.listJournalEntries.execute(scope))[0]!.description).toBe('差し替え');
    // 利用者が仕訳側で消していたら作り直す。
    expect((await sink.upsertDraft(scope, { ...request, existingEntryId: 'gone' })).status).toBe('created');

    await app.confirmJournalEntry.execute(scope, created.entryId);
    expect(await sink.upsertDraft(scope, { ...request, description: '上書きしない', existingEntryId: created.entryId })).toEqual({ status: 'kept', entryId: created.entryId, entryStatus: 'confirmed' });
    expect((await app.journalEntryRepo.findById(scope, created.entryId))!.description).toBe('差し替え');
    expect(await sink.discardDraft(scope, created.entryId)).toBe('kept');
    const other = (await app.listJournalEntries.execute(scope, { status: 'draft' }))[0]!;
    expect(await sink.discardDraft(scope, other.id)).toBe('deleted');
    expect(await sink.discardDraft(scope, other.id)).toBe('not-found');
  });

  it('正常: 組込み CSV プロファイルの署名は仕訳の JOURNAL_CSV_PRESETS（銀行分）と一致する', () => {
    expect(BUILTIN_BANK_CSV_PROFILES.map((profile) => [profile.presetId, profile.headerSignature])).toEqual(
      JOURNAL_CSV_PRESETS.filter((preset) => preset.kind !== 'card_statement').map((preset) => [preset.id, preset.headerSignature.map(normalizeHeader)]),
    );
  });
});

describe('createOrderDocumentReader', () => {
  it('正常: 仕訳の抽出を見積書のヒントで 1 枚ずつ呼び、請求書案に要る事実へ写す', async () => {
    const calls: unknown[] = [];
    const reader = createOrderDocumentReader({ extractJournalDocument: { execute: async (input: unknown) => { calls.push(input); return { kind: 'quotation', facts: { issuerName: 'テスト工業', recipientName: 'サンプル', registrationNumber: 'T1234567890123', issueDate: '2026-09-01', transactionDate: '2026-09-02', dueDate: '2026-09-30', grandTotal: 1_100, totalsByRate: [{ rate: 10, taxableAmount: 1_000, taxAmount: 100, amountIncludesTax: false }], lines: [{ description: 'A', quantity: 1, unitPrice: 1_000, amount: 1_000, taxRate: 10 }, { description: 'B', amount: 0 }] }, extraction: { method: 'llm', warnings: ['w'] } }; } } as never });
    const read = await reader.read({ image: 'data:image/png;base64,AA==', fileName: 'po.png' });
    expect(calls).toEqual([{ images: ['data:image/png;base64,AA=='], fileName: 'po.png', hintKind: 'quotation' }]);
    expect(read).toEqual({ issuerName: 'テスト工業', recipientName: 'サンプル', registrationNumber: 'T1234567890123', issueDate: '2026-09-01', transactionDate: '2026-09-02', dueDate: '2026-09-30', grandTotal: 1_100, totalsByRate: [{ rate: 10, taxableAmount: 1_000, taxAmount: 100, amountIncludesTax: false }], lines: [{ description: 'A', quantity: 1, unitPrice: 1_000, amount: 1_000, taxRate: 10 }, { description: 'B', amount: 0 }], warnings: ['w'] });
    const empty = createOrderDocumentReader({ extractJournalDocument: { execute: async () => ({ kind: 'unknown', facts: {}, extraction: { method: 'llm', warnings: [] } }) } as never });
    expect(await empty.read({ image: 'x', fileName: 'x' })).toEqual({ lines: [], warnings: [] });
  });

  it('異常: モデル未設定・能力不足は入金消込のエラーに包み直し、それ以外はそのまま投げる', async () => {
    const failing = (error: Error) => createOrderDocumentReader({ extractJournalDocument: { execute: async () => { throw error; } } as never });
    await expect(failing(new JournalExtractionUnavailableError('no vision')).read({ image: 'x', fileName: 'x' })).rejects.toThrow(ReceivablesExtractionUnavailableError);
    await expect(failing(new Error('boom')).read({ image: 'x', fileName: 'x' })).rejects.toThrow('boom');
  });
});

describe('composeReceivables の配線', () => {
  it('正常: test プロファイルでは注文書の読み取りを「使えない」と答える', async () => {
    app = createApp({ profile: 'test' });
    expect(await app.receivablesCapabilities.execute()).toEqual({ invoiceDraft: { enabled: false, vision: false } });
  });

  it('例外: SQLite の配線では、科目が無い発行は採番も仕訳も含めて巻き戻る', async () => {
    app = createApp({ profile: 'local', dbPath: ':memory:', logger: () => { /* 出さない */ } });
    await app.saveReceivablesSettings.execute({ scope, settings: { ...defaultReceivablesSettings(), issuer: { name: 'サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] } } });
    const { customer } = await app.saveReceivablesCustomer.execute({ scope, name: '山田商事' });
    await app.saveJournalChart.execute({ scope, accounts: DEFAULT_ACCOUNTS.filter((account) => account.id !== 'revenue.sales'), dimensions: DEFAULT_DIMENSIONS, taxCategories: DEFAULT_TAX_CATEGORIES });
    const { invoice } = await app.createReceivablesInvoice.execute({ scope, content: { customerId: customer.id, issueDate: '2026-09-30', transactionDate: '2026-09-30', dueDate: '2026-10-31', pricing: 'exclusive', lines: [{ description: '開発', amount: 1_000, taxRate: 10 }] } });
    await expect(app.issueReceivablesInvoice.execute({ scope, id: invoice.id })).rejects.toBeInstanceOf(JournalLinkError);
    expect((await app.getReceivablesInvoice.execute(scope, invoice.id)).invoice.status).toBe('draft');
    expect(await app.listJournalEntries.execute(scope)).toEqual([]);
    // 科目を戻すと、巻き戻った採番の続きではなく 0001 から振られる。
    await app.resetJournalChart.execute(scope);
    const issued = await app.issueReceivablesInvoice.execute({ scope, id: invoice.id });
    expect(issued.invoice.number).toBe('INV-2026-0001');
    expect(await app.listJournalEntries.execute(scope)).toHaveLength(1);
  });
});
