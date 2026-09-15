// @vitest-environment jsdom
/**
 * 入金消込の主要なステップのフォーム操作（取引先・請求書作成・発行・明細取込・消込）。API は偽物を直接渡す。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceivablesApi } from '../api/receivables-api';
import type { BankTransactionDto, CustomerDto, InvoiceSummaryDto } from '../api/receivables-types';
import { ApiError } from '../api/tool-api';
import { NavigationProvider } from '../navigation';
import { BankImportStep } from './BankImportStep';
import { CustomersStep } from './CustomersStep';
import { InvoiceEditorStep } from './InvoiceEditorStep';
import { IssueStep } from './IssueStep';
import { MatchingStep } from './MatchingStep';

afterEach(() => { cleanup(); });

const AT = '2026-09-01T00:00:00.000Z';
const check = (overrides = {}) => ({ totals: { byRate: [{ rate: 10, taxable: 1000, tax: 100, inclusive: 1100 }], taxTotal: 100, grandTotal: 1100 }, violations: [], warnings: [], ...overrides });
const customer: CustomerDto = { id: 'c1', name: '山田商事', honorific: '御中', paymentTermDays: 30, payerAliases: [], enabled: true, createdAt: AT, updatedAt: AT };

function fakeApi(overrides: Partial<Record<keyof ReceivablesApi, unknown>> = {}): ReceivablesApi {
  return {
    checkInvoice: vi.fn().mockResolvedValue(check()),
    saveInvoice: vi.fn().mockResolvedValue({ invoice: { id: 'i1' }, check: check() }),
    saveCustomer: vi.fn().mockResolvedValue({ customer: { ...customer, id: 'c2' }, warnings: [] }),
    deleteCustomer: vi.fn().mockResolvedValue(undefined),
    listProfiles: vi.fn().mockResolvedValue([]),
    listMatchings: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ReceivablesApi;
}
const wrap = (node: React.ReactNode) => render(<NavigationProvider navigate={vi.fn()}>{node}</NavigationProvider>);

describe('CustomersStep', () => {
  it('正常: 取引先と別名を入力して保存する。別の取引先との衝突は警告と衝突先を開くボタン', async () => {
    const api = fakeApi({ saveCustomer: vi.fn().mockResolvedValue({ customer: { ...customer, id: 'c2', name: '別会社' }, warnings: [{ normalized: 'ヤマダ', otherCustomerId: 'c1', otherCustomerName: '山田商事' }] }) });
    const onChanged = vi.fn();
    wrap(<CustomersStep api={api} customers={[customer]} focus={undefined} settingsSaved={true} onChanged={onChanged} onOpenSettings={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a customer' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Customer name' }), '別会社');
    await userEvent.type(screen.getByRole('textbox', { name: 'New alias' }), 'やまだ');
    expect(screen.getByText('Matched as: ヤマダ')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save customer' }));
    await waitFor(() => expect(api.saveCustomer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: '別会社', payerAliases: [{ text: 'やまだ' }] }), undefined));
    expect(await screen.findByRole('button', { name: 'Open 山田商事' })).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('異常: 参照ありの削除は原因と次の一手を出す', async () => {
    const api = fakeApi({ deleteCustomer: vi.fn().mockRejectedValue(new ApiError(409, 'RECEIVABLES_STATE', 'in use', undefined, { details: { reason: 'customer-in-use' } })) });
    wrap(<CustomersStep api={api} customers={[customer]} focus={{ id: 'c1', section: 'customer', seq: 1 }} settingsSaved={true} onChanged={vi.fn()} onOpenSettings={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete customer' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Disable it instead'));
  });
});

describe('InvoiceEditorStep', () => {
  it('正常: 取引先で期日を既定し、明細を入力して下書きを保存する。税率別集計をライブで出す', async () => {
    const api = fakeApi();
    const onSaved = vi.fn();
    wrap(<InvoiceEditorStep api={api} customers={[customer]} settings={undefined} editing={undefined} today="2026-09-30" onSaved={onSaved} onOpenSettings={vi.fn()} onOpenCustomers={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Customer' }), 'c1');
    expect((screen.getByLabelText('Due date') as HTMLInputElement).value).toBe('2026-10-30');
    await userEvent.type(screen.getByRole('textbox', { name: 'Line 1 description' }), '開発費');
    await userEvent.type(screen.getByRole('textbox', { name: 'Line 1 amount' }), '1000');
    await waitFor(() => expect(screen.getByTestId('receivables-grand-total').textContent).toBe('¥1,100'), { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveInvoice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'c1', lines: [{ description: '開発費', amount: 1000, taxRate: 10 }] }), undefined));
    expect(onSaved).toHaveBeenCalledWith({ id: 'i1' });
  });

  it('正常: JSON を貼り付けて読み込み、明細ごとの丸めの違反は「計算値で置き換える」で申告値を外す', async () => {
    const violation = { code: 'per-line-rounding', path: 'totals', params: { rate: 10, declared: 702, perLine: 702, once: 703, difference: -1 } };
    const checkInvoice = vi.fn().mockImplementation(async (_scope, content: { declared?: unknown }) => content.declared === undefined ? check() : check({ violations: [violation] }));
    const api = fakeApi({ checkInvoice });
    wrap(<InvoiceEditorStep api={api} customers={[customer]} settings={undefined} editing={undefined} today="2026-09-30" onSaved={vi.fn()} onOpenSettings={vi.fn()} onOpenCustomers={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Paste JSON' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Invoice JSON' }), { target: { value: 'nope' } });
    await userEvent.click(screen.getByRole('button', { name: 'Load into the form' }));
    expect(screen.getByText(/This is not valid JSON/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Invoice JSON' }), { target: { value: JSON.stringify({ pricing: 'exclusive', customerNameHint: '未登録商店', lines: [{ description: 'A', amount: 1234, taxRate: 10 }], declared: { lineTaxAmounts: [123] } }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Load into the form' }));
    expect(await screen.findByText(/no saved customer matches/)).toBeTruthy();
    const replace = await screen.findByRole('button', { name: 'Replace with the computed value' }, { timeout: 2000 });
    await userEvent.click(replace);
    await waitFor(() => expect(checkInvoice).toHaveBeenLastCalledWith(expect.anything(), expect.not.objectContaining({ declared: expect.anything() })), { timeout: 2000 });
  });

  it('境界: 取引先が 0 件なら取引先の登録へ案内する', async () => {
    const onOpenCustomers = vi.fn();
    wrap(<InvoiceEditorStep api={fakeApi()} customers={[]} settings={undefined} editing={undefined} today="2026-09-30" onSaved={vi.fn()} onOpenSettings={vi.fn()} onOpenCustomers={onOpenCustomers} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go to Customers' }));
    expect(onOpenCustomers).toHaveBeenCalled();
  });
});

describe('IssueStep', () => {
  const summary = (overrides: Partial<InvoiceSummaryDto>): InvoiceSummaryDto => ({
    id: 'i1', status: 'draft', pricing: 'exclusive', lines: [], roundingMode: 'floor', totals: { byRate: [], taxTotal: 0, grandTotal: 1100 }, paidAmount: 0, journal: {},
    createdAt: AT, updatedAt: AT, outstanding: 0, daysOverdue: 0, violationCount: 0, customerName: '山田商事', ...overrides,
  });

  it('正常: 違反のある下書きは発行できない。発行すると確定済み仕訳の要対応を出す。取消は理由が必須', async () => {
    const api = fakeApi({
      issueInvoice: vi.fn().mockResolvedValue({ invoice: { number: 'INV-2026-0001' }, journalFollowUp: { entryId: 'e1', action: 'review' } }),
      voidInvoice: vi.fn().mockResolvedValue({ invoice: {} }),
    });
    const invoices = [summary({ id: 'bad', violationCount: 2 }), summary({ id: 'ok' }), summary({ id: 'issued', status: 'issued', number: 'INV-2026-0000', outstanding: 1100 })];
    wrap(<IssueStep api={api} invoices={invoices} focus={undefined} onChanged={vi.fn()} onEdit={vi.fn()} onOpenSettings={vi.fn()} onGoToEditor={vi.fn()} />);
    const issueButtons = screen.getAllByRole('button', { name: 'Issue' });
    expect((issueButtons[0] as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(issueButtons[1]!);
    await waitFor(() => expect(api.issueInvoice).toHaveBeenCalledWith(expect.anything(), 'ok'));
    expect(await screen.findByRole('button', { name: 'Open the journal entry' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Void' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));
    expect(api.voidInvoice).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Void reason' }), '宛名の誤り');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(api.voidInvoice).toHaveBeenCalledWith(expect.anything(), 'issued', '宛名の誤り'));
  });

  it('異常: 発行の違反は一覧で出し、設定の不足は設定を開くボタン', async () => {
    const onOpenSettings = vi.fn();
    const api = fakeApi({ issueInvoice: vi.fn().mockRejectedValue(new ApiError(400, 'RECEIVABLES_INVOICE_COMPLIANCE', 'no', undefined, { details: { violations: [{ code: 'issuer-name-missing', params: {} }] } })) });
    wrap(<IssueStep api={api} invoices={[summary({})]} focus={undefined} onChanged={vi.fn()} onEdit={vi.fn()} onOpenSettings={onOpenSettings} onGoToEditor={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Issue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledWith('issuer');
  });
});

describe('BankImportStep', () => {
  it('正常: 未知の列構成は必須列を割り当てるまで取り込めず、重複は選んで取り込み直せる', async () => {
    const preview = { encoding: 'utf-8', warnings: [], headerRow: 4, headers: ['取引日', 'お預入金額', '振込依頼人名'], mappingRequired: true, mappingProblems: ['date', 'deposit-or-amount'], preamble: [], rows: [['2026/09/30', '1000', 'ﾃｽﾄ']], dataRowCount: 1 };
    const importCsv = vi.fn()
      .mockResolvedValueOnce({ encoding: 'utf-8', imported: [], skippedWithdrawals: 0, duplicates: [{ row: 5, date: '2026-09-30', amount: 1000, payerName: 'ﾃｽﾄ', existingId: 'x' }], skippedRows: [], warnings: [{ code: 'no-balance-column', params: {} }] })
      .mockResolvedValueOnce({ encoding: 'utf-8', imported: [{ id: 't' }], skippedWithdrawals: 0, duplicates: [], skippedRows: [], warnings: [] });
    const api = fakeApi({ previewCsv: vi.fn().mockResolvedValue(preview), importCsv });
    const onImported = vi.fn();
    wrap(<BankImportStep api={api} onImported={onImported} />);
    await userEvent.upload(screen.getByLabelText('CSV file'), new File(['取引日,お預入金額\n'], 'bank.csv', { type: 'text/csv' }));
    const importButton = await screen.findByRole('button', { name: 'Import deposits' });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Date column');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Date (required)' }), '取引日');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Deposit' }), 'お預入金額');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Payer name' }), '振込依頼人名');
    await userEvent.click(importButton);
    await waitFor(() => expect(importCsv).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fileName: 'bank.csv', headerRow: 4, mapping: { date: '取引日', deposit: 'お預入金額', payerName: '振込依頼人名' } })));
    expect(await screen.findByText(/no balance column/)).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Import row 5 anyway' }));
    await userEvent.click(screen.getByRole('button', { name: 'Import the selected rows' }));
    await waitFor(() => expect(importCsv).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ forceRows: [5] })));
    expect(onImported).toHaveBeenCalledTimes(2);
  });
});

describe('MatchingStep', () => {
  const judged: BankTransactionDto = {
    id: 't1', accountKey: 'main', date: '2026-09-30', amount: 88_000, description: 'ﾌﾘｺﾐ', payerName: 'ヤマダ タロウ', payerNameNorm: 'ヤマダタロウ', source: { row: {}, rowNumber: 2 }, fingerprint: 'f', status: 'unmatched', createdAt: AT, updatedAt: AT,
    judgment: { stage: 'candidate', reason: 'amount-only', candidates: [{ invoiceIds: ['i5'], allocations: [{ invoiceId: 'i5', amount: 88_000 }], candidateTotal: 88_000, difference: 0, feeAmount: 0, customerId: 'c1', nameMatch: 'none', nameScore: 0, rank: 1 }] },
  };
  const invoice = { id: 'i5', number: 'INV-0005', status: 'issued', outstanding: 88_000, customerName: '山田デザイン事務所' } as InvoiceSummaryDto;

  it('正常: 原因・次の一手を出し、「確定して名義を覚える」は別名の学習つきで確定する。判定の実行', async () => {
    const api = fakeApi({ confirmMatching: vi.fn().mockResolvedValue({ matching: {}, journal: { status: 'created' } }), judge: vi.fn().mockResolvedValue({ judged: [], counts: { decided: 1, candidate: 0, unmatched: 0 } }) });
    const onChanged = vi.fn();
    wrap(<MatchingStep api={api} transactions={[judged]} invoices={[invoice]} customers={[{ ...customer, name: '山田デザイン事務所' }]} focus={undefined} onChanged={onChanged} onAction={vi.fn()} />);
    const card = screen.getByRole('article', { name: /Deposit ヤマダ タロウ/ });
    expect(within(card).getByText(/matches no customer, but the amount matches INV-0005 of 山田デザイン事務所/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Confirm and remember the name' }));
    await waitFor(() => expect(api.confirmMatching).toHaveBeenCalledWith(expect.anything(), { transactionId: 't1', allocations: [{ invoiceId: 'i5', amount: 88_000 }], feeAmount: 0, expectedOutstanding: { i5: 88_000 }, learnAlias: { customerId: 'c1' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Judge deposits' }));
    expect(await screen.findByText(/Judged: 1 decided/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('正常: 配分を編集して合計が合ったときだけ確定できる。残高が変わっていたら再判定を案内する', async () => {
    const api = fakeApi({ confirmMatching: vi.fn().mockRejectedValue(new ApiError(409, 'RECEIVABLES_STATE', 'changed', undefined, { details: { reason: 'invoice-outstanding-changed' } })) });
    wrap(<MatchingStep api={api} transactions={[{ ...judged, judgment: { stage: 'unmatched', reason: 'multiple-candidates', candidates: judged.judgment!.candidates } }]} invoices={[invoice]} customers={[customer]} focus={undefined} onChanged={vi.fn()} onAction={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit allocation' }));
    const editor = screen.getByRole('dialog', { name: 'Edit allocation' });
    const amount = within(editor).getByRole('spinbutton', { name: 'Allocate to INV-0005' });
    fireEvent.change(amount, { target: { value: '80000' } });
    expect((within(editor).getByRole('button', { name: 'Confirm allocation' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(amount, { target: { value: '88000' } });
    await userEvent.click(within(editor).getByRole('button', { name: 'Confirm allocation' }));
    expect(await screen.findByRole('button', { name: 'Judge again' })).toBeTruthy();
  });
});
