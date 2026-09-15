// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiTransport } from '../../api/business-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApprovalFlowViewDto } from '../../api/expense-people-types';
import type { ExpenseClaimDto, ExpenseClaimSummaryDto } from '../../api/expense-types';
import { ApprovalFlowPanel } from './ApprovalFlowPanel';

afterEach(cleanup);

const scope = { tenantId: 't', workspaceId: 'w' };
const claim: ExpenseClaimDto = {
  id: 'c1', claimant: { name: 'テスト太郎', employeeId: 'e1' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'in-approval', acknowledgements: [], history: [], items: [],
  submittedBy: 'u1', createdAt: 'x', updatedAt: '2026-09-10T00:00:00.000Z', totalAmount: 60000, reimbursableAmount: 60000, stale: false, approvalBlockers: [],
};
const summary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'in-approval', stale: false, itemCount: 1, totalAmount: 60000, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};

const multiStep: ExpenseApprovalFlowViewDto = {
  plan: { routeId: 'high', routeName: '高額', steps: [], unresolved: [] },
  flow: {
    routeId: 'high', routeName: '高額', resolvedAt: 'x', policyUpdatedAt: 'p', currentIndex: 1,
    steps: [
      { stepId: 'manager', name: '上長', approverKind: 'claimant-manager', approvers: [{ employeeId: 'e2', name: '鈴木' }], status: 'approved', decision: { by: 'u2', displayName: '佐藤', at: '2026-09-10', comment: '鈴木さん出張中のため', proxy: true } },
      { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'e3', name: '高橋' }, { employeeId: 'e4', name: '田中' }], status: 'pending' },
      { stepId: 'accounting', name: '経理', approverKind: 'any-approver', approvers: [], status: 'skipped' },
    ],
  },
  current: { index: 1, stepId: 'head', stepName: '部門長', approvers: [{ employeeId: 'e3', name: '高橋' }] },
  canAct: true, proxy: true, blockers: [],
};
const minimal: ExpenseApprovalFlowViewDto = {
  plan: { routeName: '承認', steps: [{ stepId: 'approve', name: '承認', approverKind: 'any-approver', approvers: [], skipped: false }], unresolved: [] },
  canAct: true, proxy: false, blockers: [],
};

function makeTransport(flow: () => Promise<ExpenseApprovalFlowViewDto>, awaiting: () => Promise<readonly ExpenseClaimSummaryDto[]>) {
  return vi.fn(async (path: string) => {
    if (path.startsWith('/expense/claims/c1/approval-flow?')) return flow();
    if (path.startsWith('/expense/claims?')) return { claims: await awaiting() };
    throw new Error(`unexpected ${path}`);
  });
}

function renderPanel(request: ReturnType<typeof makeTransport>, target: ExpenseClaimDto = claim) {
  const props = { transport: { request: request as unknown as ApiTransport['request'] }, scope, onOpen: vi.fn(), onClaimChanged: vi.fn(), onClaimsChanged: vi.fn() };
  const view = render(<div><input id="expense-approve-comment" aria-label="Comment (optional)" /><ApprovalFlowPanel {...props} claim={target} /></div>);
  return { rerender: (next: ExpenseClaimDto) => view.rerender(<div><input id="expense-approve-comment" aria-label="Comment (optional)" /><ApprovalFlowPanel {...props} claim={next} /></div>) };
}

describe('ApprovalFlowPanel', () => {
  it('正常: 経路名と段ごとの承認者・状態・誰がいつ・コメント・代理の印を表にし、あなたの承認待ちの件数を出す', async () => {
    const request = makeTransport(async () => multiStep, async () => [summary, { ...summary, id: 'c2' }]);
    renderPanel(request);
    const panel = await screen.findByRole('region', { name: 'Approval flow' });
    expect(within(panel).getByRole('heading', { name: 'Approval flow: 高額' })).toBeTruthy();
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('Approved')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(/佐藤 · 2026-09-10/)).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Proxy')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('鈴木さん出張中のため')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('高橋, 田中')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Waiting')).toBeTruthy();
    expect((rows[1] as HTMLElement).getAttribute('aria-current')).toBe('step');
    expect(within(rows[2] as HTMLElement).getByText('Anyone who can approve')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Skipped')).toBeTruthy();
    expect(within(panel).getByText('Approvers are fixed when the first step is approved. To change them, cancel the approval.')).toBeTruthy();
    expect(await within(panel).findByText('2 claims are waiting for your approval.')).toBeTruthy();
    const listCall = request.mock.calls.find(([path]) => String(path).startsWith('/expense/claims?'));
    expect(new URLSearchParams(String(listCall?.[0]).split('?')[1]).get('awaiting')).toBe('me');
  });

  it('正常: 代理承認になるときは、コメント欄に誰の代わりに・なぜを書くよう案内し、コメント欄へ移れる', async () => {
    renderPanel(makeTransport(async () => multiStep, async () => []));
    const note = await screen.findByRole('note', { name: 'Proxy approval' });
    expect(within(note).getByText('Write in the approval comment whom you approve for and why.')).toBeTruthy();
    await userEvent.click(within(note).getByRole('button', { name: 'Go to the approval comment' }));
    expect(document.activeElement?.id).toBe('expense-approve-comment');
  });

  it('境界: MVP と同じ 1 段・未承認なら表を出さず、承認待ちが 0 件なら「ありません」だけを出す', async () => {
    renderPanel(makeTransport(async () => minimal, async () => []));
    expect(await screen.findByText('No claims are waiting for your approval.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Approval flow' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('境界: 決まらない段は「決まっていません」とし、保存済みの流れが無ければ予定として並べる', async () => {
    const planned: ExpenseApprovalFlowViewDto = {
      plan: { routeId: 'high', routeName: '高額', steps: [{ stepId: 'manager', name: '上長', approverKind: 'claimant-manager', approvers: [], skipped: false }, { stepId: 'x', name: '確認', approverKind: 'employee', approvers: [], skipped: false }], unresolved: [{ stepId: 'manager', stepName: '上長', cause: 'manager-missing', params: {} }] },
      canAct: false, proxy: false, blockers: [],
    };
    renderPanel(makeTransport(async () => planned, () => Promise.reject(new Error('forbidden'))));
    const panel = await screen.findByRole('region', { name: 'Approval flow' });
    expect(within(panel).getByText('Not decided (see the reasons next to the Approve button)')).toBeTruthy();
    expect(within(panel).getAllByText('Planned')).toHaveLength(2);
    expect(within(panel).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('note')).toBeNull();
    expect(screen.queryByText(/waiting for your approval/)).toBeNull();
  });

  it('正常: 申請の更新日時・状態が変わったら読み直す', async () => {
    const request = makeTransport(async () => multiStep, async () => []);
    const { rerender } = renderPanel(request);
    await screen.findByRole('region', { name: 'Approval flow' });
    const flowCalls = () => request.mock.calls.filter(([path]) => String(path).includes('/approval-flow')).length;
    expect(flowCalls()).toBe(1);
    rerender({ ...claim, updatedAt: '2026-09-11T00:00:00.000Z' });
    await waitFor(() => expect(flowCalls()).toBe(2));
    rerender({ ...claim, updatedAt: '2026-09-11T00:00:00.000Z', status: 'approved' });
    await waitFor(() => expect(flowCalls()).toBe(3));
  });

  it('異常: 読めなければ原因と読み直すボタンを出す（赤くしない）', async () => {
    let fail = true;
    const request = makeTransport(async () => { if (fail) throw new Error('boom'); return multiStep; }, async () => []);
    renderPanel(request);
    expect(await screen.findByText(/Could not load the approval flow: boom/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading the approval flow' }));
    expect(await screen.findByRole('region', { name: 'Approval flow' })).toBeTruthy();
  });
});
