// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseClaimDto, ExpenseClaimSummaryDto, ExpensePolicyDto } from '../api/expense-types';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto } from '../api/types';
import { NavigationProvider, consumePendingOpen, requestOpenInScreen } from '../navigation';
import { ExpensePage } from './ExpensePage';

afterEach(() => { cleanup(); consumePendingOpen('Expense'); });

const policy: ExpensePolicyDto = {
  categories: [{ id: 'meal.meeting', name: '会議費', enabled: true, sortOrder: 1, aliases: [], accountId: 'meeting', defaultTaxRate: 10, taxCodeByRate: {}, receipt: { required: true }, invoice: { required: true }, requires: { purpose: true, attendees: false, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' } }],
  claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false }, preApprovalRules: [], severityOverrides: {},
  journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '' }, updatedAt: '2026-09-01T00:00:00.000Z',
};
const chart: JournalChartOfAccountsDto = { accounts: [{ id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 1 }], dimensions: [], taxCategories: [], updatedAt: 'x' };
const summary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'draft', stale: false, itemCount: 0, totalAmount: 0, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};
const claim: ExpenseClaimDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, items: [], status: 'draft', acknowledgements: [], history: [],
  submittedBy: 'u1', createdAt: 'x', updatedAt: 'x', totalAmount: 0, reimbursableAmount: 0, stale: false, approvalBlockers: [],
};

/** 系統の準備状況の応答。渡したものだけ読める（渡さなければ系統の API の無い古いサーバーと同じく失敗する）。 */
interface ReadinessResponses { readonly people?: unknown; readonly money?: unknown; readonly fares?: unknown }

function makeClient(options: { readonly claims?: readonly ExpenseClaimSummaryDto[]; readonly policyFailure?: Error; readonly policy?: ExpensePolicyDto; readonly readiness?: ReadinessResponses } = {}) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/runtime/capabilities') return { expense: { extraction: { enabled: false, vision: false } } };
    if (path.startsWith('/expense/people/readiness?') && options.readiness?.people !== undefined) return { readiness: options.readiness.people };
    if (path.startsWith('/expense/money-readiness?') && options.readiness?.money !== undefined) return { readiness: options.readiness.money };
    if (path.startsWith('/expense/fares?') && options.readiness?.fares !== undefined) return options.readiness.fares;
    if (path.startsWith('/expense/policy?')) { if (options.policyFailure !== undefined) throw options.policyFailure; return { policy: options.policy ?? policy, saved: false }; }
    if (path.startsWith('/expense/claims?')) return { claims: options.claims ?? [] };
    if (method === 'GET' && path.startsWith('/expense/claims/')) return { claim };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const client = { request, getJournalChart: vi.fn().mockResolvedValue(chart) } as unknown as ToolApiClient;
  return { client, request };
}

function renderPage(client: ToolApiClient, navigate = vi.fn()) {
  render(<NavigationProvider navigate={navigate}><ExpensePage client={client} /></NavigationProvider>);
  return navigate;
}

describe('ExpensePage', () => {
  it('正常: 規程 → 申請取込 → チェック → 承認 → 精算出力の順に並び、最初は申請取込を開く', async () => {
    renderPage(makeClient().client);
    // 取込タブの中の「画像 / 手入力 / CSV」も tab なので、手順の tablist に絞る。
    expect(within(screen.getByRole('tablist', { name: 'Expense steps' })).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Policy', 'Ingest', 'Check', 'Approve', 'Export']);
    expect(screen.getByRole('tab', { name: 'Ingest' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No claims yet. Start by reading a receipt image or importing an expense CSV.')).toBeTruthy();
  });

  it('境界: 0 件と未保存は件数として出すだけで、失敗の表示（alert・エラー文）にしない', async () => {
    renderPage(makeClient().client);
    expect(await screen.findByText('0 claims')).toBeTruthy();
    expect(screen.getByText('0 to review')).toBeTruthy();
    expect(screen.getByText('0 waiting')).toBeTruthy();
    expect(screen.getByText('0 approved')).toBeTruthy();
    expect(await screen.findByText('initial template')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(document.querySelectorAll('.api-error')).toHaveLength(0);
    expect(screen.queryByText('Could not load part of this screen')).toBeNull();
  });

  it('正常: 未チェックの申請があればチェックのバッジは未チェック件数', async () => {
    renderPage(makeClient({ claims: [summary, { ...summary, id: 'c2', status: 'approved' }] }).client);
    expect(await screen.findByText('1 unchecked')).toBeTruthy();
    expect(screen.getByText('2 claims')).toBeTruthy();
    expect(screen.getByText('1 approved')).toBeTruthy();
  });

  it('正常: 戻るリンクは業務テンプレートへ遷移する', async () => {
    const navigate = renderPage(makeClient().client);
    await userEvent.click(screen.getByRole('button', { name: '← Business templates' }));
    expect(navigate).toHaveBeenCalledWith('Templates');
  });

  it('正常: ディープリンク（rules）で規程タブの申請ルールを開く', async () => {
    requestOpenInScreen('Expense', { internalId: '', section: 'rules' });
    renderPage(makeClient().client);
    expect(screen.getByRole('tab', { name: 'Policy' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Claim rules' })).toBeTruthy();
  });

  it('正常: ディープリンク（claim）でチェックタブにその申請を開く', async () => {
    requestOpenInScreen('Expense', { internalId: 'c1', section: 'claim' });
    renderPage(makeClient({ claims: [summary] }).client);
    expect(screen.getByRole('tab', { name: 'Check' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: '山田 太郎 · 2026-09-01〜2026-09-30' })).toBeTruthy();
  });

  it('異常: 経路が無い（404）ときは生のメッセージではなくサーバーの再起動を案内し、再試行できる', async () => {
    const { client, request } = makeClient({ policyFailure: new ApiError(404, 'NOT_FOUND', 'Route GET:/expense/policy not found') });
    renderPage(client);
    expect(await screen.findByText(/The API server has no expense endpoints/)).toBeTruthy();
    const before = request.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
  });

  it('正常: ステッパーの下に「台帳とマスタ」のタブ列（5 つ）があり、選ぶと手順のタブの選択が外れる', async () => {
    renderPage(makeClient().client);
    const ledgers = screen.getByRole('tablist', { name: 'Ledgers and masters' });
    expect(ledgers.className).toContain('expense-ledger-tabs');
    expect(within(ledgers).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Employees & organization', 'Advances', 'Card statements', 'Fare table', 'Reports']);
    await userEvent.click(within(ledgers).getByRole('tab', { name: 'Advances' }));
    expect(within(ledgers).getByRole('tab', { name: 'Advances' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tablist', { name: 'Expense steps' })).getAllByRole('tab').map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false', 'false', 'false']);
    await userEvent.click(screen.getByRole('tab', { name: 'Check' }));
    expect(within(ledgers).getAllByRole('tab').every((tab) => tab.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('境界: 規程タブ先頭の「実用機能の準備」はすべて未設定でも赤くせず、設定しなくても使えると先に言い、「開く」で台帳へ行く', async () => {
    renderPage(makeClient().client);
    await userEvent.click(screen.getByRole('tab', { name: 'Policy' }));
    await screen.findByRole('heading', { name: 'Categories' });
    const card = screen.getByRole('heading', { name: 'Practical features' }).closest('section') as HTMLElement;
    expect(within(card).getByText('You can claim, check, approve, and export CSV without setting these up.')).toBeTruthy();
    expect(within(card).getAllByText('Not set up')).toHaveLength(5);
    expect(within(card).queryByText('Set up')).toBeNull();
    // 未設定は失敗ではない: alert にせず、エラー・差し戻しの赤系のクラスも使わない。
    expect(within(card).queryAllByRole('alert')).toHaveLength(0);
    expect(card.querySelectorAll('.api-error, .field-error, .expense-cell-issue, .expense-reason-return, .expense-not-in-chart')).toHaveLength(0);
    await userEvent.click(within(card).getByRole('button', { name: 'Open Corporate cards' }));
    expect(within(screen.getByRole('tablist', { name: 'Ledgers and masters' })).getByRole('tab', { name: 'Card statements' }).getAttribute('aria-selected')).toBe('true');
  });

  it('正常: 規程に承認経路があれば承認経路の行を設定済みにし、「開く」は規程の承認経路の節に印を付ける', async () => {
    const routed: ExpensePolicyDto = {
      ...policy,
      approval: { routes: [{ id: 'high', name: '高額', enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [{ id: 'head', name: '部門長', approver: { kind: 'department-head' }, skipWhenSameAsPrevious: false }] }], defaultSteps: [], forbidClaimantApproval: true, requireDistinctApprovers: false },
    };
    renderPage(makeClient({ policy: routed }).client);
    await userEvent.click(screen.getByRole('tab', { name: 'Policy' }));
    await screen.findByRole('heading', { name: 'Categories' });
    const card = screen.getByRole('heading', { name: 'Practical features' }).closest('section') as HTMLElement;
    await waitFor(() => expect(within(card).getAllByText('Not set up')).toHaveLength(4));
    expect(within(card).getByText('Set up')).toBeTruthy();
    expect(within(card).queryByText(/without setting these up/)).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Open Approval routes' }));
    await waitFor(() => expect(document.getElementById('expense-policy-approval')?.className).toContain('expense-focused'));
    expect(screen.getByRole('tab', { name: 'Policy' }).getAttribute('aria-selected')).toBe('true');
  });

  it('正常: 系統の API から準備状況を読み、振込元は A より B（お金の流れ）の値を優先する', async () => {
    renderPage(makeClient({ readiness: {
      people: { employees: { configured: true, enabledCount: 3 }, payout: { configured: false } },
      money: { cards: true, cardCount: 1, cardImportCount: 0, cardCoverage: [], payout: true },
      fares: { table: { routes: [{ id: 'r1', stations: ['新宿', '霞ケ関'] }], stationAliases: [], updatedAt: 'x' }, saved: true },
    } }).client);
    await userEvent.click(screen.getByRole('tab', { name: 'Policy' }));
    const card = (await screen.findByRole('heading', { name: 'Practical features' })).closest('section') as HTMLElement;
    // 規程に経路が無いので承認経路だけが未設定。A の振込元は false でも B が true なら設定済み。
    await waitFor(() => expect(within(card).getAllByText('Set up')).toHaveLength(4));
    expect(within(card).getAllByText('Not set up')).toHaveLength(1);
  });

  it('異常: 系統の API の一部が読めなくても画面を赤くせず、読めた分だけ出す（B が読めなければ振込元は A の値）', async () => {
    renderPage(makeClient({ readiness: { people: { employees: { configured: false, enabledCount: 0 }, payout: { configured: true } } } }).client);
    await userEvent.click(screen.getByRole('tab', { name: 'Policy' }));
    const card = (await screen.findByRole('heading', { name: 'Practical features' })).closest('section') as HTMLElement;
    await waitFor(() => expect(within(card).getAllByText('Set up')).toHaveLength(1));
    expect(within(card).getAllByText('Not set up')).toHaveLength(4);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.queryByText('Could not load part of this screen')).toBeNull();
  });

  it('正常: 承認中（in-approval）の申請も承認待ちの件数に入る', async () => {
    renderPage(makeClient({ claims: [{ ...summary, status: 'checked' }, { ...summary, id: 'c2', status: 'in-approval' }, { ...summary, id: 'c3', status: 'approved' }] }).client);
    expect(await screen.findByText('2 waiting')).toBeTruthy();
  });

  it('正常: タブを切り替えると各ステップの画面が出る', async () => {
    renderPage(makeClient().client);
    await userEvent.click(screen.getByRole('tab', { name: 'Check' }));
    expect(await screen.findByText('There are no claims to check.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Approve' }));
    expect(await screen.findByText('No claims are waiting for approval.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Export' }));
    expect(await screen.findByText('There are no approved claims.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Policy' }));
    expect(await screen.findByRole('heading', { name: 'Categories' })).toBeTruthy();
  });
});
