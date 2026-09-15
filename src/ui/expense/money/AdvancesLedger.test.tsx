// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseAdvanceDto, ExpenseAdvanceSettlementPreviewDto } from '../../api/expense-money-types';
import type { ExpenseClaimSummaryDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import { NavigationProvider, consumePendingOpen } from '../../navigation';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import { AdvancesLedger, advanceDifference } from './AdvancesLedger';
import { fakeTransport, ledgerProps, transitionError, type FakeHandler, type FakeTransport } from './money-test-helpers';
import { todayIso } from './money-shared';

afterEach(() => { cleanup(); consumePendingOpen('Journal'); vi.restoreAllMocks(); });

const AT = '2026-09-02T09:00:00.000Z';

function makeAdvance(overrides: Partial<ExpenseAdvanceDto> = {}): ExpenseAdvanceDto {
  return {
    id: 'adv1', employeeId: 'e1', employeeSnapshot: { name: '山田 太郎' }, purpose: '大阪出張', amount: 50000, neededOn: '2026-09-01', plannedSettleBy: '2026-09-30',
    status: 'requested', submittedBy: 'u1', history: [{ type: 'requested', by: 'u1', at: '2026-09-01T09:00:00.000Z' }],
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z', linkedClaimCount: 0, linkedClaimTotal: 0, overdue: false,
    ...overrides,
  };
}

const claimSummary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎', employeeId: 'e1' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'approved', stale: false, itemCount: 2, totalAmount: 42000,
  corporatePaymentAmount: 0, reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'complete', topReasons: [], submittedBy: 'u1', createdAt: AT, updatedAt: AT, advanceId: 'adv1',
};

function preview(difference: number, overrides: Partial<ExpenseAdvanceSettlementPreviewDto> = {}): ExpenseAdvanceSettlementPreviewDto {
  return {
    claims: [{ id: 'c1', status: 'approved', reimbursableAmount: 50000 + difference, employeeId: 'e1', claimantName: '山田 太郎' }],
    claimsTotal: 50000 + difference, difference, direction: difference > 0 ? 'additional' : difference < 0 ? 'refund' : 'even', blockers: [],
    ...overrides,
  };
}

/** 状態を持つ偽のサーバー（操作で仮払の状態を進める）。 */
function advanceServer(initial: readonly ExpenseAdvanceDto[], options: { readonly preview?: ExpenseAdvanceSettlementPreviewDto; readonly claims?: readonly ExpenseClaimSummaryDto[]; readonly overrides?: Readonly<Record<string, FakeHandler>> } = {}): FakeTransport {
  const store = new Map(initial.map((entry) => [entry.id, entry]));
  const current = (id: string | undefined): ExpenseAdvanceDto => {
    const found = store.get(id ?? '');
    if (found === undefined) throw new ApiError(404, 'EXPENSE_ADVANCE_NOT_FOUND', 'not found');
    return found;
  };
  const set = (id: string | undefined, patch: Partial<ExpenseAdvanceDto>) => {
    const next = { ...current(id), ...patch };
    store.set(next.id, next);
    return { advance: next };
  };
  const settlementPreview = options.preview ?? preview(0);
  return fakeTransport({
    'GET /expense/employees': () => ({ employees: [{ id: 'e1', name: '山田 太郎' }, { id: 'e2', name: '佐藤 花子', departmentName: '営業部' }] }),
    'GET /expense/advances': ({ query }) => ({ advances: [...store.values()].filter((entry) => query.get('status') === null || entry.status === query.get('status')) }),
    'POST /expense/advances': ({ body }) => {
      const created = makeAdvance({ id: 'adv-new', employeeId: String(body['employeeId']), purpose: String(body['purpose']), amount: Number(body['amount']), neededOn: String(body['neededOn']), plannedSettleBy: String(body['plannedSettleBy']) });
      store.set(created.id, created);
      return { advance: created };
    },
    'GET /expense/advances/:id': ({ params }) => ({ advance: current(params[0]), claims: options.claims ?? [] }),
    'PUT /expense/advances/:id': ({ params, body }) => set(params[0], { purpose: String(body['purpose']), amount: Number(body['amount']), neededOn: String(body['neededOn']), plannedSettleBy: String(body['plannedSettleBy']) }),
    'POST /expense/advances/:id/approve': ({ params, body }) => set(params[0], { status: 'approved', approval: { by: 'boss', at: AT, proxy: false, ...(typeof body['comment'] === 'string' ? { comment: body['comment'] } : {}) } }),
    'POST /expense/advances/:id/cancel': ({ params, body }) => set(params[0], { status: 'cancelled', cancel: { by: 'u1', at: AT, note: String(body['note']) } }),
    'POST /expense/advances/:id/mark-paid': ({ params, body }) => set(params[0], { status: 'paid', payment: { paidOn: String(body['paidOn']), method: body['method'] === 'cash' ? 'cash' : 'transfer', by: 'u1', at: AT } }),
    'POST /expense/advances/:id/unpay': ({ params }) => set(params[0], { status: 'approved' }),
    'GET /expense/advances/:id/settlement-preview': () => ({ preview: settlementPreview }),
    'POST /expense/advances/:id/settle': ({ params }) => {
      const { difference, claimsTotal } = settlementPreview;
      const result = set(params[0], {
        status: difference === 0 ? 'settled' : 'settling',
        settlement: {
          computedAt: AT, claimIds: ['c1'], claimsTotal, difference,
          ...(difference < 0 ? { refund: { amount: -difference } } : difference > 0 ? { additionalPayment: { amount: difference, status: 'pending' as const } } : { settledOn: '2026-09-20' }),
        },
      });
      return { ...result, claims: [] };
    },
    'POST /expense/advances/:id/refund-received': ({ params, body }) => {
      const settlement = current(params[0]).settlement;
      return set(params[0], { status: 'settled', ...(settlement === undefined ? {} : { settlement: { ...settlement, refund: { amount: settlement.refund?.amount ?? 0, receivedOn: String(body['receivedOn']) }, settledOn: String(body['receivedOn']) } }) });
    },
    'POST /expense/advances/:id/additional-paid': ({ params, body }) => {
      const settlement = current(params[0]).settlement;
      return set(params[0], { status: 'settled', ...(settlement === undefined ? {} : { settlement: { ...settlement, additionalPayment: { amount: settlement.additionalPayment?.amount ?? 0, status: 'paid', paidOn: String(body['paidOn']) }, settledOn: String(body['paidOn']) } }) });
    },
    'POST /expense/advances/:id/journal-drafts': ({ params, body }) => {
      const payment = body['stage'] === 'payment';
      const result = set(params[0], { journalLink: { ...current(params[0]).journalLink, ...(payment ? { paymentEntryId: 'je1' } : { settlementEntryId: 'je2' }), warnings: [] } });
      return { ...result, entryIds: [payment ? 'je1' : 'je2'], warnings: ['摘要を短くしました'] };
    },
    ...options.overrides,
  });
}

function renderLedger(transport: FakeTransport, overrides: Partial<ExpenseLedgerSlotProps> = {}) {
  const props = ledgerProps(transport, overrides);
  const navigate = vi.fn();
  render(<NavigationProvider navigate={navigate}><AdvancesLedger {...props} /></NavigationProvider>);
  return { props, navigate };
}

async function openAdvance(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('AdvancesLedger', () => {
  it('正常: 仮払が無ければ赤くせず「仮払を申請」を出し、申請 → 承認 → 支払済み → 精算（返金）→ 返金を受領 → 精算の仕訳下書きまで進める', async () => {
    const transport = advanceServer([], { preview: preview(-8000) });
    const { props, navigate } = renderLedger(transport);
    expect(await screen.findByText('There are no advances.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: 'Request an advance' })[1]!);
    const form = screen.getByRole('form', { name: 'Request an advance' });
    await userEvent.type(within(form).getByLabelText('Employee ID'), 'e2');
    expect(within(form).getAllByText(/佐藤 花子/).length).toBeGreaterThan(0);
    await userEvent.type(within(form).getByLabelText('Purpose'), '大阪出張');
    await userEvent.type(within(form).getByLabelText('Amount (yen)'), '50,000');
    fireEvent.change(within(form).getByLabelText('Planned settlement date'), { target: { value: '2099-12-31' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Submit the request' }));
    expect(transport.callsTo('POST', '/expense/advances')[0]?.body).toMatchObject({ employeeId: 'e2', purpose: '大阪出張', amount: 50000, neededOn: todayIso(), plannedSettleBy: '2099-12-31' });
    expect(await screen.findByText(/Requested an advance of ¥50,000/)).toBeTruthy();

    const detail = await screen.findByRole('region', { name: 'Advance: 山田 太郎 · 大阪出張' });
    await userEvent.click(within(detail).getByRole('button', { name: 'Approve' }));
    const approve = within(detail).getByRole('form', { name: 'Approve the advance' });
    await userEvent.type(within(approve).getByLabelText('Comment (optional)'), '予算内');
    await userEvent.click(within(approve).getByRole('button', { name: 'Approve this advance' }));
    expect(transport.callsTo('POST', '/expense/advances/adv-new/approve')[0]?.body).toMatchObject({ comment: '予算内' });
    expect(await within(detail).findByText('Approved the advance.')).toBeTruthy();
    expect(props.onClaimsChanged).toHaveBeenCalled();

    await userEvent.click(within(detail).getByRole('button', { name: 'Mark as paid' }));
    const pay = within(detail).getByRole('form', { name: 'Mark as paid' });
    await userEvent.selectOptions(within(pay).getByLabelText('Method'), 'cash');
    await userEvent.click(within(pay).getByRole('button', { name: 'Mark as paid' }));
    expect(transport.callsTo('POST', '/expense/advances/adv-new/mark-paid')[0]?.body).toMatchObject({ paidOn: todayIso(), method: 'cash' });
    expect(await within(detail).findByText('Marked the advance as paid.')).toBeTruthy();

    await userEvent.click(within(detail).getByRole('button', { name: 'Calculate the settlement' }));
    const previewCard = await within(detail).findByRole('region', { name: 'Settlement preview' });
    expect(within(previewCard).getByText('Refund of ¥8,000 from the employee')).toBeTruthy();
    expect(within(previewCard).getByText(/difference −¥8,000/)).toBeTruthy();
    await userEvent.click(within(previewCard).getByRole('button', { name: 'Settle' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Refund of ¥8,000 from the employee')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Settle' }));
    expect(await within(detail).findByText('Settled the advance. The linked claims are settled.')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/advances/adv-new/settle')).toHaveLength(1);

    await userEvent.click(within(detail).getByRole('button', { name: 'Refund received' }));
    const refund = within(detail).getByRole('form', { name: 'Refund received' });
    fireEvent.change(within(refund).getByLabelText('Received on'), { target: { value: '2026-09-25' } });
    await userEvent.click(within(refund).getByRole('button', { name: 'Record the refund' }));
    expect(transport.callsTo('POST', '/expense/advances/adv-new/refund-received')[0]?.body).toMatchObject({ receivedOn: '2026-09-25' });
    expect(await within(detail).findByText('Recorded the refund. The advance is settled.')).toBeTruthy();

    await userEvent.click(within(detail).getByRole('button', { name: 'Create the settlement journal draft' }));
    expect(await within(detail).findByText('Created 1 journal draft(s).')).toBeTruthy();
    expect(within(detail).getByText('摘要を短くしました')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Create the settlement journal draft' })).toBeNull();
    await userEvent.click(within(detail).getByRole('button', { name: 'Confirm them in the journal screen' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'je2', section: 'entry' });
  });

  it.each([
    [3000, 'Additional payment of ¥3,000 to the employee', /difference \+¥3,000/],
    [0, 'No difference. The advance is settled as it is.', /difference ¥0/],
    [-1200, 'Refund of ¥1,200 from the employee', /difference −¥1,200/],
  ])('正常: 精算の事前計算は差額 %i の向きと符号を出す', async (difference, direction, differenceText) => {
    renderLedger(advanceServer([makeAdvance({ status: 'paid' })], { preview: preview(difference) }));
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    await userEvent.click(await screen.findByRole('button', { name: 'Calculate the settlement' }));
    const card = await screen.findByRole('region', { name: 'Settlement preview' });
    expect(within(card).getByText(direction)).toBeTruthy();
    expect(within(card).getByText(differenceText)).toBeTruthy();
    expect((within(card).getByRole('button', { name: 'Settle' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('正常: 追加支給の精算は「追加支給を支払済み」で支払日と方法を送る', async () => {
    const transport = advanceServer([makeAdvance({ status: 'paid' })], { preview: preview(3000) });
    renderLedger(transport);
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    await userEvent.click(await screen.findByRole('button', { name: 'Calculate the settlement' }));
    await userEvent.click(within(await screen.findByRole('region', { name: 'Settlement preview' })).getByRole('button', { name: 'Settle' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Settle' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Additional payment paid' }));
    const form = screen.getByRole('form', { name: 'Additional payment paid' });
    fireEvent.change(within(form).getByLabelText('Paid on'), { target: { value: '2026-09-28' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Additional payment paid' }));
    expect(transport.callsTo('POST', '/expense/advances/adv1/additional-paid')[0]?.body).toMatchObject({ paidOn: '2026-09-28', method: 'transfer' });
    expect(await screen.findByText('Recorded the additional payment. The advance is settled.')).toBeTruthy();
  });

  it('異常: 精算できない理由があれば「精算する」を押せず、理由ごとに直す場所を開ける（いま見ている仮払は出さない）', async () => {
    const blocked = preview(0, { blockers: [{ code: 'advance-employee-mismatch', params: { claimId: 'c2', advanceId: 'adv1' } }, { code: 'advance-claim-not-approved', params: { claimId: 'c3', status: 'draft' } }] });
    const { props } = renderLedger(advanceServer([makeAdvance({ status: 'paid' })], { preview: blocked }));
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    await userEvent.click(await screen.findByRole('button', { name: 'Calculate the settlement' }));
    const card = await screen.findByRole('region', { name: 'Settlement preview' });
    expect(within(card).getByText('It cannot be settled yet')).toBeTruthy();
    expect(within(card).getByText('The claimant is not the employee of the advance.')).toBeTruthy();
    expect(within(card).getByText('Claim c3 is not approved yet.')).toBeTruthy();
    expect((within(card).getByRole('button', { name: 'Settle' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).queryByRole('button', { name: 'Open the advance' })).toBeNull();
    await userEvent.click(within(card).getAllByRole('button', { name: 'Open the claim' })[0]!);
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'c2', section: 'claim' });
    await userEvent.click(within(card).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Settlement preview' })).toBeNull();
  });

  it('異常: 支払取消は理由が無いと送れず、409 は次の一手と止める理由の導線（申請・仕訳下書き）を出す', async () => {
    const unpay = vi.fn(() => { throw transitionError('紐付いた申請の紐付けを外してから支払取消してください', [
      { code: 'advance-has-claims', params: { advanceId: 'adv1', count: 1, claimIds: 'c1' } },
      { code: 'advance-journal-drafted', params: { advanceId: 'adv1', entryId: 'je9' } },
      { code: 'advance-claim-not-approved', params: { claimId: 'c1', status: 'draft' } },
    ]); });
    const transport = advanceServer([makeAdvance({ status: 'paid', payment: { paidOn: '2026-09-02', method: 'transfer', by: 'u1', at: AT }, journalLink: { paymentEntryId: 'je9', warnings: [] } })], { overrides: { 'POST /expense/advances/:id/unpay': unpay } });
    const { props, navigate } = renderLedger(transport);
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    const detail = await screen.findByRole('region', { name: 'Advance: 山田 太郎 · 大阪出張' });
    expect(within(detail).queryByRole('button', { name: 'Create the payment journal draft' })).toBeNull();
    await userEvent.click(within(detail).getByRole('button', { name: 'Undo the payment' }));
    const form = within(detail).getByRole('form', { name: 'Reason for undoing the payment' });
    const submit = within(form).getByRole('button', { name: 'Undo the payment' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(within(form).getByText('A reason is required.')).toBeTruthy();
    await userEvent.type(within(form).getByLabelText('Reason for undoing the payment'), '二重に登録した');
    await userEvent.click(submit);
    expect(unpay).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ note: '二重に登録した' }) }));

    const alert = await within(detail).findByRole('alert');
    expect(within(alert).getByText('紐付いた申請の紐付けを外してから支払取消してください')).toBeTruthy();
    expect(within(alert).getByText('Claims are linked to this advance (c1).')).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'Open the advance' })).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the claim' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'c1', section: 'claim' });
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the journal draft' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'je9', section: 'entry' });
  });

  it('異常: 仕訳下書きの 409 は問題の文言を並べ、精算出力・科目マスタ・仕訳設定への導線を出す', async () => {
    const problems = [
      { code: 'advance-claim-journal-missing', fixTarget: 'item', message: '紐付く申請 c1 の明細の仕訳下書きを先に作ってください' },
      { code: 'account-rejected', fixTarget: 'journal-chart', accountId: 'asset.suspense_paid', message: '科目「仮払金」が無効です' },
      { code: 'journal-unavailable', fixTarget: 'policy-journal', message: '仕訳連携が使えない構成です' },
      { code: 'category', fixTarget: 'policy-category', categoryId: 'travel', message: '費目の科目がありません' },
    ];
    const settled = makeAdvance({ status: 'settled', journalLink: { paymentEntryId: 'je1', warnings: [] }, settlement: { computedAt: AT, claimIds: ['c1'], claimsTotal: 50000, difference: 0, settledOn: '2026-09-20' } });
    const transport = advanceServer([settled], { overrides: { 'POST /expense/advances/:id/journal-drafts': () => { throw new ApiError(409, 'EXPENSE_JOURNAL_LINK', 'link failed', undefined, { details: { problems, createdEntryIds: [] } }); } } });
    const { props, navigate } = renderLedger(transport);
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    await userEvent.click(await screen.findByRole('button', { name: 'Create the settlement journal draft' }));
    const alert = await screen.findByRole('alert');
    for (const problem of problems) expect(within(alert).getByText(problem.message)).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Open Settle' }));
    expect(props.onTab).toHaveBeenCalledWith('settle');
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the journal settings' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: '', section: 'journal' });
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the policy category' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'travel', section: 'category' });
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the journal chart of accounts' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'asset.suspense_paid', section: 'account' });
    // 作成済みの支払の仕訳は仕訳画面で開ける。
    await userEvent.click(screen.getByRole('button', { name: 'je1' }));
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'je1', section: 'entry' });
  });

  it('正常: 導線 advance は該当の仮払を選んで強調し、期限切れ・紐付く申請・差額を出し、申請を開ける', async () => {
    const overdue = makeAdvance({ id: 'adv2', employeeSnapshot: { name: '佐藤 花子' }, purpose: '福岡出張', status: 'paid', overdue: true, linkedClaimCount: 2, linkedClaimTotal: 60000, department: '営業部' });
    const transport = advanceServer([makeAdvance(), overdue], { claims: [claimSummary] });
    const { props } = renderLedger(transport, { focus: { tab: 'advances', section: 'advance', id: 'adv2', seq: 1 } });
    const detail = await screen.findByRole('region', { name: 'Advance: 佐藤 花子 · 福岡出張' });
    const row = screen.getByRole('button', { name: 'Open the advance of 佐藤 花子: 福岡出張' }).closest('tr');
    expect(row?.className).toContain('expense-focused');
    expect(within(row as HTMLElement).getByText('Overdue')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('+¥10,000')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('2 · ¥60,000')).toBeTruthy();
    await userEvent.click(within(detail).getByRole('button', { name: 'Open the claim' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'c1', section: 'claim' });

    await userEvent.click(within(detail).getByRole('button', { name: 'Create the payment journal draft' }));
    expect(await within(detail).findByText('Created 1 journal draft(s).')).toBeTruthy();
    await userEvent.click(within(detail).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Advance: 佐藤 花子 · 福岡出張' })).toBeNull();
  });

  it('正常: 状態で絞り込み、該当が無ければ「すべての状態を表示」で戻せる', async () => {
    const transport = advanceServer([makeAdvance()]);
    renderLedger(transport);
    expect(await screen.findByText('大阪出張')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'cancelled');
    expect(await screen.findByText('There are no advances in this status.')).toBeTruthy();
    expect(transport.calls.some((call) => call.path === '/expense/advances' && call.query.get('status') === 'cancelled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Show all statuses' }));
    expect(await screen.findByText('大阪出張')).toBeTruthy();
  });

  it('正常: 申請中は編集と取消（理由必須）ができる', async () => {
    const transport = advanceServer([makeAdvance()]);
    renderLedger(transport);
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    const detail = await screen.findByRole('region', { name: 'Advance: 山田 太郎 · 大阪出張' });
    await userEvent.click(within(detail).getByRole('button', { name: 'Edit' }));
    const edit = within(detail).getByRole('form', { name: 'Edit the advance' });
    expect(within(edit).queryByLabelText('Employee ID')).toBeNull();
    await userEvent.clear(within(edit).getByLabelText('Amount (yen)'));
    await userEvent.type(within(edit).getByLabelText('Amount (yen)'), '60000');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    expect(transport.callsTo('PUT', '/expense/advances/adv1')[0]?.body).toMatchObject({ purpose: '大阪出張', amount: 60000, neededOn: '2026-09-01', plannedSettleBy: '2026-09-30' });
    expect(await within(detail).findByText('Saved the advance.')).toBeTruthy();

    await userEvent.click(within(detail).getByRole('button', { name: 'Cancel the advance' }));
    const cancel = within(detail).getByRole('form', { name: 'Reason for cancelling' });
    await userEvent.type(within(cancel).getByLabelText('Reason for cancelling'), '出張が中止になった');
    await userEvent.click(within(cancel).getByRole('button', { name: 'Cancel the advance' }));
    expect(transport.callsTo('POST', '/expense/advances/adv1/cancel')[0]?.body).toMatchObject({ note: '出張が中止になった' });
    expect(await within(detail).findByText('Cancelled the advance.')).toBeTruthy();
    expect(within(detail).getByText(/出張が中止になった/)).toBeTruthy();
  });

  it('境界: 申請フォームは必須・金額の範囲・精算予定日の前後を送る前に確かめる', async () => {
    const transport = advanceServer([]);
    renderLedger(transport);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Request an advance' }))[0]!);
    const form = screen.getByRole('form', { name: 'Request an advance' });
    await userEvent.click(within(form).getByRole('button', { name: 'Submit the request' }));
    expect(within(form).getByText('Choose the employee who receives the advance.')).toBeTruthy();
    expect(within(form).getByText('Enter the purpose.')).toBeTruthy();
    expect(within(form).getByText('Enter a whole yen amount from 1 to 10,000,000.')).toBeTruthy();
    expect(within(form).getByText('Enter the planned settlement date.')).toBeTruthy();

    await userEvent.type(within(form).getByLabelText('Employee ID'), 'e1');
    await userEvent.type(within(form).getByLabelText('Purpose'), '研修');
    await userEvent.type(within(form).getByLabelText('Amount (yen)'), '10000001');
    fireEvent.change(within(form).getByLabelText('Needed on'), { target: { value: '2026-09-10' } });
    fireEvent.change(within(form).getByLabelText('Planned settlement date'), { target: { value: '2026-09-01' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Submit the request' }));
    expect(within(form).getByText('Enter a whole yen amount from 1 to 10,000,000.')).toBeTruthy();
    expect(within(form).getByText('The planned settlement date must not be before the needed date.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Needed on'), { target: { value: '' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Submit the request' }));
    expect(within(form).getByText('Enter the date the money is needed.')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/advances')).toHaveLength(0);
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Request an advance' })).toBeNull();
  });

  it('異常: 従業員の一覧が読めなければ赤くせず id の手入力に倒し、保存の 400 は原因の詳細を出す', async () => {
    const transport = advanceServer([], { overrides: {
      'GET /expense/employees': () => { throw new ApiError(403, 'FORBIDDEN', 'forbidden'); },
      'POST /expense/advances': () => { throw new ApiError(400, 'EXPENSE_DOMAIN', 'expense advance: employee e9 is disabled', undefined, { details: { field: 'employeeId' } }); },
    } });
    renderLedger(transport);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Request an advance' }))[0]!);
    const form = screen.getByRole('form', { name: 'Request an advance' });
    expect(await within(form).findByText(/The employee list could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.type(within(form).getByLabelText('Employee ID'), 'e9');
    await userEvent.type(within(form).getByLabelText('Purpose'), '研修');
    await userEvent.type(within(form).getByLabelText('Amount (yen)'), '1000');
    fireEvent.change(within(form).getByLabelText('Planned settlement date'), { target: { value: '2099-01-01' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Submit the request' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('expense advance: employee e9 is disabled')).toBeTruthy();
  });

  it('異常: 一覧・詳細の読み込みに失敗したら文言と読み直し / 閉じるを出す', async () => {
    let failList = true;
    const transport = advanceServer([makeAdvance()], { overrides: {
      'GET /expense/advances': () => { if (failList) throw new Error('network down'); return { advances: [makeAdvance()] }; },
      'GET /expense/advances/:id': () => { throw new Error('detail down'); },
    } });
    renderLedger(transport);
    expect(await screen.findByText('network down')).toBeTruthy();
    failList = false;
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    expect(await screen.findByText('detail down')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('detail down')).toBeNull());
  });

  it('正常: 精算中の追加支給が振込データに入っていれば、振込が済んでから押すよう案内する', async () => {
    const settling = makeAdvance({ status: 'settling', settlement: { computedAt: AT, claimIds: ['c1'], claimsTotal: 52000, difference: 2000, additionalPayment: { amount: 2000, status: 'exported', payoutBatchId: 'b1' } }, approval: { by: 'boss', at: AT, proxy: true, comment: '代理' }, payment: { paidOn: '2026-09-02', method: 'cash', by: 'u1', at: AT } });
    renderLedger(advanceServer([settling]));
    await openAdvance('Open the advance of 山田 太郎: 大阪出張');
    expect(await screen.findByText(/The additional payment is in a payout file/)).toBeTruthy();
    expect(screen.getByText(/additional payment ¥2,000 not paid yet/)).toBeTruthy();
    expect(screen.getByText(/\(proxy\)/)).toBeTruthy();
  });

  it('advanceDifference: 精算済みは確定値、紐付く申請があれば見込み、無ければ undefined', () => {
    expect(advanceDifference(makeAdvance())).toBeUndefined();
    expect(advanceDifference(makeAdvance({ linkedClaimCount: 1, linkedClaimTotal: 40000 }))).toBe(-10000);
    expect(advanceDifference(makeAdvance({ settlement: { computedAt: AT, claimIds: [], claimsTotal: 0, difference: -50000 } }))).toBe(-50000);
  });
});
