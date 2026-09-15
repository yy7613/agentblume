// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { BankTransactionDto, CustomerDto, InvoiceSummaryDto } from '../api/receivables-types';
import { NavigationProvider, consumePendingOpen, requestOpenInScreen } from '../navigation';
import { ReceivablesPage } from './ReceivablesPage';
import { receivablesBusiness } from './receivables-business';

afterEach(() => { cleanup(); consumePendingOpen('Receivables'); consumePendingOpen('Journal'); });

const AT = '2026-09-01T00:00:00.000Z';
const settings = {
  issuer: { name: 'サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] },
  rounding: { mode: 'floor', defaultPricing: 'exclusive' }, matching: { feeTolerance: { min: 1, max: 880 }, maxCombinationSize: 3, partialNameMinLength: 4 },
  journal: { enabled: true, accounts: { sales: 'revenue.sales', receivable: 'asset.receivables', deposit: 'asset.ordinary_deposit', fee: 'expense.fees' }, salesTaxCodes: { '10': 'JP-OUT-10-S', '8': 'JP-OUT-8R-S', '0': 'JP-OUT-EXEMPT' }, feeTaxCode: 'JP-IN-10-S', nonTaxableTaxCode: 'JP-NA', salesEntryDate: 'transaction-date' },
  numbering: { format: 'INV-{YYYY}-{SEQ4}' },
};
const customer: CustomerDto = { id: 'c1', name: '山田商事', honorific: '御中', payerAliases: [{ id: 'a1', text: 'ﾔﾏﾀﾞ', normalized: 'ヤマダ', origin: 'learned', createdAt: AT }], enabled: true, createdAt: AT, updatedAt: AT, outstanding: 0 };
const deposit: BankTransactionDto = {
  id: 't1', accountKey: 'main', date: '2026-09-30', amount: 88_000, description: 'ﾌﾘｺﾐ ﾔﾏﾀﾞ ﾀﾛｳ', payerName: 'ヤマダ タロウ', payerNameNorm: 'ヤマダタロウ', source: { row: {}, rowNumber: 2 }, fingerprint: 'f', status: 'unmatched', createdAt: AT, updatedAt: AT,
};

function stubClient(routes: { saved?: boolean; transactions?: readonly BankTransactionDto[]; invoices?: readonly InvoiceSummaryDto[]; failSettings?: boolean } = {}) {
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/receivables/settings')) {
      if (routes.failSettings === true) throw new Error('server down');
      return { settings, saved: routes.saved ?? true };
    }
    if (path.startsWith('/receivables/customers')) return { customers: [customer] };
    if (path.startsWith('/receivables/invoices/check')) return { check: { totals: { byRate: [], taxTotal: 0, grandTotal: 0 }, violations: [], warnings: [] } };
    if (path.startsWith('/receivables/invoices')) return { invoices: routes.invoices ?? [] };
    if (path.startsWith('/receivables/bank-transactions')) return { transactions: routes.transactions ?? [] };
    if (path.startsWith('/receivables/matchings')) return { matchings: [] };
    if (path.startsWith('/receivables/bank-csv-profiles')) return { profiles: [] };
    return {};
  });
  const client = { request, getJournalChart: vi.fn().mockResolvedValue({ accounts: [], dimensions: [], taxCategories: [], updatedAt: AT }), listJournalEntries: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
  return { client, request };
}

const renderPage = (client: ToolApiClient) => render(<NavigationProvider navigate={vi.fn()}><ReceivablesPage client={client} /></NavigationProvider>);
const selectedTab = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label');

describe('ReceivablesPage', () => {
  it('正常: 手順は 取引先 → 請求書作成 → 発行 → 明細取込 → 消込 → 仕訳連携。設定未保存なら取引先で開き、設定を案内する', async () => {
    renderPage(stubClient({ saved: false, transactions: [deposit] }).client);
    await waitFor(() => expect(selectedTab()).toBe('Customers'));
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Customers', 'Invoice', 'Issue', 'Bank import', 'Matching', 'Journal link']);
    expect(screen.getByText('Settings are not saved yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(await screen.findByRole('dialog', { name: 'Invoicing settings' })).toBeTruthy();
  });

  it('正常: 未消込の入金があれば消込で開き、判定前の入金には手動配分の導線を出す', async () => {
    renderPage(stubClient({ transactions: [deposit] }).client);
    await waitFor(() => expect(selectedTab()).toBe('Matching'));
    const card = await screen.findByRole('article', { name: /Deposit ヤマダ タロウ/ });
    expect(within(card).getByRole('button', { name: 'Allocate manually' })).toBeTruthy();
  });

  it('正常: 他画面からのディープリンク（取引先の別名）で取引先の編集パネルを開く', async () => {
    requestOpenInScreen('Receivables', { internalId: 'c1', section: 'customer-aliases' });
    renderPage(stubClient().client);
    await waitFor(() => expect(selectedTab()).toBe('Customers'));
    expect(await screen.findByDisplayValue('山田商事')).toBeTruthy();
    expect(screen.getByText('Learned')).toBeTruthy();
  });

  it('異常: 読み込みに失敗したら原因と再試行を出す', async () => {
    const { client, request } = stubClient({ failSettings: true });
    renderPage(client);
    expect(await screen.findByText('Could not load part of this screen')).toBeTruthy();
    const before = request.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
  });

  it('記述子: 一覧に並べ、画面は遅延読み込み', async () => {
    expect(receivablesBusiness).toMatchObject({ id: 'receivables', screen: 'Receivables', listed: true, card: { order: 30 } });
    expect(await receivablesBusiness.loadPage()).toBe(ReceivablesPage);
  });
});
