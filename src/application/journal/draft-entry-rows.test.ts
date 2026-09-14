import { describe, expect, it, vi } from 'vitest';
import { JOURNAL_DRAFT_ENTRY_SCHEMA } from '../../domain/etl/nodes/journal-draft-entry';
import { createChartOfAccounts, type ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import type { DocumentFacts } from '../../domain/journal/document';
import { createJournalRule, type JournalRule } from '../../domain/journal/rule';
import type { ChartOfAccountsRepository, JournalRuleRepository } from '../../domain/journal/repositories';
import type { ExtractJournalDocumentUseCase } from './extract-document';
import { JournalDraftEntryRowsProvider, journalDraftEntryRows } from './draft-entry-rows';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const AT = '2026-09-14T00:00:00.000Z';
const now = () => new Date(AT);

const chart: ChartOfAccounts = createChartOfAccounts({
  accounts: [
    { id: 'meeting', name: '会議費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'cash', name: '現金', category: 'asset', defaultTaxCode: 'JP-NA', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [],
  taxCategories: [
    { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true },
    { code: 'JP-NA', name: '対象外', side: 'none', enabled: true },
  ],
  updatedAt: AT,
});

const facts: DocumentFacts = {
  direction: 'out', issuerName: 'サンプルカフェ', descriptionNorm: 'サンプルカフェ コーヒー',
  description: 'コーヒー', grandTotal: 1100, transactionDate: '2026-09-01',
};

const rule: JournalRule = createJournalRule({
  tenant: scope, id: 'rule-1', name: 'カフェ代', enabled: true, mode: 'auto', priority: 10,
  scope: { direction: 'out' },
  conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
  outcome: {
    lines: [
      { side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total', partnerFrom: 'issuerName' },
      { side: 'credit', accountId: 'cash', taxCode: 'JP-NA', amount: 'total' },
    ],
    descriptionTemplate: '{description}', invoiceStatus: 'auto',
  },
  askIf: [], requiredFacts: [], createdAt: AT, updatedAt: AT,
});

function repos(rules: readonly JournalRule[], stored: ChartOfAccounts | null = chart) {
  return {
    rules: { list: vi.fn().mockResolvedValue(rules) } as unknown as JournalRuleRepository,
    charts: { get: vi.fn().mockResolvedValue(stored) } as unknown as ChartOfAccountsRepository,
  };
}

function stubExtract(kind = 'receipt', extracted: DocumentFacts = facts): ExtractJournalDocumentUseCase {
  return { execute: vi.fn().mockResolvedValue({ kind, facts: extracted, extraction: { method: 'llm', warnings: [] } }) } as unknown as ExtractJournalDocumentUseCase;
}

const attachment = { name: 'receipt.png', dataUrl: 'data:image/png;base64,AAA' };

describe('journalDraftEntryRows', () => {
  it('正常: 確定した仕訳案を 1 行 = 1 仕訳行へ平坦化する', () => {
    const entry = { date: '2026-09-01', description: 'コーヒー', invoiceStatus: 'transitional' as const, lines: [
      { side: 'debit' as const, accountId: 'meeting', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100, partner: 'サンプルカフェ' },
      { side: 'credit' as const, accountId: 'cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ] };
    const rows = journalDraftEntryRows('a.png', entry, { id: 'rule-1', name: 'カフェ代' }, chart, facts);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ decided: true, line_no: 1, side: 'debit', account: '会議費', amount: 1100, partner: 'サンプルカフェ', rule_name: 'カフェ代' });
    expect(rows[1]).toMatchObject({ line_no: 2, side: 'credit', account: '現金', partner: null });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(JOURNAL_DRAFT_ENTRY_SCHEMA.columns.map((column) => column.name).sort());
  });

  it('境界: マスタから消えた科目は、判定時の名称へ落とす（名前が空の行を出さない）', () => {
    const entry = { date: '2026-09-01', description: 'x', invoiceStatus: 'none' as const, lines: [
      { side: 'debit' as const, accountId: 'ghost', accountName: '廃止した科目', taxCode: 'JP-NA', amount: 100 },
    ] };
    expect(journalDraftEntryRows('a.png', entry, undefined, chart, facts)[0]).toMatchObject({ account: '廃止した科目', rule_id: null, rule_name: null });
  });
});

describe('JournalDraftEntryRowsProvider', () => {
  it('正常: 読み取り → 保存済みルールで判定 → 仕訳案の行を返す（保存はしない）', async () => {
    const { rules, charts } = repos([rule]);
    const provider = new JournalDraftEntryRowsProvider(stubExtract(), rules, charts, now);
    const rows = await provider.rows(scope, [attachment]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ file_name: 'receipt.png', decided: true, rule_id: 'rule-1', account: '会議費', amount: 1100 });
    expect(rows[1]).toMatchObject({ side: 'credit', account: '現金' });
  });

  it('正常: 一致するルールが無ければ、行の代わりに理由を 1 行返す', async () => {
    const { rules, charts } = repos([]);
    const provider = new JournalDraftEntryRowsProvider(stubExtract(), rules, charts, now);
    const rows = await provider.rows(scope, [attachment]);
    // 空表にすると「仕訳が無い」と「判定できなかった」を区別できない。
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decided: false, reason: 'no-rule', line_no: null, account: null });
    expect(JSON.parse(String(rows[0]?.['facts_json'])).issuerName).toBe('サンプルカフェ');
  });

  it('境界: 判定対象外の帳票種別（見積書）は document-kind として返す', async () => {
    const { rules, charts } = repos([rule]);
    const provider = new JournalDraftEntryRowsProvider(stubExtract('quotation'), rules, charts, now);
    expect((await provider.rows(scope, [attachment]))[0]).toMatchObject({ decided: false, reason: 'document-kind' });
  });

  it('境界: 科目マスタが未保存でも標準セットで判定し、添付が無ければ何も読まない', async () => {
    const { rules, charts } = repos([], null);
    const extract = stubExtract();
    const provider = new JournalDraftEntryRowsProvider(extract, rules, charts, now);
    expect(await provider.rows(scope, [])).toEqual([]);
    expect(extract.execute).not.toHaveBeenCalled();
    expect((await provider.rows(scope, [attachment]))[0]).toMatchObject({ decided: false });
  });

  it('境界: limit を超える添付は読まない（読み取りは高価なので投げる前に切る）', async () => {
    const { rules, charts } = repos([rule]);
    const extract = stubExtract();
    const provider = new JournalDraftEntryRowsProvider(extract, rules, charts, now);
    await provider.rows(scope, [attachment, { name: 'b.png', dataUrl: 'data:image/png;base64,BBB' }], { limit: 1 });
    expect(extract.execute).toHaveBeenCalledTimes(1);
  });

  it('例外: 読み取りに失敗したら投げる（読めた分だけ黙って返さない）', async () => {
    const { rules, charts } = repos([rule]);
    const extract = { execute: vi.fn().mockRejectedValue(new Error('vision model is not available')) } as unknown as ExtractJournalDocumentUseCase;
    const provider = new JournalDraftEntryRowsProvider(extract, rules, charts, now);
    await expect(provider.rows(scope, [attachment])).rejects.toThrow('vision model is not available');
  });
});
