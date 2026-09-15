// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpenseCapabilitiesDto, ExpenseClaimDto, ExpenseClaimSummaryDto, ExpensePolicyDto, ExpensePolicyResultDto } from '../api/expense-types';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto } from '../api/types';
import { NavigationProvider, consumePendingOpen, requestOpenInScreen } from '../navigation';
import { ApproveTab } from './ApproveTab';
import { ExpensePage } from './ExpensePage';
import { IngestTab } from './IngestTab';
import { SettleTab } from './SettleTab';
import { EXPENSE_LEDGER_TABS } from './expense-model';
import { ExpenseSlotProvider, useExpenseSlotEnvironment } from './expense-shared';
import * as slots from './expense-slots';

/*
 * スロットの差し込み位置と props を、系統の部品の中身に依らずに確かめる（スタブを目印の部品に差し替える）。
 * 系統がスタブを書き換えても、このテストは骨格の配線だけを見続ける。
 */
const slotMock = vi.hoisted(() => {
  const seen = new Map<string, Record<string, unknown>>();
  const make = (name: string) => async () => {
    const { createElement } = await import('react');
    return { [name]: (props: Record<string, unknown>) => { seen.set(name, props); return createElement('div', { 'data-slot': name }); } };
  };
  return { seen, make };
});
vi.mock('./people/EmployeesLedger', slotMock.make('EmployeesLedger'));
vi.mock('./people/ApprovalRoutesSection', slotMock.make('ApprovalRoutesSection'));
vi.mock('./people/ClaimantPicker', slotMock.make('ClaimantPicker'));
vi.mock('./people/ApprovalFlowPanel', slotMock.make('ApprovalFlowPanel'));
vi.mock('./money/AdvancesLedger', slotMock.make('AdvancesLedger'));
vi.mock('./money/CardsLedger', slotMock.make('CardsLedger'));
vi.mock('./money/ReportsLedger', slotMock.make('ReportsLedger'));
vi.mock('./money/MoneySettingsSection', slotMock.make('MoneySettingsSection'));
vi.mock('./money/AdvanceLinkField', slotMock.make('AdvanceLinkField'));
vi.mock('./money/PayoutPanel', slotMock.make('PayoutPanel'));
vi.mock('./input/FaresLedger', slotMock.make('FaresLedger'));
vi.mock('./input/TransportSettingsSection', slotMock.make('TransportSettingsSection'));
vi.mock('./input/PolicyHearingPanel', slotMock.make('PolicyHearingPanel'));
vi.mock('./input/RouteFields', slotMock.make('RouteFields'));
vi.mock('./input/DetailReadToggle', slotMock.make('DetailReadToggle'));

afterEach(() => { cleanup(); slotMock.seen.clear(); consumePendingOpen('Expense'); });

const props = (name: string) => slotMock.seen.get(name) as Record<string, unknown>;
const slotElement = (name: string) => document.querySelector(`[data-slot="${name}"]`);

const policy: ExpensePolicyDto = {
  categories: [{ id: 'transport.public', name: '電車・バス', enabled: true, sortOrder: 1, aliases: [], accountId: 'travel', defaultTaxRate: 10, taxCodeByRate: {}, receipt: { required: false }, invoice: { required: false }, requires: { purpose: false, attendees: false, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' }, route: { required: true, commuterPass: true, fareTable: true } }],
  claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false }, preApprovalRules: [], severityOverrides: {},
  journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '', departmentDimensionId: 'department' },
  transport: { commuterPassDeduction: true, fareToleranceYen: 0, defaultFareType: 'ic' },
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const chart: JournalChartOfAccountsDto = { accounts: [{ id: 'travel', name: '旅費交通費', category: 'expense', aliases: [], enabled: true, sortOrder: 1 }, { id: 'payables', name: '未払金', category: 'liability', aliases: [], enabled: true, sortOrder: 2 }], dimensions: [], taxCategories: [], updatedAt: 'x' };
const summary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'draft', stale: false, itemCount: 1, totalAmount: 398, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};
const claim: ExpenseClaimDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'draft', acknowledgements: [], history: [],
  items: [{ id: 'i1', categoryId: 'transport.public', facts: { amount: 398, description: '客先訪問' }, hasReceipt: false, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } }],
  submittedBy: 'u1', createdAt: 'x', updatedAt: 'x', totalAmount: 398, reimbursableAmount: 398, stale: false, approvalBlockers: [],
};
const capabilities: ExpenseCapabilitiesDto = { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: false } };

function makeClient() {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/runtime/capabilities') return { expense: capabilities };
    if (path.startsWith('/expense/policy?')) return { policy, saved: true };
    if (path === '/expense/policy' && method === 'PUT') return { policy: { ...JSON.parse(String(init?.body)), updatedAt: '2026-09-02T00:00:00.000Z' } };
    if (path.startsWith('/expense/claims?')) return { claims: [summary] };
    if (method === 'GET' && path.startsWith('/expense/claims/')) return { claim };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { client: { request, getJournalChart: vi.fn().mockResolvedValue(chart) } as unknown as ToolApiClient, request };
}

describe('expense-slots（登録点）', () => {
  it('正常: 台帳のスロットは 2 段目のタブと 1 対 1', () => {
    expect(Object.keys(slots.EXPENSE_LEDGER_SLOTS).sort()).toEqual([...EXPENSE_LEDGER_TABS].sort());
    expect(slots.EXPENSE_LEDGER_SLOTS.employees).toBe(slots.LedgerEmployees);
    expect(slots.EXPENSE_LEDGER_SLOTS.fares).toBe(slots.LedgerFares);
  });

  it('正常: 台帳タブを選ぶとそのスロットを描き、送信口（画面の client）・スコープ・規程・申請一覧・導線を渡す', async () => {
    const { client } = makeClient();
    render(<NavigationProvider navigate={vi.fn()}><ExpensePage client={client} /></NavigationProvider>);
    const ledgers = screen.getByRole('tablist', { name: 'Ledgers and masters' });
    const expected = [['Employees & organization', 'EmployeesLedger'], ['Advances', 'AdvancesLedger'], ['Card statements', 'CardsLedger'], ['Fare table', 'FaresLedger'], ['Reports', 'ReportsLedger']] as const;
    for (const [label, name] of expected) {
      await userEvent.click(within(ledgers).getByRole('tab', { name: label }));
      expect(slotElement(name)).toBeTruthy();
      for (const [, other] of expected) if (other !== name) expect(slotElement(other)).toBeNull();
    }
    await waitFor(() => expect((props('ReportsLedger')['claims'] as readonly unknown[]).length).toBe(1));
    const ledger = props('ReportsLedger');
    expect(ledger['transport']).toBe(client);
    expect(ledger['scope']).toBeTruthy();
    expect((ledger['policy'] as ExpensePolicyResultDto).policy.categories[0]?.id).toBe('transport.public');
    expect(ledger['focus']).toBeUndefined();
    expect(typeof ledger['onOpen']).toBe('function');
    expect(typeof ledger['onClaimsChanged']).toBe('function');
    expect(ledger['capabilities']).toEqual(capabilities);
  });

  it('正常: 導線（employee-commuter）で台帳を開くと、スロットへ行 id 付きの focus を渡す', async () => {
    requestOpenInScreen('Expense', { internalId: 'e1', section: 'employee-commuter' });
    render(<NavigationProvider navigate={vi.fn()}><ExpensePage client={makeClient().client} /></NavigationProvider>);
    expect(slotElement('EmployeesLedger')).toBeTruthy();
    expect(props('EmployeesLedger')['focus']).toMatchObject({ tab: 'employees', section: 'employee-commuter', id: 'e1' });
    // 行の id は申請の選択にしない（申請取込を開いても e1 を読みに行かない）。
    await userEvent.click(screen.getByRole('tab', { name: 'Ingest' }));
    expect(screen.queryByRole('heading', { name: 'e1' })).toBeNull();
  });

  it('正常: 規程タブは 4 つの節を差し込み、承認経路は導線の id の中に置く。節の onChange は下書きを変え、保存で実用化の節を送る', async () => {
    const { client, request } = makeClient();
    render(<NavigationProvider navigate={vi.fn()}><ExpensePage client={client} /></NavigationProvider>);
    await userEvent.click(screen.getByRole('tab', { name: 'Policy' }));
    await screen.findByRole('heading', { name: 'Categories' });
    for (const name of ['ApprovalRoutesSection', 'TransportSettingsSection', 'MoneySettingsSection', 'PolicyHearingPanel']) expect(slotElement(name), name).toBeTruthy();
    expect(slotElement('ApprovalRoutesSection')?.parentElement?.id).toBe('expense-policy-approval');
    expect(props('PolicyHearingPanel')).toMatchObject({ dirty: false, capabilities });
    expect((props('PolicyHearingPanel')['policy'] as ExpensePolicyDto).updatedAt).toBe('2026-09-01T00:00:00.000Z');

    const section = props('ApprovalRoutesSection');
    const draft = section['draft'] as ExpensePolicyDto;
    const approval = { routes: [], defaultSteps: [{ id: 'approve', name: '承認', approver: { kind: 'any-approver' as const }, skipWhenSameAsPrevious: false }], forbidClaimantApproval: true, requireDistinctApprovers: true };
    act(() => { (section['onChange'] as (next: unknown) => void)({ ...draft, approval }); });
    expect(await screen.findByText('You have unsaved changes')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(request.mock.calls.some(([path, init]) => path === '/expense/policy' && (init as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    const put = request.mock.calls.find(([path, init]) => path === '/expense/policy' && (init as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse(String((put?.[1] as RequestInit).body)) as ExpensePolicyDto;
    expect(body.approval).toEqual(approval);
    // 触っていない節（交通費・費目の区間・仕訳の部門の補助軸）も落とさない。
    expect(body.transport).toEqual(policy.transport);
    expect(body.categories[0]?.route).toEqual({ required: true, commuterPass: true, fareTable: true });
    expect(body.journal.departmentDimensionId).toBe('department');
  });

  it('正常: 取込タブは申請者欄・仮払の紐付け・読取の切替・区間欄を差し込み、切替と区間は保存と読取の本文に効く', async () => {
    const api = {
      getClaim: vi.fn().mockResolvedValue(claim),
      saveItem: vi.fn().mockResolvedValue(claim),
      extractReceipt: vi.fn().mockResolvedValue({ drafts: [{ facts: { amount: 398 }, source: { type: 'image', fileName: 'r.jpg' }, extraction: { method: 'llm', warnings: [] } }], warnings: [] }),
    } as unknown as ExpenseApi;
    const transport = { request: vi.fn() };
    const onOpen = vi.fn();
    render(<NavigationProvider navigate={vi.fn()}>
      <ExpenseSlotProvider value={{ transport, scope: { tenantId: 't', workspaceId: 'w' }, capabilities }}>
        <IngestTab api={api} policy={policy} claims={[summary]} onClaimsChanged={vi.fn()} capabilities={capabilities} selectedClaimId="c1" onSelectClaim={vi.fn()} focus={undefined} onOpen={onOpen} onTab={vi.fn()}
          prepareFile={async (file) => ({ label: file.name, fileName: file.name, images: ['data:image/jpeg;base64,AAA'], notices: [] })} />
      </ExpenseSlotProvider>
    </NavigationProvider>);
    await screen.findByRole('heading', { name: '山田 太郎' });
    expect(slotElement('AdvanceLinkField')?.parentElement?.id).toBe('expense-claim-advance-link');
    expect(props('AdvanceLinkField')).toMatchObject({ transport, editable: true, focused: false, onOpen });

    // 読取の切替（reader）を on にすると detail: true を付けて読む。
    expect(props('DetailReadToggle')).toMatchObject({ placement: 'reader', detail: false });
    act(() => { (props('DetailReadToggle')['onDetailChange'] as (next: boolean) => void)(true); });
    await userEvent.upload(screen.getByLabelText('Receipt images or PDFs'), new File(['x'], 'r.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Read with AI' }));
    await waitFor(() => expect(api.extractReceipt).toHaveBeenCalledWith(expect.anything(), { images: ['data:image/jpeg;base64,AAA'], fileName: 'r.jpg', detail: true }, expect.any(AbortSignal)));
    await screen.findByRole('button', { name: 'Review in the form' });
    expect(props('DetailReadToggle')).toMatchObject({ placement: 'draft', images: ['data:image/jpeg;base64,AAA'] });

    // 申請者欄は申請のフォームの中に出て、氏名欄の id を受け取る。
    await userEvent.click(screen.getByRole('button', { name: 'New claim' }));
    expect(props('ClaimantPicker')).toMatchObject({ mode: 'new', inputId: 'expense-claim-name' });
    expect(document.getElementById('expense-claim-name')).toBeTruthy();

    // 区間欄は明細フォームの中に出て、onChange の区間が保存本文の facts に載る。
    await userEvent.click(screen.getByRole('button', { name: 'Edit 客先訪問' }));
    expect(props('RouteFields')).toMatchObject({ inputId: 'expense-item-route', transportSettings: policy.transport, transactionDate: '' });
    expect((props('RouteFields')['category'] as { id: string }).id).toBe('transport.public');
    const route = { stations: ['新宿', '霞ケ関'], trips: 2, fareType: 'ic' };
    act(() => { (props('RouteFields')['onChange'] as (next: unknown) => void)(route); });
    expect(props('RouteFields')['route']).toEqual(route);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(api.saveItem).toHaveBeenCalledWith(expect.anything(), 'c1', expect.objectContaining({ itemId: 'i1', facts: { amount: 398, description: '客先訪問', route } }));
  });

  it('正常: 承認タブの詳細に承認の流れ、精算出力に振込データのスロットを描く', async () => {
    const transport = { request: vi.fn() };
    const environment = { transport, scope: { tenantId: 't', workspaceId: 'w' }, capabilities: undefined };
    const checked: ExpenseClaimDto = { ...claim, status: 'checked' };
    render(<NavigationProvider navigate={vi.fn()}><ExpenseSlotProvider value={environment}>
      <ApproveTab api={{ getClaim: vi.fn().mockResolvedValue(checked) } as unknown as ExpenseApi} claims={[{ ...summary, status: 'checked' }]} onClaimsChanged={vi.fn()} selectedClaimId="c1" onSelectClaim={vi.fn()} onOpen={vi.fn()} onTab={vi.fn()} />
    </ExpenseSlotProvider></NavigationProvider>);
    await waitFor(() => expect(slotElement('ApprovalFlowPanel')).toBeTruthy());
    expect(props('ApprovalFlowPanel')).toMatchObject({ transport, claim: checked });
    cleanup();

    const approved = [{ ...summary, status: 'approved' as const }];
    render(<NavigationProvider navigate={vi.fn()}><ExpenseSlotProvider value={environment}>
      <SettleTab api={{} as ExpenseApi} claims={approved} onClaimsChanged={vi.fn()} onOpen={vi.fn()} onTab={vi.fn()} />
    </ExpenseSlotProvider></NavigationProvider>);
    expect(slotElement('PayoutPanel')).toBeTruthy();
    expect(props('PayoutPanel')).toMatchObject({ transport, claims: approved });
  });

  it('異常: 経費画面の外（タブ単体）で描いたスロットの送信口は、原因の分かるエラーで断る', async () => {
    let environment: ReturnType<typeof useExpenseSlotEnvironment> | undefined;
    function Probe() { environment = useExpenseSlotEnvironment(); return null; }
    render(<Probe />);
    await expect(environment?.transport.request('/expense/employees')).rejects.toThrow('outside the expense screen');
    expect(environment?.capabilities).toBeUndefined();
  });
});
