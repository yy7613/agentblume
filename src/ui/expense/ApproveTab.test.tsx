// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpenseClaimDto, ExpenseClaimSummaryDto } from '../api/expense-types';
import { ApiError } from '../api/tool-api';
import { NavigationProvider } from '../navigation';
import { ApproveTab } from './ApproveTab';

afterEach(() => { cleanup(); Reflect.deleteProperty(window.navigator, 'clipboard'); });

const summary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'checked', verdict: 'needs-review', stale: false, itemCount: 1, totalAmount: 1100, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 1, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};
const checked: ExpenseClaimDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'checked', acknowledgements: [], history: [],
  items: [{ id: 'i1', facts: { amount: 1100, description: '弁当' }, hasReceipt: false, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } }],
  judgment: {
    verdict: 'needs-review', claimReasons: [],
    items: [{ itemId: 'i1', verdict: 'needs-review', reasons: [{ code: 'payee-missing', severity: 'review', itemId: 'i1', params: {}, searchKey: 'payee' }] }],
    totals: { amount: 1100, byCategory: [] }, searchKeysComplete: false, policyUpdatedAt: 'p', itemsFingerprint: 'f', checkedAt: 'x',
  },
  submittedBy: 'u1', createdAt: 'x', updatedAt: 'x', totalAmount: 1100, reimbursableAmount: 1100, stale: false,
  approvalBlockers: [{ code: 'payee-missing', itemId: 'i1' }, { code: 'self-approval' }],
};

function fakeApi(claim: ExpenseClaimDto, overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    getClaim: vi.fn().mockResolvedValue(claim),
    acknowledge: vi.fn().mockResolvedValue({ ...claim, approvalBlockers: [] }),
    approve: vi.fn().mockResolvedValue({ ...claim, status: 'approved' }),
    returnDraft: vi.fn().mockResolvedValue('山田 太郎 さん\n1. 明細「弁当」: 支払先を記入してください'),
    returnClaim: vi.fn().mockResolvedValue({ ...claim, status: 'returned' }),
    unapprove: vi.fn().mockResolvedValue({ ...claim, status: 'checked' }),
    ...overrides,
  } as unknown as ExpenseApi;
}

/** `selectedClaimId` の null は「申請を選んでいない」（既定値 'c1' と区別するため undefined にしない）。 */
function renderTab(api: ExpenseApi, claims: readonly ExpenseClaimSummaryDto[] = [summary], selectedClaimId: string | null = 'c1') {
  const onOpen = vi.fn();
  const onTab = vi.fn();
  const onClaimsChanged = vi.fn().mockResolvedValue(undefined);
  render(<NavigationProvider navigate={vi.fn()}>
    <ApproveTab api={api} claims={claims} onClaimsChanged={onClaimsChanged} selectedClaimId={selectedClaimId ?? undefined} onSelectClaim={vi.fn()} onOpen={onOpen} onTab={onTab} />
  </NavigationProvider>);
  return { onOpen, onTab, onClaimsChanged };
}

describe('ApproveTab', () => {
  it('正常: 承認待ちが無ければチェックへの導線を出す', async () => {
    const { onTab } = renderTab(fakeApi(checked), [], null);
    expect(screen.getByText('No claims are waiting for approval.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Check' }));
    expect(onTab).toHaveBeenCalledWith('check');
  });

  it('正常: 承認できない理由を一覧にし、承認ボタンを押せなくし、各理由から直す場所を開ける', async () => {
    const { onOpen } = renderTab(fakeApi(checked));
    const list = await screen.findByRole('note', { name: 'Why it cannot be approved' });
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(list).getByText(/^Payee missing: There is no payee/)).toBeTruthy();
    expect(within(list).getByText('You imported this claim yourself')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Open the policy' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: '', section: 'rules' });
    await userEvent.click(within(list).getByRole('button', { name: 'Enter the payee' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: 'c1', section: 'item:i1', nodeId: 'payeeName' });
  });

  it('正常: 要確認の理由は根拠コメントを書くまで確認済みにできない', async () => {
    const api = fakeApi(checked);
    const { onClaimsChanged } = renderTab(api);
    const button = await screen.findByRole('button', { name: 'Mark as reviewed' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Comment for Payee missing'), '領収書に店名が無いが、カード明細で確認済み');
    await userEvent.click(button);
    expect(api.acknowledge).toHaveBeenCalledWith(expect.anything(), 'c1', { itemId: 'i1', code: 'payee-missing', note: '領収書に店名が無いが、カード明細で確認済み' });
    expect(await screen.findByText('Marked as reviewed.')).toBeTruthy();
    expect(onClaimsChanged).toHaveBeenCalled();
  });

  it('異常: 承認が 409 で断られたら details.blockingReasons を理由の一覧に足す', async () => {
    const ready = { ...checked, approvalBlockers: [] };
    const api = fakeApi(ready, { approve: vi.fn().mockRejectedValue(new ApiError(409, 'EXPENSE_TRANSITION', 'judgment is stale', undefined, { details: { blockingReasons: [{ code: 'judgment-stale' }], nextStep: '再チェックしてください' } })) });
    const { onOpen } = renderTab(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const list = await screen.findByRole('note', { name: 'Why it cannot be approved' });
    expect(within(list).getByText('The policy or items changed after the check')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Open Check' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: 'c1', section: 'claim' });
  });

  it('正常: 差し戻し文言を下書きから作り、コピーし、確認ダイアログを経て差し戻す', async () => {
    const api = fakeApi(checked);
    renderTab(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Draft the return message' }));
    const textarea = await screen.findByLabelText('Return message') as HTMLTextAreaElement;
    expect(textarea.value).toContain('支払先を記入してください');
    await userEvent.type(textarea, '\nよろしくお願いします');

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy the message' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('よろしくお願いします')));
    expect(await screen.findByText(/^Copied\. Paste it/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Return' }));
    expect(api.returnClaim).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Return' }));
    await waitFor(() => expect(api.returnClaim).toHaveBeenCalledWith(expect.anything(), 'c1', expect.stringContaining('よろしくお願いします')));
  });

  it('異常: クリップボードが使えなければ手でコピーする案内を出す', async () => {
    renderTab(fakeApi(checked));
    await userEvent.click(await screen.findByRole('button', { name: 'Draft the return message' }));
    await screen.findByLabelText('Return message');
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy the message' }));
    expect(await screen.findByText('Could not copy automatically. Select the text above and copy it by hand.')).toBeTruthy();
  });

  it('正常: 承認済みの承認取消は理由を必須にし、確認ダイアログを挟む', async () => {
    const approved: ExpenseClaimDto = { ...checked, status: 'approved', approvalBlockers: [], approval: { by: 'u2', at: '2026-09-03T00:00:00.000Z' } };
    const api = fakeApi(approved);
    renderTab(api, [{ ...summary, status: 'approved' }]);
    const cancel = await screen.findByRole('button', { name: 'Cancel the approval' });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Reason for cancelling'), '金額の誤り');
    await userEvent.click(cancel);
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel the approval' }));
    expect(api.unapprove).toHaveBeenCalledWith(expect.anything(), 'c1', '金額の誤り');
  });

  it('境界: 仕訳下書きを作成済みの承認は取り消せないと説明する', async () => {
    const linked: ExpenseClaimDto = { ...checked, status: 'approved', approvalBlockers: [], approval: { by: 'u2', at: 'x' }, journalLink: { entries: [], complete: true, draftedAt: 'x', by: 'u2', warnings: [] } };
    renderTab(fakeApi(linked), [{ ...summary, status: 'approved' }]);
    expect(await screen.findByText('This claim already has journal drafts or is settled, so the approval cannot be cancelled.')).toBeTruthy();
    expect(screen.queryByLabelText('Reason for cancelling')).toBeNull();
  });

  it('正常: 承認中（in-approval）の申請は承認待ちに並び、承認では画面を開いたときの現在の段の id を送る', async () => {
    const inApproval: ExpenseClaimDto = {
      ...checked, status: 'in-approval', approvalBlockers: [],
      approvalFlow: {
        routeId: 'high', routeName: '高額', resolvedAt: 'x', policyUpdatedAt: 'p', currentIndex: 1,
        steps: [
          { stepId: 'manager', name: '上長', approverKind: 'claimant-manager', approvers: [{ employeeId: 'e2', name: '鈴木' }], status: 'approved', decision: { by: 'u2', at: 'x', proxy: false } },
          { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'e3', name: '高橋' }], status: 'pending' },
        ],
      },
    };
    const api = fakeApi(inApproval);
    renderTab(api, [{ ...summary, status: 'in-approval' }]);
    const list = screen.getByRole('heading', { name: 'Waiting for approval' }).nextElementSibling as HTMLElement;
    expect(within(list).getByText('In approval')).toBeTruthy();
    await userEvent.type(await screen.findByLabelText('Comment (optional)'), '部長の代理');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(api.approve).toHaveBeenCalledWith(expect.anything(), 'c1', '部長の代理', 'head');
  });

  it('正常: 承認経路の拒否理由（§20.5.1）は段と承認者を見せ、承認経路へ・再読み込み・コメント欄への導線を出す', async () => {
    const blocked: ExpenseClaimDto = {
      ...checked, status: 'in-approval',
      approvalBlockers: [
        { code: 'approval-not-current-approver', params: { stepName: '部門長', approvers: '高橋' } },
        { code: 'approval-step-changed', params: { stepName: '経理' } },
        { code: 'approval-proxy-comment-missing' },
      ],
    };
    const api = fakeApi(blocked);
    const { onOpen, onClaimsChanged } = renderTab(api, [{ ...summary, status: 'in-approval' }]);
    const list = await screen.findByRole('note', { name: 'Why it cannot be approved' });
    expect(within(list).getByText('You are not an approver of the current step "部門長" (approvers: 高橋)')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Open the approval routes' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: '', section: 'approval' });
    await userEvent.click(within(list).getByRole('button', { name: 'Go to the comment' }));
    expect(document.activeElement?.id).toBe('expense-approve-comment');
    const loads = (api.getClaim as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(within(list).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((api.getClaim as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loads + 1));
    expect(onClaimsChanged).toHaveBeenCalled();
  });

  it('正常: 差し戻し中の申請は文言を見せ、取込で修正を反映する導線を出す', async () => {
    const returned: ExpenseClaimDto = { ...checked, status: 'returned', approvalBlockers: [], returnNote: { message: '支払先を記入してください', reasons: [], by: 'u2', at: 'x' } };
    const { onOpen } = renderTab(fakeApi(returned), [{ ...summary, status: 'returned' }]);
    expect(await screen.findByText('支払先を記入してください')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apply the fixes in Ingest' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: 'c1', section: 'item:' });
  });
});
