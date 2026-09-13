// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto, JournalDocumentDto, JournalDocumentSummaryDto, JournalEntryDto, JournalRuleDto } from '../api/types';
import { NavigationProvider, consumePendingOpen, requestOpenInScreen } from '../navigation';
import { JournalPage } from './JournalPage';

afterEach(() => { cleanup(); consumePendingOpen('Journal'); consumePendingOpen('Settings'); });

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const rule: JournalRuleDto = {
  id: 'r1', name: 'カフェ', enabled: true, mode: 'auto', priority: 10, scope: { direction: 'out' },
  conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
  outcome: { lines: [{ side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: 'total' }] },
  askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

const noRuleSummary: JournalDocumentSummaryDto = {
  id: 'doc-nr', kind: 'receipt', status: 'undecided', sourceType: 'structured', transactionDate: '2026-09-01', issuerName: 'サンプルカフェ', description: 'コーヒー', grandTotal: 1100, direction: 'out',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};
const unknownAccountSummary: JournalDocumentSummaryDto = { ...noRuleSummary, id: 'doc-ua', issuerName: 'サンプル商事' };

function documentOf(id: string): JournalDocumentDto {
  const reasons = id === 'doc-ua'
    ? [{ code: 'unknown-account' as const, ruleId: 'r1', accountIds: ['ghost'] }]
    : [{ code: 'no-rule' as const }];
  return {
    id, kind: 'receipt', source: { type: 'structured' }, facts: { direction: 'out', issuerName: id === 'doc-ua' ? 'サンプル商事' : 'サンプルカフェ', description: 'コーヒー', grandTotal: 1100, transactionDate: '2026-09-01' },
    extraction: { method: 'manual', warnings: [] }, status: 'undecided',
    judgment: { stage: 'undecided', reasons, candidates: [], judgedAt: '2026-09-02T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const entry: JournalEntryDto = {
  id: 'entry-1', date: '2026-09-01', description: 'コーヒー', invoiceStatus: 'not_required', status: 'draft', decidedBy: 'rule',
  lines: [{ side: 'debit', accountId: 'meeting', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100 }, { side: 'credit', accountId: 'cash', accountName: '現金', taxCode: 'JP-IN-10-S', amount: 1100 }],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    getJournalChart: vi.fn().mockResolvedValue(chart),
    listJournalRules: vi.fn().mockResolvedValue([rule]),
    journalCapabilities: vi.fn().mockResolvedValue({ extraction: { enabled: false, vision: false }, hearing: { enabled: false } }),
    listJournalCsvPresets: vi.fn().mockResolvedValue([]),
    listJournalDocuments: vi.fn().mockResolvedValue([noRuleSummary, unknownAccountSummary]),
    getJournalDocument: vi.fn().mockImplementation((id: string) => Promise.resolve(documentOf(id))),
    listJournalEntries: vi.fn().mockResolvedValue([entry]),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderPage(client: ToolApiClient, navigate = vi.fn()) {
  render(<NavigationProvider navigate={navigate}><JournalPage client={client} /></NavigationProvider>);
  return navigate;
}

describe('JournalPage', () => {
  it('正常: 取込 / 判定 / ルール / 科目 / 出力の 5 サブタブを切り替えて表示する', async () => {
    renderPage(stubClient());
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Ingest', 'Judge', 'Rules', 'Chart', 'Export']);
    expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Import a bank / card CSV' })).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(await screen.findByRole('heading', { name: /^Rules/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(await screen.findByRole('heading', { name: /^Accounts/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Export' }));
    expect(await screen.findByRole('heading', { name: 'Entries' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Export' }).getAttribute('aria-selected')).toBe('true');
  });

  it('例外: 科目マスタとルールの初回読込が失敗してもエラーを出し、画面は使えたままにする', async () => {
    const client = stubClient({
      getJournalChart: vi.fn().mockRejectedValue(new Error('chart down')),
      listJournalRules: vi.fn().mockRejectedValue(new Error('rules down')),
      journalCapabilities: vi.fn().mockRejectedValue(new Error('capabilities down')),
    });
    renderPage(client);
    expect(await screen.findByText(/Could not load the chart of accounts/)).toBeTruthy();
    expect(await screen.findByText(/Could not load the rules/)).toBeTruthy();
    expect(screen.getByText(/chart down/)).toBeTruthy();

    // タブ切り替えは生きている。科目タブは「読み込み中」を出して落ちない。
    await userEvent.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(await screen.findByText('Loading the chart of accounts…')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeTruthy();

    // 再試行でもう一度読みにいく。
    const retry = screen.getAllByRole('button', { name: 'Retry' })[0];
    await userEvent.click(retry as HTMLElement);
    await waitFor(() => expect((client.getJournalChart as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it('正常: 他画面からの section: document のディープリンクは判定タブでその帳票を開く', async () => {
    const client = stubClient();
    requestOpenInScreen('Journal', { internalId: 'doc-ua', section: 'document' });
    renderPage(client);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Judge' }).getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(client.getJournalDocument).toHaveBeenCalledWith('doc-ua', expect.anything()));
    expect(await screen.findByText(/refers to accounts missing or disabled in the chart/)).toBeTruthy();
  });

  it('正常: section: rule のディープリンクはルールタブでそのルールを編集に開く', async () => {
    requestOpenInScreen('Journal', { internalId: 'r1', section: 'rule' });
    renderPage(stubClient());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('heading', { name: 'Edit rule "カフェ"' })).toBeTruthy();
  });

  it('正常: section: account のディープリンクは科目タブでその科目を開く', async () => {
    requestOpenInScreen('Journal', { internalId: 'meeting', section: 'account' });
    renderPage(stubClient());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chart' }).getAttribute('aria-selected')).toBe('true'));
    const row = (await screen.findByLabelText('Account 2 name')) as HTMLInputElement;
    expect(row.value).toBe('会議費');
    expect(row.closest('tr')?.className).toContain('selected');
  });

  it('正常: section: entry のディープリンクは出力タブでその仕訳を開く', async () => {
    requestOpenInScreen('Journal', { internalId: 'entry-1', section: 'entry' });
    renderPage(stubClient());
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Export' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('table', { name: 'Lines of entry-1' })).toBeTruthy();
  });

  it('境界: 未知の section のディープリンクは無視して取込タブのままにする', async () => {
    requestOpenInScreen('Journal', { internalId: 'x', section: 'hearing' });
    renderPage(stubClient());
    expect(await screen.findByRole('heading', { name: 'Import a bank / card CSV' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true');
  });

  it('正常: 未確定の「ルールを作る」はルールタブへ移り、帳票から名前と条件を埋める', async () => {
    renderPage(stubClient());
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'サンプルカフェ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create a rule' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true'));
    expect(((await screen.findByLabelText('Rule name')) as HTMLInputElement).value).toBe('コーヒー');
    expect((screen.getByLabelText('Condition 1 value') as HTMLInputElement).value).toBe('コーヒー');
  });

  it('正常: unknown-account の「科目マスタを開く」は科目タブへ移り、その id の追加を促す', async () => {
    renderPage(stubClient());
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'サンプル商事' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open the chart' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chart' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByText('Account "ghost" is not in the chart.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add account "ghost"' })).toBeTruthy();
  });

  it('正常: 未確定の「項目を編集」は取込タブの事実フォームでその帳票を開く', async () => {
    const client = stubClient();
    renderPage(client);
    await userEvent.click(screen.getByRole('tab', { name: 'Judge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'サンプルカフェ' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit facts' }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('heading', { name: 'Edit facts of document doc-nr' })).toBeTruthy();
    expect(((await screen.findByLabelText('Issuer name')) as HTMLInputElement).value).toBe('サンプルカフェ');
  });
});
