// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpenseClaimDto, ExpenseClaimSummaryDto } from '../api/expense-types';
import { NavigationProvider } from '../navigation';
import { CheckTab } from './CheckTab';
import type { ExpenseFocusRequest } from './expense-shared';

afterEach(cleanup);

const summary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'checked', verdict: 'returned', stale: true, itemCount: 2, totalAmount: 5000, corporatePaymentAmount: 0,
  reasonCounts: { return: 1, review: 1, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};
const claim: ExpenseClaimDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'checked', acknowledgements: [], history: [],
  items: [
    { id: 'i1', categoryId: 'meal.meeting', facts: { transactionDate: '2026-09-05', payeeName: '店', description: '弁当' }, hasReceipt: false, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } },
    { id: 'i2', facts: { transactionDate: '2026-09-06', payeeName: '交通', amount: 5000, description: 'タクシー' }, hasReceipt: true, source: { type: 'image' }, extraction: { method: 'llm', warnings: [] } },
  ],
  judgment: {
    verdict: 'returned', claimReasons: [{ code: 'policy-unreviewed', severity: 'review', params: {} }],
    items: [
      { itemId: 'i1', verdict: 'returned', reasons: [{ code: 'amount-missing', severity: 'return', itemId: 'i1', params: { amount: null }, searchKey: 'amount' }] },
      { itemId: 'i2', verdict: 'needs-review', reasons: [{ code: 'duplicate-across-claims', severity: 'review', itemId: 'i2', params: { otherClaimId: 'c9', otherItemId: 'x1', otherStatus: 'draft', claimantName: '佐藤', weak: false } }] },
    ],
    totals: { amount: 5000, byCategory: [] }, searchKeysComplete: false, policyUpdatedAt: 'p', itemsFingerprint: 'f', checkedAt: '2026-09-02T00:00:00.000Z',
  },
  submittedBy: 'u1', createdAt: 'x', updatedAt: 'x', totalAmount: 5000, reimbursableAmount: 5000, stale: true, approvalBlockers: [],
};

function fakeApi(overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    getClaim: vi.fn().mockResolvedValue(claim),
    checkClaims: vi.fn().mockResolvedValue({ checked: 2, pass: 1, needsReview: 1, returned: 0, skipped: 0 }),
    getReceipt: vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,AAA', fileName: 'taxi.png' }),
    ...overrides,
  } as unknown as ExpenseApi;
}

function renderTab(options: { readonly api?: ExpenseApi; readonly claims?: readonly ExpenseClaimSummaryDto[]; readonly selectedClaimId?: string; readonly focus?: ExpenseFocusRequest } = {}) {
  const api = options.api ?? fakeApi();
  const onOpen = vi.fn();
  const onTab = vi.fn();
  const onClaimsChanged = vi.fn().mockResolvedValue(undefined);
  render(<NavigationProvider navigate={vi.fn()}>
    <CheckTab api={api} policy={undefined} claims={options.claims ?? [summary]} onClaimsChanged={onClaimsChanged} selectedClaimId={options.selectedClaimId}
      onSelectClaim={vi.fn()} focus={options.focus} onOpen={onOpen} onTab={onTab} />
  </NavigationProvider>);
  return { api, onOpen, onTab, onClaimsChanged };
}

describe('CheckTab', () => {
  it('正常: チェックする申請が無ければ取込への導線を出す', async () => {
    const { onTab } = renderTab({ claims: [] });
    expect(screen.getByText('There are no claims to check.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Ingest' }));
    expect(onTab).toHaveBeenCalledWith('ingest');
  });

  it('正常: 未チェックをまとめてチェックし、件数を出して一覧を読み直す', async () => {
    const { api, onClaimsChanged } = renderTab();
    await userEvent.click(screen.getByRole('button', { name: 'Check unchecked claims' }));
    expect(api.checkClaims).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(await screen.findByText('Checked 2: 1 pass, 1 need review, 0 return (0 skipped).')).toBeTruthy();
    expect(onClaimsChanged).toHaveBeenCalled();
  });

  it('正常: 判定チップと、規程か明細が変わった申請の再チェックの案内', async () => {
    renderTab({ selectedClaimId: 'c1' });
    expect(await screen.findByRole('heading', { name: '山田 太郎 · 2026-09-01〜2026-09-30' })).toBeTruthy();
    expect(screen.getAllByText('The policy or items changed. Check again.').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Return (outdated)').length).toBeGreaterThan(0);
  });

  it('正常: 理由カードは原因 → 次の一手 → 導線ボタンで、ボタンは正しい OpenTarget を開く', async () => {
    const { onOpen } = renderTab({ selectedClaimId: 'c1' });
    const amount = await screen.findByRole('article', { name: 'Return: Amount missing' });
    expect(within(amount).getByText(/There is no amount/)).toBeTruthy();
    expect(within(amount).getByText(/Look at the receipt and enter the tax-inclusive amount paid/)).toBeTruthy();
    // 領収書の無い明細には「領収書を見る」を出さない。
    expect(within(amount).queryByRole('button', { name: 'View the receipt' })).toBeNull();
    await userEvent.click(within(amount).getByRole('button', { name: 'Enter the amount' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: 'c1', section: 'item:i1', nodeId: 'amount' });

    await userEvent.click(within(screen.getByRole('article', { name: 'Needs review: Duplicate of another claim' })).getByRole('button', { name: 'Open the other claim' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: 'c9', section: 'claim' });

    await userEvent.click(within(screen.getByRole('article', { name: 'Needs review: Policy not saved yet' })).getByRole('button', { name: 'Open the policy' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: '', section: 'save' });
  });

  it('正常: 電帳法の検索要件 3 点を明細ごとに ✓ / ✗ で出し、領収書ビューアを開ける', async () => {
    const { api } = renderTab({ selectedClaimId: 'c1' });
    const lunch = await screen.findByRole('article', { name: '弁当' });
    expect(within(lunch).getByText('Amount ✗')).toBeTruthy();
    expect(within(lunch).getByText('Date ✓')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'View the receipt' }));
    expect(await screen.findByRole('img', { name: 'taxi.png' })).toBeTruthy();
    expect(api.getReceipt).toHaveBeenCalledWith(expect.anything(), 'c1', 'i2');
  });

  it('正常: 導線 receipt:<itemId> から来たら領収書ビューアを開く', async () => {
    renderTab({ selectedClaimId: 'c1', focus: { tab: 'check', section: 'receipt', id: 'c1', itemId: 'i2', seq: 1 } });
    await waitFor(() => expect(screen.getByRole('img', { name: 'taxi.png' })).toBeTruthy());
  });

  it('異常: チェックの失敗はサーバーの文言を出す', async () => {
    renderTab({ api: fakeApi({ checkClaims: vi.fn().mockRejectedValue(new Error('規程を読めませんでした')) }) });
    await userEvent.click(screen.getByRole('button', { name: 'Check unchecked claims' }));
    expect(await screen.findByText('規程を読めませんでした')).toBeTruthy();
  });
});
