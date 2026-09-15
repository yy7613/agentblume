// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseSummaryResultDto, ExpenseSummaryRowDto } from '../../api/expense-money-types';
import { ApiError } from '../../api/tool-api';
import { ReportsLedger, monthOf, monthSpan, shiftMonth } from './ReportsLedger';
import { fakeTransport, ledgerProps, type FakeHandler, type FakeRequest } from './money-test-helpers';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function row(overrides: Partial<ExpenseSummaryRowDto> = {}): ExpenseSummaryRowDto {
  return {
    month: '2026-09', departmentId: null, department: null, categoryId: 'transport', category: '交通費', employeeId: null, claimant: null, status: null,
    claimCount: 2, itemCount: 3, amount: 5000, reimbursableAmount: 4000, corporateAmount: 1000, ...overrides,
  };
}

function summaryHandler(rows: readonly ExpenseSummaryRowDto[], warnings: readonly string[] = []): FakeHandler {
  return ({ query }: FakeRequest) => {
    const result: ExpenseSummaryResultDto = {
      rows, warnings, basis: 'transaction', from: query.get('from') ?? '', to: query.get('to') ?? '',
      totals: { claimCount: 2, itemCount: 3, amount: 5000, reimbursableAmount: 4000, corporateAmount: 1000 },
      groupBy: (query.get('groupBy') ?? '').split(',').filter((key) => key !== '') as ExpenseSummaryResultDto['groupBy'],
      statuses: (query.get('status') ?? '').split(',').filter((key) => key !== '') as ExpenseSummaryResultDto['statuses'],
    };
    return { result };
  };
}

function renderLedger(routes: Readonly<Record<string, FakeHandler>>) {
  const transport = fakeTransport(routes);
  const props = ledgerProps(transport);
  render(<ReportsLedger {...props} />);
  return { transport, props };
}

const lastSummaryQuery = (calls: readonly FakeRequest[]) => calls.filter((call) => call.path === '/expense/summary').at(-1)?.query;

describe('ReportsLedger', () => {
  it('正常: 開くと直近 12 か月・月 × 費目・承認済みと精算済みで集計し、表と合計と警告を出す', async () => {
    const { transport } = renderLedger({ 'GET /expense/summary': summaryHandler([row(), row({ month: '2026-08', category: null, categoryId: null })], ['取引日の無い明細 1 件を月「unknown」に数えました']) });
    const table = await screen.findByRole('table', { name: 'Expense summary' });
    const query = lastSummaryQuery(transport.calls);
    const thisMonth = monthOf(new Date());
    expect(query?.get('from')).toBe(shiftMonth(thisMonth, 11));
    expect(query?.get('to')).toBe(thisMonth);
    expect(query?.get('groupBy')).toBe('month,category');
    expect(query?.get('status')).toBe('approved,settled');
    expect(query?.get('basis')).toBe('transaction');
    expect(within(table).getByText('交通費')).toBeTruthy();
    expect(within(table).getByText('(no category)')).toBeTruthy();
    expect(within(table).getByText('Total')).toBeTruthy();
    expect(within(table).getAllByText('¥5,000').length).toBeGreaterThan(0);
    expect(screen.getByText('取引日の無い明細 1 件を月「unknown」に数えました')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('正常: グループ・基準日・状態を変えて集計し直す', async () => {
    const { transport } = renderLedger({ 'GET /expense/summary': summaryHandler([row({ department: null, departmentId: null, claimant: '山田 太郎', status: 'settled' })]) });
    await screen.findByRole('table', { name: 'Expense summary' });
    await userEvent.click(screen.getByLabelText('Category'));
    await userEvent.click(screen.getByLabelText('Department'));
    await userEvent.click(screen.getByLabelText('Claimant'));
    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.selectOptions(screen.getByLabelText('Date basis'), 'approved');
    await userEvent.click(screen.getByLabelText('Approved'));
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(lastSummaryQuery(transport.calls)?.get('groupBy')).toBe('month,department,claimant,status'));
    const query = lastSummaryQuery(transport.calls);
    expect(query?.get('status')).toBe('settled');
    expect(query?.get('basis')).toBe('approved');
    const table = await screen.findByRole('table', { name: 'Expense summary' });
    expect(within(table).getByText('(no department)')).toBeTruthy();
    expect(within(table).getByText('山田 太郎')).toBeTruthy();
    expect(within(table).getByText('Settled')).toBeTruthy();
  });

  it('正常: 0 件は赤くせず、状態の選択を広げるボタンですべての状態を集計する', async () => {
    const { transport } = renderLedger({ 'GET /expense/summary': summaryHandler([]) });
    expect(await screen.findByText('There are no approved or settled claims in this period.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Include claims in every status' }));
    await waitFor(() => expect(lastSummaryQuery(transport.calls)?.get('status')).toBe('draft,checked,in-approval,returned,approved,settled'));
    expect(await screen.findByText('There are no claims matching these conditions in this period.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Include claims in every status' })).toBeNull();
    expect((screen.getByLabelText('Draft') as HTMLInputElement).checked).toBe(true);
  });

  it('正常: 状態を 1 つも選ばなければ既定（承認済み・精算済み）で数えると案内する', async () => {
    const { transport } = renderLedger({ 'GET /expense/summary': summaryHandler([row()]) });
    await screen.findByRole('table', { name: 'Expense summary' });
    await userEvent.click(screen.getByLabelText('Approved'));
    await userEvent.click(screen.getByLabelText('Settled'));
    expect(screen.getByText('No status is selected, so approved and settled claims are counted.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(transport.calls.filter((call) => call.path === '/expense/summary')).toHaveLength(2));
    expect(lastSummaryQuery(transport.calls)?.get('status')).toBeNull();
  });

  it('正常: CSV を出力し、ダウンロードできない環境ではテキストエリアに出す', async () => {
    const { transport } = renderLedger({
      'GET /expense/summary': summaryHandler([row()]),
      'GET /expense/summary/export': () => ({ content: '﻿month,category,amount\r\n2026-09,交通費,5000', fileName: 'expense-summary.csv' }),
    });
    await screen.findByRole('table', { name: 'Expense summary' });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('not supported'); });
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('Created expense-summary.csv.')).toBeTruthy();
    expect((screen.getByLabelText('Summary CSV content') as HTMLTextAreaElement).value).toContain('2026-09,交通費,5000');
    expect(transport.calls.find((call) => call.path === '/expense/summary/export')?.query.get('groupBy')).toBe('month,category');
  });

  it('境界: 期間が逆・36 か月超え・未入力は送らずに直し方を出す', async () => {
    const { transport } = renderLedger({ 'GET /expense/summary': summaryHandler([row()]) });
    await screen.findByRole('table', { name: 'Expense summary' });
    fireEvent.change(screen.getByLabelText('From (month)'), { target: { value: '2026-10' } });
    fireEvent.change(screen.getByLabelText('To (month)'), { target: { value: '2026-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(screen.getByText('The start month must not be after the end month.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From (month)'), { target: { value: '2023-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(screen.getByText('The period can be at most 36 months. Narrow it down.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From (month)'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(screen.getByText('Choose both the start and end months.')).toBeTruthy();
    expect(transport.calls.filter((call) => call.path.startsWith('/expense/summary'))).toHaveLength(1);
  });

  it('異常: 400 は原因の詳細と直し方を平易に出す（グループの誤りと期間の誤りで文言を分ける）', async () => {
    let field = 'period';
    const { transport } = renderLedger({
      'GET /expense/summary': () => { throw new ApiError(400, 'EXPENSE_DOMAIN', `invalid query: bad ${field}`, undefined, { details: { field } }); },
      'GET /expense/summary/export': () => { throw new Error('export down'); },
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('invalid query: bad period')).toBeTruthy();
    expect(within(alert).getByText(/Check the period \(months, start before end, at most 36 months\)/)).toBeTruthy();
    field = 'groupBy';
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('Check the grouping choices, then summarize again.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('export down')).toBeTruthy();
    expect(transport.calls.length).toBeGreaterThan(1);
  });

  it('shiftMonth / monthSpan: 年をまたぐ月の計算', () => {
    expect(shiftMonth('2026-01', 1)).toBe('2025-12');
    expect(shiftMonth('2026-09', 11)).toBe('2025-10');
    expect(shiftMonth('2025-12', -1)).toBe('2026-01');
    expect(monthSpan('2025-10', '2026-09')).toBe(12);
    expect(monthOf(new Date(2026, 0, 31))).toBe('2026-01');
  });
});
