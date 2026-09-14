import { describe, expect, it } from 'vitest';
import { InMemoryChartOfAccountsRepository, InMemoryJournalEntryRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { JOURNAL_ENTRIES_COLUMNS } from '../../domain/etl/nodes/journal-entries-source';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createJournalEntry, type CreateJournalEntryProps } from '../../domain/journal/entry';
import { JournalEntryRowsProvider, journalEntryRows } from './entry-rows';

const scope = { tenantId: 't', workspaceId: 'w' };
const other = { tenantId: 't', workspaceId: 'other' };
const NOW = '2026-09-13T10:00:00.000Z';

const SIMPLE_LINES = [
  { side: 'debit' as const, accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100 },
  { side: 'credit' as const, accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
];

function entryOf(overrides: Partial<CreateJournalEntryProps> = {}) {
  return createJournalEntry({
    tenant: scope, id: 'e1', documentId: 'doc-1', ruleId: 'rule-1', date: '2026-09-10',
    lines: SIMPLE_LINES, description: 'テスト仕入', invoiceStatus: 'qualified',
    status: 'confirmed', decidedBy: 'rule', createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as CreateJournalEntryProps);
}

async function setup() {
  const entries = new InMemoryJournalEntryRepository();
  const charts = new InMemoryChartOfAccountsRepository();
  await charts.save(scope, DEFAULT_CHART_OF_ACCOUNTS);
  return { entries, charts, provider: new JournalEntryRowsProvider(entries, charts) };
}

describe('journalEntryRows（畳み方）', () => {
  it('正常: 単純仕訳は 1 行に借方と貸方の両側が入り、列はノードのスキーマと一致する', () => {
    const rows = journalEntryRows(entryOf(), DEFAULT_CHART_OF_ACCOUNTS);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object)).toEqual([...JOURNAL_ENTRIES_COLUMNS]);
    expect(rows[0]).toEqual({
      entry_id: 'e1', line_no: 1, date: '2026-09-10',
      debit_account: '消耗品費', debit_tax_code: 'JP-IN-10-S', debit_amount: 1100,
      credit_account: '現金', credit_tax_code: 'JP-NA', credit_amount: 1100,
      description: 'テスト仕入', invoice_status: 'qualified', status: 'confirmed',
      document_id: 'doc-1', rule_id: 'rule-1',
    });
  });

  it('正常: 金額は数値・日付は YYYY-MM-DD 文字列で返す（CSV のスラッシュ日付ではない）', () => {
    const row = journalEntryRows(entryOf(), DEFAULT_CHART_OF_ACCOUNTS)[0] as Record<string, unknown>;
    expect(typeof row['debit_amount']).toBe('number');
    expect(row['date']).toBe('2026-09-10');
  });

  it('境界: 複合仕訳は仕訳行ごとに 1 行、反対側は null で埋め、同一 entry_id で束ねる', () => {
    const rows = journalEntryRows(entryOf({
      lines: [
        { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1000 },
        { side: 'debit', accountId: 'expense.travel', accountName: '旅費交通費', taxCode: 'JP-IN-10-S', amount: 100 },
        { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
      ],
    }), DEFAULT_CHART_OF_ACCOUNTS);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row['entry_id'])).toEqual(['e1', 'e1', 'e1']);
    expect(rows.map((row) => row['line_no'])).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ debit_account: '消耗品費', debit_amount: 1000, credit_account: null, credit_amount: null, credit_tax_code: null });
    expect(rows[2]).toMatchObject({ debit_account: null, debit_amount: null, debit_tax_code: null, credit_account: '現金', credit_amount: 1100 });
  });

  it('正常: 科目名は現在のマスタから引き直す（改名に追従する）', () => {
    const renamed = {
      ...DEFAULT_CHART_OF_ACCOUNTS,
      accounts: DEFAULT_CHART_OF_ACCOUNTS.accounts.map((account) => (account.id === 'expense.supplies' ? { ...account, name: '事務用品費' } : account)),
    };
    expect(journalEntryRows(entryOf(), renamed)[0]?.['debit_account']).toBe('事務用品費');
  });

  it('異常: マスタから消えた科目は仕訳が持つ確定時の名称へ落とす（空欄にしない）', () => {
    const without = { ...DEFAULT_CHART_OF_ACCOUNTS, accounts: DEFAULT_CHART_OF_ACCOUNTS.accounts.filter((account) => account.id !== 'expense.supplies') };
    expect(journalEntryRows(entryOf(), without)[0]?.['debit_account']).toBe('消耗品費');
  });

  it('境界: 任意項目（documentId / ruleId）が無ければ null になる', () => {
    const row = journalEntryRows(entryOf({ documentId: undefined, ruleId: undefined }), DEFAULT_CHART_OF_ACCOUNTS)[0] as Record<string, unknown>;
    expect(row['document_id']).toBeNull();
    expect(row['rule_id']).toBeNull();
  });
});

describe('JournalEntryRowsProvider', () => {
  it('正常: 保存済みの仕訳を行として返す', async () => {
    const { entries, provider } = await setup();
    await entries.save(entryOf());

    const rows = await provider.rows(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: 'e1', debit_account: '消耗品費' });
  });

  it('正常: status / from / to で絞り込む', async () => {
    const { entries, provider } = await setup();
    await entries.save(entryOf({ id: 'draft', status: 'draft' }));
    await entries.save(entryOf({ id: 'confirmed', status: 'confirmed' }));
    await entries.save(entryOf({ id: 'old', status: 'confirmed', date: '2026-08-01' }));

    expect(await provider.rows(scope, { status: 'confirmed' })).toHaveLength(2);
    expect(await provider.rows(scope, { from: '2026-09-01' })).toHaveLength(2);
    expect(await provider.rows(scope, { to: '2026-08-31' })).toHaveLength(1);
    expect(await provider.rows(scope, { status: 'confirmed', from: '2026-09-01' })).toHaveLength(1);
  });

  it('境界: limit は仕訳の件数上限（複合仕訳は 1 件が複数行になる）', async () => {
    const { entries, provider } = await setup();
    await entries.save(entryOf({ id: 'a', date: '2026-09-01' }));
    await entries.save(entryOf({
      id: 'b', date: '2026-09-02',
      lines: [
        { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1000 },
        { side: 'debit', accountId: 'expense.travel', accountName: '旅費交通費', taxCode: 'JP-IN-10-S', amount: 100 },
        { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
      ],
    }));

    // 1 件目（単純仕訳）だけ → 1 行。
    expect(await provider.rows(scope, { limit: 1 })).toHaveLength(1);
    // 2 件（単純 1 行 + 複合 3 行）→ 4 行。
    expect(await provider.rows(scope, { limit: 2 })).toHaveLength(4);
  });

  it('境界: 1 件も無ければ空配列（エラーにしない）', async () => {
    const { provider } = await setup();
    expect(await provider.rows(scope)).toEqual([]);
    expect(await provider.rows(scope, { status: 'exported' })).toEqual([]);
  });

  it('異常: 別ワークスペースの仕訳は見えない（スコープ隔離）', async () => {
    const { entries, provider } = await setup();
    await entries.save(entryOf());
    await entries.save(createJournalEntry({
      tenant: other, id: 'other-1', date: '2026-09-10', lines: SIMPLE_LINES,
      description: '別ワークスペース', invoiceStatus: 'qualified', status: 'confirmed',
      decidedBy: 'rule', createdAt: NOW, updatedAt: NOW,
    }));

    expect((await provider.rows(scope)).map((row) => row['entry_id'])).toEqual(['e1']);
    expect((await provider.rows(other)).map((row) => row['entry_id'])).toEqual(['other-1']);
  });

  it('例外: 科目マスタが未保存でも標準セットで科目名を埋める', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const provider = new JournalEntryRowsProvider(entries, new InMemoryChartOfAccountsRepository());
    await entries.save(entryOf());

    expect((await provider.rows(scope))[0]?.['debit_account']).toBe('消耗品費');
  });
});
