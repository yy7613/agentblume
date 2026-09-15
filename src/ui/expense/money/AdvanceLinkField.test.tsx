// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseAdvanceDto } from '../../api/expense-money-types';
import type { ExpenseClaimDto } from '../../api/expense-types';
import type { ExpenseClaimAdvanceFieldSlotProps } from '../expense-slots';
import { AdvanceLinkField } from './AdvanceLinkField';
import { fakeTransport, testScope, transitionError, type FakeHandler, type FakeTransport } from './money-test-helpers';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const paid: ExpenseAdvanceDto = {
  id: 'adv1', employeeId: 'e1', employeeSnapshot: { name: '山田 太郎' }, purpose: '大阪出張', amount: 50000, neededOn: '2026-09-01', plannedSettleBy: '2026-09-30', status: 'paid',
  payment: { paidOn: '2026-09-02', method: 'transfer', by: 'u1', at: 'x' }, submittedBy: 'u1', history: [], createdAt: 'x', updatedAt: 'x', linkedClaimCount: 0, linkedClaimTotal: 0, overdue: false,
};

function makeClaim(overrides: Partial<ExpenseClaimDto> = {}): ExpenseClaimDto {
  return { id: 'c1', claimant: { name: '山田 太郎', employeeId: 'e1' }, period: { from: '2026-09-01', to: '2026-09-30' }, items: [], status: 'checked', ...overrides } as unknown as ExpenseClaimDto;
}

function server(advances: readonly ExpenseAdvanceDto[], overrides: Readonly<Record<string, FakeHandler>> = {}): FakeTransport {
  return fakeTransport({
    'GET /expense/advances': () => ({ advances }),
    'GET /expense/advances/:id': ({ params }) => ({ advance: { ...paid, id: params[0] }, claims: [] }),
    'PUT /expense/claims/:id/advance': ({ body }) => ({ claim: makeClaim({ status: 'draft', ...(body['advanceId'] === null ? {} : { advanceId: String(body['advanceId']) }) }) }),
    ...overrides,
  });
}

function renderField(transport: FakeTransport, overrides: Partial<ExpenseClaimAdvanceFieldSlotProps> = {}) {
  const props: ExpenseClaimAdvanceFieldSlotProps = { transport, scope: testScope, onOpen: vi.fn(), claim: makeClaim(), editable: true, onClaimChanged: vi.fn(), focused: false, ...overrides };
  render(<AdvanceLinkField {...props} />);
  return props;
}

describe('AdvanceLinkField', () => {
  it('正常: 申請者の支払済みの仮払から選んで紐付け、再チェックが要ることを出す', async () => {
    const transport = server([paid, { ...paid, id: 'adv2', purpose: '福岡出張', amount: 30000 }]);
    const props = renderField(transport);
    const select = await screen.findByLabelText('Paid advance') as HTMLSelectElement;
    const listQuery = transport.callsTo('GET', '/expense/advances')[0]?.query;
    expect(listQuery?.get('status')).toBe('paid');
    expect(listQuery?.get('employeeId')).toBe('e1');
    expect(select.value).toBe('adv1');
    expect(screen.getByText(/run the check again afterwards/u)).toBeTruthy();
    await userEvent.selectOptions(select, 'adv2');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByText('Linked the advance. Run the check again.')).toBeTruthy();
    expect(transport.callsTo('PUT', '/expense/claims/c1/advance')[0]?.body).toMatchObject({ advanceId: 'adv2' });
    expect(props.onClaimChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', advanceId: 'adv2', status: 'draft' }));
  });

  it('正常: 紐付け中は仮払の内容と「外す」を出し、外すと null を送る', async () => {
    const transport = server([]);
    const props = renderField(transport, { claim: makeClaim({ advanceId: 'adv1' }) });
    expect(await screen.findByText('大阪出張 · ¥50,000 · 2026-09-02')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the advance' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'adv1', section: 'advance' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed the advance. Run the check again.')).toBeTruthy();
    expect(transport.callsTo('PUT', '/expense/claims/c1/advance')[0]?.body).toMatchObject({ advanceId: null });
    expect(props.onClaimChanged).toHaveBeenCalledWith(expect.not.objectContaining({ advanceId: expect.anything() }));
  });

  it('正常: 候補が無ければ赤くせず仮払台帳への導線を出す', async () => {
    const props = renderField(server([]));
    expect(await screen.findByText('This claimant has no paid advances.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open the advance ledger' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: '', section: 'advance' });
  });

  it('正常: 申請者が従業員マスタに結ばれていなければ、選ぶよう案内し一覧を読まない', async () => {
    const transport = server([paid]);
    renderField(transport, { claim: makeClaim({ claimant: { name: '山田 太郎' } }) });
    expect(screen.getByText('Choose the claimant from the employee master to link an advance.')).toBeTruthy();
    await waitFor(() => expect(transport.calls).toHaveLength(0));
  });

  it('正常: 編集できない申請は表示だけ（外す・候補を出さない）、導線で開かれたら印を付ける', async () => {
    const transport = server([paid]);
    renderField(transport, { editable: false, focused: true });
    const group = screen.getByRole('group', { name: 'Advance link' });
    expect(group.className).toContain('expense-money-link-focused');
    expect(within(group).getByText('No advance is linked.')).toBeTruthy();
    cleanup();
    renderField(server([paid]), { editable: false, claim: makeClaim({ advanceId: 'adv1' }) });
    expect(await screen.findByText('大阪出張 · ¥50,000 · 2026-09-02')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('異常: 紐付けの 409 は次の一手と、従業員・仮払への導線を出す', async () => {
    const transport = server([paid], {
      'PUT /expense/claims/:id/advance': () => { throw transitionError('この申請者の支払済みの仮払を選んでください', [{ code: 'advance-employee-mismatch', params: { advanceId: 'adv1', advanceEmployee: '佐藤 花子', employeeId: 'e2' } }]); },
    });
    const props = renderField(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Link' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('この申請者の支払済みの仮払を選んでください')).toBeTruthy();
    expect(within(alert).getByText('The claimant is not the employee of the advance (佐藤 花子).')).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the employee' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'e2', section: 'employee' });
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the advance' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'adv1', section: 'advance' });
    expect(props.onClaimChanged).not.toHaveBeenCalled();
  });

  it('異常: 候補の読み込みに失敗したら文言を出し、紐付け中の仮払が読めなければ id を出す', async () => {
    renderField(server([], {
      'GET /expense/advances': () => { throw new Error('advances down'); },
      'GET /expense/advances/:id': () => { throw new Error('gone'); },
    }), { claim: makeClaim({ advanceId: 'adv-old' }) });
    expect(await screen.findByText('advances down')).toBeTruthy();
    expect(screen.getByText(/adv-old/u)).toBeTruthy();
  });
});
