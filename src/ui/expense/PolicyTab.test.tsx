// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpensePolicyDto, ExpensePolicyResultDto } from '../api/expense-types';
import type { JournalChartOfAccountsDto } from '../api/types';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { PolicyTab } from './PolicyTab';
import type { ExpenseFocusRequest } from './expense-shared';

afterEach(() => { cleanup(); consumePendingOpen('Journal'); vi.restoreAllMocks(); });

const policy: ExpensePolicyDto = {
  categories: [
    { id: 'meal.meeting', name: '会議費', enabled: true, sortOrder: 1, aliases: ['打合せ'], accountId: 'meeting', defaultTaxRate: 10, taxCodeByRate: {}, receipt: { required: true }, invoice: { required: true }, requires: { purpose: true, attendees: true, attendeeDetails: false }, limits: { perItem: 10000, perPersonBasis: 'tax-included' } },
    { id: 'misc', name: 'その他', enabled: true, sortOrder: 2, aliases: [], accountId: 'ghost', defaultTaxRate: 10, taxCodeByRate: {}, receipt: { required: true }, invoice: { required: true }, requires: { purpose: false, attendees: false, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' } },
  ],
  claimRules: { submissionDeadlineDays: 90, nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false },
  preApprovalRules: [], severityOverrides: {},
  journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '立替精算 {claimant}' },
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'payables', name: '未払金', category: 'liability', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [], taxCategories: [{ code: 'JP-NA', name: '対象外', side: 'none', enabled: true }], updatedAt: 'x',
};

function fakeApi(overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    savePolicy: vi.fn(async (_scope, body) => ({ ...body, updatedAt: '2026-09-02T00:00:00.000Z' })),
    resetPolicy: vi.fn().mockResolvedValue(policy),
    exportPolicyCsv: vi.fn().mockResolvedValue({ content: 'id,name\r\nmisc,その他', fileName: 'categories.csv' }),
    importPolicyCsv: vi.fn().mockResolvedValue(policy),
    ...overrides,
  } as unknown as ExpenseApi;
}

function renderTab(options: { readonly api?: ExpenseApi; readonly result?: ExpensePolicyResultDto; readonly focus?: ExpenseFocusRequest; readonly chart?: JournalChartOfAccountsDto } = {}) {
  const api = options.api ?? fakeApi();
  const onPolicyChanged = vi.fn();
  const onReloadPolicy = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  render(<NavigationProvider navigate={navigate}>
    <PolicyTab api={api} result={options.result ?? { policy, saved: false }} chart={'chart' in options ? options.chart : chart} chartError={undefined} onReloadChart={vi.fn()}
      onPolicyChanged={onPolicyChanged} onReloadPolicy={onReloadPolicy} focus={options.focus} />
  </NavigationProvider>);
  return { api, onPolicyChanged, onReloadPolicy, navigate };
}

describe('PolicyTab', () => {
  it('正常: 未保存バナーから保存すると、updatedAt を除いた規程を送り、保存済みとして親へ返す', async () => {
    const { api, onPolicyChanged } = renderTab();
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    expect(screen.getByText(/This is still the initial template/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const { updatedAt: _updatedAt, ...body } = policy;
    expect(api.savePolicy).toHaveBeenCalledWith(expect.anything(), body);
    await waitFor(() => expect(onPolicyChanged).toHaveBeenCalledWith({ policy: { ...body, updatedAt: '2026-09-02T00:00:00.000Z' }, saved: true }));
    expect(screen.getByText('Saved. Check the claims again so the new policy applies.')).toBeTruthy();
  });

  it('正常: 費目だけを直して保存しても、実用化の節（承認経路・交通費・カード・仮払・費目の区間・部門の補助軸）をそのまま送る', async () => {
    const practical: ExpensePolicyDto = {
      ...policy,
      categories: policy.categories.map((category, index) => (index === 0 ? { ...category, route: { required: true, commuterPass: false, fareTable: true } } : category)),
      journal: { ...policy.journal, departmentDimensionId: 'department' },
      approval: { routes: [{ id: 'high', name: '高額', enabled: true, when: { categoryIds: [], minClaimAmount: 50000, departmentIds: [] }, steps: [{ id: 'head', name: '部門長', approver: { kind: 'department-head' }, skipWhenSameAsPrevious: false }] }], defaultSteps: [{ id: 'approve', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }], forbidClaimantApproval: true, requireDistinctApprovers: false, proxyGroupId: 'accounting' },
      transport: { commuterPassDeduction: false, fareToleranceYen: 20, defaultFareType: 'ticket' },
      card: { acceptCorporatePaymentItems: true, dateToleranceDays: 2, amountToleranceYen: 5, weakMatchMinAmount: 5000, creditAccountId: 'payables', creditTaxCode: 'JP-NA' },
      advance: { advanceAccountId: 'suspense', paymentAccountId: 'bank', refundAccountId: 'bank', settleWithinDays: 14 },
    };
    const { api } = renderTab({ result: { policy: practical, saved: true } });
    await userEvent.type(screen.getByLabelText('Name of meal.meeting'), '（社内）');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const { updatedAt: _updatedAt, ...rest } = practical;
    expect(api.savePolicy).toHaveBeenCalledWith(expect.anything(), { ...rest, categories: [{ ...rest.categories[0], name: '会議費（社内）' }, rest.categories[1]] });
  });

  it('正常: 保存済みでも編集すると「保存していない変更」になり、破棄で戻せる', async () => {
    renderTab({ result: { policy, saved: true } });
    expect(screen.queryByText('Not saved yet')).toBeNull();
    const name = screen.getByLabelText('Name of meal.meeting');
    await userEvent.type(name, '（社内）');
    expect(screen.getByText('You have unsaved changes')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect((screen.getByLabelText('Name of meal.meeting') as HTMLInputElement).value).toBe('会議費');
    expect(screen.queryByText('You have unsaved changes')).toBeNull();
  });

  it('正常: 重さの選択肢は adjustable の値だけ。変更できない理由には選択欄が無い', async () => {
    const { api } = renderTab();
    const unreviewed = screen.getByLabelText('Severity of Policy not saved yet') as HTMLSelectElement;
    expect([...unreviewed.options].map((option) => option.value)).toEqual(['', 'review', 'off']);
    const payee = screen.getByLabelText('Severity of Payee missing') as HTMLSelectElement;
    expect([...payee.options].map((option) => option.value)).toEqual(['', 'review', 'return']);
    expect([...(screen.getByLabelText('Severity of Purpose missing') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'off', 'review', 'return']);
    expect(screen.queryByLabelText('Severity of Amount missing')).toBeNull();
    expect(screen.queryByLabelText('Severity of No items')).toBeNull();
    await userEvent.selectOptions(payee, 'return');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(api.savePolicy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ severityOverrides: { 'payee-missing': 'return' } }));
  });

  it('正常: 科目マスタに無い科目には印と「科目を開く」。仕訳画面の科目タブへ遷移する', async () => {
    const { navigate } = renderTab();
    // 同じ印は実用化の節（カード・仮払の科目の選択肢）にも出るので、費目の行の印（「科目を開く」付きの span）に絞る。
    expect(screen.getByText('Not in the journal chart of accounts', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ghost (not in the chart)' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open accounts' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
    expect(consumePendingOpen('Journal')).toEqual({ internalId: 'ghost', section: 'account' });
  });

  it('境界: 科目マスタを読めていないときは科目 id を直接入力する', () => {
    renderTab({ chart: undefined });
    expect((screen.getByLabelText('Account of 会議費') as HTMLInputElement).value).toBe('meeting');
  });

  it('正常: 自己承認の禁止が off なら、複数人で運用するなら on を推奨と出す', async () => {
    renderTab();
    expect(screen.getByText(/If several people use this workspace, turning this on is recommended/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/Forbid approving a claim you imported yourself/));
    expect(screen.queryByText(/If several people use this workspace/)).toBeNull();
  });

  it('異常: 上限に数字でない値を入れると保存前に直す箇所を並べ、保存を押せない', async () => {
    renderTab();
    const limit = screen.getByLabelText('Per-item limit of 会議費');
    await userEvent.clear(limit);
    await userEvent.type(limit, 'abc');
    expect(screen.getByText('Fix these before saving')).toBeTruthy();
    expect(screen.getByText('categories.0.limits.perItem')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('正常: 費目と事前承認条件を足せる（新しい条件は費目か金額を入れるまで保存できない）', async () => {
    renderTab();
    await userEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    expect(screen.getByText('preApprovalRules.0.categoryIds')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('preApprovalRules.0.categoryIds')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a category' }));
    expect(screen.getByLabelText('Name of category-3')).toBeTruthy();
  });

  it('正常: 初期テンプレートに戻すは確認ダイアログを挟み、戻したら読み直す', async () => {
    const { api, onReloadPolicy } = renderTab({ result: { policy, saved: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Reset to the initial template' }));
    const dialog = screen.getByRole('alertdialog');
    expect(api.resetPolicy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    expect(api.resetPolicy).toHaveBeenCalled();
    await waitFor(() => expect(onReloadPolicy).toHaveBeenCalled());
  });

  it('正常: 費目 CSV の出力はダウンロードできない環境でテキストエリアに出し、取込は文字列にして送る', async () => {
    const { api, onPolicyChanged } = renderTab();
    // Blob URL を作れない環境（古い WebView など）を再現する。
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('not supported'); });
    await userEvent.click(screen.getByRole('button', { name: 'Export categories CSV' }));
    // textarea は改行を LF に正規化するので、中身の行で比べる。
    expect(((await screen.findByLabelText('Categories CSV')) as HTMLTextAreaElement).value.split(/\r?\n/)).toEqual(['id,name', 'misc,その他']);

    const file = new File(['id,name\nmisc,その他'], 'categories.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('id,name\nmisc,その他').buffer });
    await userEvent.upload(screen.getByLabelText('Import categories CSV'), file);
    await waitFor(() => expect(api.importPolicyCsv).toHaveBeenCalledWith(expect.anything(), 'id,name\nmisc,その他'));
    await waitFor(() => expect(onPolicyChanged).toHaveBeenCalledWith({ policy, saved: true }));
  });

  it('異常: 取込の失敗はサーバーの文言（行番号入り）を出す', async () => {
    renderTab({ api: fakeApi({ importPolicyCsv: vi.fn().mockRejectedValue(new Error('CSV の 3 行目を取り込めませんでした')) }) });
    const file = new File(['x'], 'bad.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('x').buffer });
    await userEvent.upload(screen.getByLabelText('Import categories CSV'), file);
    expect(await screen.findByText('CSV の 3 行目を取り込めませんでした')).toBeTruthy();
  });

  it('正常: 理由カードから来たら該当する費目の行に印を付ける', async () => {
    renderTab({ focus: { tab: 'policy', section: 'category', id: 'misc', seq: 1 } });
    await waitFor(() => expect(document.getElementById('expense-category-misc')?.className).toContain('expense-focused'));
  });
});
