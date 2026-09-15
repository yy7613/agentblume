// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ApiTransport } from '../../api/business-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseEmployeeDto } from '../../api/expense-people-types';
import type { ExpenseApprovalSettingsDto, SaveExpensePolicyDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import type { ExpenseFocusRequest } from '../expense-shared';
import { ApprovalRoutesSection } from './ApprovalRoutesSection';
import { DEFAULT_APPROVAL_SETTINGS } from './people-model';

afterEach(cleanup);

const scope = { tenantId: 't', workspaceId: 'w' };
const category = (id: string, name: string) => ({
  id, name, enabled: true, sortOrder: 1, aliases: [], accountId: 'travel', defaultTaxRate: 10 as const, taxCodeByRate: {}, receipt: { required: false }, invoice: { required: false },
  requires: { purpose: false, attendees: false, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' as const },
});
const baseDraft: SaveExpensePolicyDto = {
  categories: [category('meal', '会議費'), { ...category('old', '旧費目'), enabled: false }],
  claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false }, preApprovalRules: [], severityOverrides: {},
  journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '' },
};
const taro: ExpenseEmployeeDto = {
  id: 'e1', code: 'E001', name: 'テスト太郎', departmentId: 'd1', loginSubjects: [], commuterPasses: [], enabled: true, history: [], createdAt: 'x', updatedAt: 'x', payoutReadiness: { problems: [], warnings: [] },
};
const organization = { organization: { departments: [{ id: 'd1', name: '営業部', enabled: true }], approverGroups: [{ id: 'g1', name: '経理', memberEmployeeIds: [], enabled: true }], updatedAt: 'x' }, saved: true };

function makeTransport(preview: (body: Record<string, unknown>) => unknown = () => { throw new Error('no preview'); }, references = true) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (!references && !path.startsWith('/expense/approval-routes/preview')) throw new Error('offline');
    if (path.startsWith('/expense/organization?')) return organization;
    if (path.startsWith('/expense/employees?')) return { employees: [taro] };
    if (path === '/expense/approval-routes/preview' && init?.method === 'POST') return { result: preview(JSON.parse(String(init.body)) as Record<string, unknown>) };
    throw new Error(`unexpected ${path}`);
  });
}

function renderSection(request: ReturnType<typeof makeTransport>, initial: SaveExpensePolicyDto = baseDraft, focus?: ExpenseFocusRequest) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(initial);
    return <ApprovalRoutesSection transport={{ request: request as unknown as ApiTransport['request'] }} scope={scope} onOpen={onOpen} draft={draft} saved chart={undefined} focus={focus} onChange={(next) => { onChange(next); setDraft(next); }} />;
  }
  render(<Harness />);
  const lastApproval = () => (onChange.mock.lastCall?.[0] as SaveExpensePolicyDto).approval as ExpenseApprovalSettingsDto;
  return { onChange, onOpen, lastApproval };
}

describe('ApprovalRoutesSection', () => {
  it('境界: 経路が無ければ既存の文言のまま赤くせず、経路の追加は既定の承認設定を補って onChange に渡す', async () => {
    const { onChange, lastApproval } = renderSection(makeTransport());
    expect(screen.getByText('No routes. Every claim has one approval step (anyone who can approve).')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/A route without conditions can only be placed last/)).toBeTruthy();
    expect(screen.getByText(/every step can be approved as a proxy approval \(a comment is required\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a route' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.lastCall?.[0] as SaveExpensePolicyDto).categories).toBe(baseDraft.categories);
    expect(lastApproval()).toEqual({
      ...DEFAULT_APPROVAL_SETTINGS,
      routes: [{ id: 'route-1', name: 'New route', enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [{ id: 'step-1', name: 'Approve', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }] }],
    });
  });

  it('正常: 条件・段・全体設定の編集が onChange に正しい approval を渡し、上下移動と削除ができる', async () => {
    const { lastApproval } = renderSection(makeTransport());
    await userEvent.click(screen.getByRole('button', { name: 'Add a route' }));
    const route = screen.getByRole('article', { name: 'New route' });
    await within(within(route).getByRole('group', { name: 'Route 1 departments' })).findByLabelText('営業部');

    await userEvent.selectOptions(within(route).getByLabelText('Route 1 step 1 approver'), 'department-head');
    await userEvent.selectOptions(within(route).getByLabelText('Route 1 step 1 department'), 'd1');
    await userEvent.click(within(route).getByRole('button', { name: 'Add a step to Route 1' }));
    await userEvent.clear(within(route).getByLabelText('Route 1 step 2 name'));
    await userEvent.type(within(route).getByLabelText('Route 1 step 2 name'), '経理');
    await userEvent.selectOptions(within(route).getByLabelText('Route 1 step 2 approver'), 'group');
    await userEvent.selectOptions(within(route).getByLabelText('Route 1 step 2 group'), 'g1');
    await userEvent.click(within(route).getByLabelText('Route 1 step 2 skip when the approvers are the same as the previous step'));
    // 無効な費目は条件の候補に出さない。
    const categories = within(route).getByRole('group', { name: 'Route 1 categories' });
    expect(within(categories).queryByLabelText('旧費目')).toBeNull();
    await userEvent.click(within(categories).getByLabelText('会議費'));
    await userEvent.type(within(route).getByLabelText('Route 1 minimum claim total'), '50000');
    await userEvent.click(within(within(route).getByRole('group', { name: 'Route 1 departments' })).getByLabelText('営業部'));
    await userEvent.click(screen.getByLabelText('Forbid the same person from approving consecutive steps'));
    await userEvent.selectOptions(screen.getByLabelText('Proxy approver group'), 'g1');

    expect(lastApproval()).toEqual({
      routes: [{
        id: 'route-1', name: 'New route', enabled: true, when: { categoryIds: ['meal'], departmentIds: ['d1'], minClaimAmount: 50000 },
        steps: [
          { id: 'step-1', name: 'Approve', approver: { kind: 'department-head', departmentId: 'd1' }, skipWhenSameAsPrevious: false },
          { id: 'step-2', name: '経理', approver: { kind: 'group', groupId: 'g1' }, skipWhenSameAsPrevious: true },
        ],
      }],
      defaultSteps: DEFAULT_APPROVAL_SETTINGS.defaultSteps, forbidClaimantApproval: true, requireDistinctApprovers: true, proxyGroupId: 'g1',
    });

    // 段の並べ替え・読めない金額はその場で直し方を出し、下書きに入れない。
    await userEvent.click(within(route).getByRole('button', { name: 'Move Route 1 step 2 up' }));
    expect(lastApproval().routes[0]?.steps.map((step) => step.id)).toEqual(['step-2', 'step-1']);
    const before = lastApproval();
    await userEvent.type(within(route).getByLabelText('Route 1 minimum claim total'), 'x');
    expect(within(route).getByText('Enter a whole number of yen (0 or more), or leave it empty.')).toBeTruthy();
    expect(lastApproval()).toEqual(before);

    // 条件なしの経路を上へ動かすと、下の経路が使われないことを知らせる。
    await userEvent.click(screen.getByRole('button', { name: 'Add a route' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move Route 2 up' }));
    expect(lastApproval().routes.map((entry) => entry.id)).toEqual(['route-2', 'route-1']);
    expect(within(screen.getByRole('note', { name: 'Check the approval routes' })).getByText(/has no conditions, so the routes below it are never used/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Route 1' }));
    expect(lastApproval().routes.map((entry) => entry.id)).toEqual(['route-1']);
    expect(screen.queryByRole('note', { name: 'Check the approval routes' })).toBeNull();

    // 既定の段も同じ部品で編集でき、最後の 1 段は消せない。
    expect((screen.getByRole('button', { name: 'Remove Default step 1' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Default step 1 approver'), 'employee');
    await userEvent.selectOptions(screen.getByLabelText('Default step 1 employee'), 'e1');
    expect(lastApproval().defaultSteps).toEqual([{ id: 'approve', name: '承認', approver: { kind: 'employee', employeeId: 'e1' }, skipWhenSameAsPrevious: false }]);
    await userEvent.selectOptions(screen.getByLabelText('Proxy approver group'), '');
    expect(lastApproval()).not.toHaveProperty('proxyGroupId');
  });

  it('正常: 試算は下書きの経路と入力を送り、当たった経路・段の承認者・決まらない段の原因と直す場所へのボタンを出す', async () => {
    const approval: ExpenseApprovalSettingsDto = {
      ...DEFAULT_APPROVAL_SETTINGS,
      routes: [{
        id: 'high', name: '高額', enabled: true, when: { categoryIds: [], departmentIds: [], minClaimAmount: 50000 },
        steps: [
          { id: 'manager', name: '上長', approver: { kind: 'claimant-manager' }, skipWhenSameAsPrevious: false },
          { id: 'head', name: '部門長', approver: { kind: 'department-head' }, skipWhenSameAsPrevious: false },
          { id: 'accounting', name: '経理', approver: { kind: 'group', groupId: 'g1' }, skipWhenSameAsPrevious: false },
          { id: 'final', name: '最終', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: true },
        ],
      }],
    };
    const preview = vi.fn(() => ({
      plan: {
        routeId: 'high', routeName: '高額',
        steps: [
          { stepId: 'manager', name: '上長', approverKind: 'claimant-manager', approvers: [], skipped: false },
          { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'e9', name: '部長' }], skipped: false },
          { stepId: 'accounting', name: '経理', approverKind: 'group', approvers: [], skipped: false },
          { stepId: 'final', name: '最終', approverKind: 'any-approver', approvers: [], skipped: true },
        ],
        unresolved: [
          { stepId: 'manager', stepName: '上長', cause: 'manager-missing', params: { claimant: 'テスト太郎' } },
          { stepId: 'accounting', stepName: '経理', cause: 'group-empty', params: { group: '経理' } },
        ],
      },
      firstStepId: 'manager',
    }));
    const { onOpen } = renderSection(makeTransport(preview), { ...baseDraft, approval });
    await screen.findByRole('option', { name: 'テスト太郎' });
    await userEvent.selectOptions(screen.getByLabelText('Claimant for the preview'), 'e1');
    expect((screen.getByLabelText('Department for the preview') as HTMLSelectElement).value).toBe('d1');
    await userEvent.click(within(screen.getByRole('group', { name: 'Categories for the preview' })).getByLabelText('会議費'));
    await userEvent.type(screen.getByLabelText('Claim total for the preview'), '60000');
    await userEvent.click(screen.getByRole('button', { name: 'Try the route' }));

    const result = await screen.findByRole('region', { name: 'Preview result' });
    expect(preview).toHaveBeenCalledWith({ scope, approval, policyCategoryIds: ['meal', 'old'], subject: { categoryIds: ['meal'], totalAmount: 60000, departmentId: 'd1', claimantEmployeeId: 'e1' } });
    expect(within(result).getByText('Route: 高額')).toBeTruthy();
    expect(within(result).getByText('部長')).toBeTruthy();
    expect(within(result).getByText('First step to approve')).toBeTruthy();
    expect(within(result).getAllByText('Not decided')).toHaveLength(2);
    expect(within(result).getByText('Skipped (same approvers as the previous step)')).toBeTruthy();
    expect(within(result).getByText('Cause: テスト太郎 has no manager set')).toBeTruthy();
    expect(within(result).getByText('Next step: Set the manager in the employee master')).toBeTruthy();
    await userEvent.click(within(result).getByRole('button', { name: 'Open the employee' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: 'e1', section: 'employee' });
    await userEvent.click(within(result).getByRole('button', { name: 'Open the organization' }));
    expect(onOpen).toHaveBeenLastCalledWith({ internalId: 'g1', section: 'organization' });
  });

  it('正常: どの経路にも当たらなければ既定の段を使うと言う', async () => {
    const preview = () => ({ plan: { routeName: '承認', steps: [{ stepId: 'approve', name: '承認', approverKind: 'any-approver', approvers: [], skipped: false }], unresolved: [] } });
    renderSection(makeTransport(preview));
    await userEvent.click(screen.getByRole('button', { name: 'Try the route' }));
    const result = await screen.findByRole('region', { name: 'Preview result' });
    expect(within(result).getByText('No route matched, so the default steps are used (承認)')).toBeTruthy();
    expect(within(result).getByText('Anyone who can approve')).toBeTruthy();
  });

  it('異常: 試算の 400 は原因と、経路の設定を直す次の一手を出す', async () => {
    renderSection(makeTransport(() => { throw new ApiError(400, 'EXPENSE_DOMAIN', 'a route without conditions must be last', undefined, { details: { field: 'approval.routes.0.when' } }); }));
    await userEvent.click(screen.getByRole('button', { name: 'Try the route' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Next step: fix the route settings above/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Preview result' })).toBeNull();
  });

  it('正常: 導線（approval + 経路 id）で開かれたら、その経路を強調する', async () => {
    const approval: ExpenseApprovalSettingsDto = { ...DEFAULT_APPROVAL_SETTINGS, routes: [{ id: 'high', name: '高額', enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [{ id: 's', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }] }] };
    renderSection(makeTransport(), { ...baseDraft, approval }, { tab: 'policy', section: 'approval', id: 'high', seq: 1 });
    await waitFor(() => expect(screen.getByRole('article', { name: '高額' }).className).toContain('expense-people-highlight'));
  });

  it('異常: 組織・従業員を読めなければ id の手入力に倒し、部門の条件は組織への導線を出す', async () => {
    const { onOpen, lastApproval } = renderSection(makeTransport(undefined, false));
    expect(await screen.findByText(/Could not load the organization and employees, so enter ids by hand/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a route' }));
    await userEvent.selectOptions(screen.getByLabelText('Route 1 step 1 approver'), 'group');
    fireEvent.change(screen.getByLabelText('Route 1 step 1 group id'), { target: { value: ' g9 ' } });
    expect(lastApproval().routes[0]?.steps[0]?.approver).toEqual({ kind: 'group', groupId: 'g9' });
    await userEvent.selectOptions(screen.getByLabelText('Route 1 step 1 approver'), 'department-head');
    fireEvent.change(screen.getByLabelText('Route 1 step 1 department id'), { target: { value: 'd7' } });
    expect(lastApproval().routes[0]?.steps[0]?.approver).toEqual({ kind: 'department-head', departmentId: 'd7' });
    fireEvent.change(screen.getByLabelText('Route 1 step 1 department id'), { target: { value: '' } });
    expect(lastApproval().routes[0]?.steps[0]?.approver).toEqual({ kind: 'department-head' });
    await userEvent.selectOptions(screen.getByLabelText('Route 1 step 1 approver'), 'employee');
    fireEvent.change(screen.getByLabelText('Route 1 step 1 employee id'), { target: { value: 'e5' } });
    expect(lastApproval().routes[0]?.steps[0]?.approver).toEqual({ kind: 'employee', employeeId: 'e5' });
    fireEvent.change(screen.getByLabelText('Proxy approver group'), { target: { value: 'g2' } });
    expect(lastApproval().proxyGroupId).toBe('g2');
    await userEvent.click(within(screen.getByRole('group', { name: 'Route 1 departments' })).getByRole('button', { name: 'Open the organization' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: '', section: 'organization' });
  });
});
