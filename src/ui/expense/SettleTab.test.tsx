// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpenseClaimDto, ExpenseClaimSummaryDto } from '../api/expense-types';
import { ApiError } from '../api/tool-api';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { SettleTab } from './SettleTab';

afterEach(() => { cleanup(); consumePendingOpen('Journal'); vi.restoreAllMocks(); });

const approved: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'approved', verdict: 'pass', stale: false, itemCount: 2, totalAmount: 3300, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};
const other: ExpenseClaimSummaryDto = { ...approved, id: 'c2', claimant: { name: '佐藤 花子' }, totalAmount: 1700, journalLinked: 'partial' };

function fakeApi(overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    exportSettlement: vi.fn().mockResolvedValue({ format: 'payout', fileName: 'expense-payout.csv', content: '﻿claim_id,total_amount\r\nc1,3300', claimCount: 1, itemCount: 2, totalAmount: 3300, corporatePaymentAmount: 0, warnings: ['仕訳下書きを作っていない申請があります: c1'] }),
    settleClaims: vi.fn().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]),
    createJournalDrafts: vi.fn().mockResolvedValue({ claim: { id: 'c1' } as ExpenseClaimDto, entryIds: ['e1', 'e2'], warnings: ['軽減税率の経過措置の税区分が無いため 8% の通常の税区分で作成しました'] }),
    ...overrides,
  } as unknown as ExpenseApi;
}

function renderTab(api: ExpenseApi, claims: readonly ExpenseClaimSummaryDto[] = [approved, other]) {
  const onOpen = vi.fn();
  const onTab = vi.fn();
  const navigate = vi.fn();
  const onClaimsChanged = vi.fn().mockResolvedValue(undefined);
  render(<NavigationProvider navigate={navigate}><SettleTab api={api} claims={claims} onClaimsChanged={onClaimsChanged} onOpen={onOpen} onTab={onTab} /></NavigationProvider>);
  return { onOpen, onTab, navigate, onClaimsChanged };
}

describe('SettleTab', () => {
  it('正常: 承認済みが無ければ承認への導線を出す', async () => {
    const { onTab } = renderTab(fakeApi(), [{ ...approved, status: 'checked' }]);
    expect(screen.getByText('There are no approved claims.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Approve' }));
    expect(onTab).toHaveBeenCalledWith('approve');
  });

  it('正常: 承認済みの合計を出し、選択を外すと合計が変わる', async () => {
    renderTab(fakeApi());
    expect(screen.getByText('¥5,000')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Select 佐藤 花子'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.getAllByText('¥3,300').length).toBeGreaterThanOrEqual(2);
  });

  it('正常: 形式を選んで CSV を作り、警告を出し、ダウンロードできない環境ではテキストエリアに出す', async () => {
    const api = fakeApi();
    renderTab(api);
    // Blob URL を作れない環境（古い WebView など）を再現する。
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('not supported'); });
    await userEvent.selectOptions(screen.getByDisplayValue('Payout (total per claim)'), 'detail');
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(api.exportSettlement).toHaveBeenCalledWith(expect.anything(), { format: 'detail', status: 'approved' });
    expect(await screen.findByText('仕訳下書きを作っていない申請があります: c1')).toBeTruthy();
    expect((screen.getByLabelText('Settlement CSV content') as HTMLTextAreaElement).value).toContain('claim_id,total_amount');
  });

  it('正常: 精算済みにするは対象を並べた確認ダイアログを挟み、出力したファイル名を添える', async () => {
    const api = fakeApi();
    const { onClaimsChanged } = renderTab(api);
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    await screen.findByText('仕訳下書きを作っていない申請があります: c1');
    await userEvent.click(screen.getByRole('button', { name: 'Mark as settled' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/佐藤 花子/)).toBeTruthy();
    expect(within(dialog).getByText('Total ¥5,000')).toBeTruthy();
    expect(api.settleClaims).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as settled' }));
    expect(api.settleClaims).toHaveBeenCalledWith(expect.anything(), ['c1', 'c2'], 'expense-payout.csv');
    expect(await screen.findByText('Marked 2 claims as settled.')).toBeTruthy();
    expect(onClaimsChanged).toHaveBeenCalled();
  });

  it('異常: 承認済みでない申請が混ざった 409 はその申請と状態を並べる', async () => {
    const api = fakeApi({ settleClaims: vi.fn().mockRejectedValue(new ApiError(409, 'EXPENSE_TRANSITION', 'not approved', undefined, { details: { blockingReasons: [], claims: [{ id: 'c2', status: 'draft' }, 'bad'] } })) });
    renderTab(api);
    await userEvent.click(screen.getByRole('button', { name: 'Mark as settled' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark as settled' }));
    expect(await screen.findByText('Some claims are not approved')).toBeTruthy();
    expect(screen.getByText('c2: Draft')).toBeTruthy();
  });

  it('正常: 仕訳下書きを作成したら件数と警告を出し、「仕訳画面で確定する」で仕訳の出力タブへ行く', async () => {
    const api = fakeApi();
    const { navigate } = renderTab(api);
    await userEvent.click(screen.getByRole('button', { name: 'Create journal drafts' }));
    expect(api.createJournalDrafts).toHaveBeenCalledWith(expect.anything(), 'c1');
    expect(await screen.findByText('Created 2 journal drafts.')).toBeTruthy();
    expect(screen.getByText(/軽減税率の経過措置/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm them in the journal screen' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'e1', section: 'entry' });
  });

  it('異常: 仕訳連携の 409 は問題を明細ごとのカードにし、直す場所のボタンと「続きを作成」を出す', async () => {
    const problems = [
      { itemId: 'i1', code: 'account-missing', message: '費目「タクシー」に科目がありません', fixTarget: 'policy-category', categoryId: 'transport.taxi' },
      { itemId: 'i2', code: 'account-rejected', message: '科目「旅費交通費」が無効です', fixTarget: 'journal-chart', accountId: 'expense.travel' },
    ];
    const createJournalDrafts = vi.fn().mockRejectedValue(new ApiError(409, 'EXPENSE_JOURNAL_LINK', 'link failed', undefined, { details: { problems, createdEntryIds: ['e1'] } }));
    const { onOpen, navigate } = renderTab(fakeApi({ createJournalDrafts }), [approved]);
    await userEvent.click(screen.getByRole('button', { name: 'Create journal drafts' }));
    const taxi = await screen.findByRole('article', { name: 'Item i1' });
    expect(within(taxi).getByText('費目「タクシー」に科目がありません')).toBeTruthy();
    await userEvent.click(within(taxi).getByRole('button', { name: 'Open the policy category' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: 'transport.taxi', section: 'category' });

    await userEvent.click(within(screen.getByRole('article', { name: 'Item i2' })).getByRole('button', { name: 'Open the journal chart of accounts' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'expense.travel', section: 'account' });

    expect(screen.getByText(/1 drafts were already created/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue creating' }));
    await waitFor(() => expect(createJournalDrafts).toHaveBeenCalledTimes(2));
  });

  it('異常: 仕訳連携以外の失敗は文言だけを出す', async () => {
    renderTab(fakeApi({ createJournalDrafts: vi.fn().mockRejectedValue(new Error('申請が見つかりません')) }), [approved]);
    await userEvent.click(screen.getByRole('button', { name: 'Create journal drafts' }));
    expect(await screen.findByText('申請が見つかりません')).toBeTruthy();
  });
});
