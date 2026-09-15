// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseApi } from '../api/expense-api';
import type { ExpenseCapabilitiesDto, ExpenseClaimDto, ExpenseClaimSummaryDto, ExpensePolicyDto, ExtractExpenseReceiptResultDto } from '../api/expense-types';
import { ApiError } from '../api/tool-api';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { IngestTab, type PrepareReceiptFile } from './IngestTab';
import type { ExpenseFocusRequest } from './expense-shared';

afterEach(() => { cleanup(); consumePendingOpen('Settings'); });

const policy: ExpensePolicyDto = {
  categories: [{ id: 'meal.meeting', name: '会議費', enabled: true, sortOrder: 1, aliases: [], accountId: 'meeting', defaultTaxRate: 10, taxCodeByRate: {}, receipt: { required: true }, invoice: { required: true }, requires: { purpose: true, attendees: true, attendeeDetails: false }, limits: { perItem: 10000, perPersonBasis: 'tax-included' } }],
  claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false }, preApprovalRules: [], severityOverrides: {},
  journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '' }, updatedAt: 'x',
};
const summary: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'draft', stale: false, itemCount: 1, totalAmount: 1100, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};
const claim: ExpenseClaimDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'draft', acknowledgements: [], history: [],
  items: [{ id: 'i1', categoryId: 'meal.meeting', facts: { transactionDate: '2026-09-05', payeeName: 'サンプル弁当', amount: 1100, description: '弁当' }, hasReceipt: false, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } }],
  submittedBy: 'u1', createdAt: 'x', updatedAt: 'x', totalAmount: 1100, reimbursableAmount: 1100, stale: false, approvalBlockers: [],
};
const VISION: ExpenseCapabilitiesDto = { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } };

function fakeApi(overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    getClaim: vi.fn().mockResolvedValue(claim),
    createClaim: vi.fn().mockResolvedValue({ ...claim, id: 'c2', items: [] }),
    updateClaim: vi.fn().mockResolvedValue(claim),
    saveItem: vi.fn().mockResolvedValue(claim),
    deleteItem: vi.fn().mockResolvedValue({ ...claim, items: [] }),
    deleteClaim: vi.fn().mockResolvedValue(undefined),
    getReceipt: vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,AAA' }),
    extractReceipt: vi.fn(),
    importCsv: vi.fn(),
    ...overrides,
  } as unknown as ExpenseApi;
}

const prepareFile: PrepareReceiptFile = async (file) => ({ label: file.name, fileName: file.name, images: ['data:image/jpeg;base64,AAA'], notices: [] });

function renderTab(options: {
  readonly api?: ExpenseApi; readonly claims?: readonly ExpenseClaimSummaryDto[]; readonly selectedClaimId?: string; readonly capabilities?: ExpenseCapabilitiesDto; readonly focus?: ExpenseFocusRequest;
} = {}) {
  const api = options.api ?? fakeApi();
  const onSelectClaim = vi.fn();
  const onClaimsChanged = vi.fn().mockResolvedValue(undefined);
  const onOpen = vi.fn();
  const navigate = vi.fn();
  render(<NavigationProvider navigate={navigate}>
    <IngestTab api={api} policy={policy} claims={options.claims ?? [summary]} onClaimsChanged={onClaimsChanged} capabilities={options.capabilities ?? VISION}
      selectedClaimId={options.selectedClaimId} onSelectClaim={onSelectClaim} focus={options.focus} onOpen={onOpen} onTab={vi.fn()} prepareFile={prepareFile} />
  </NavigationProvider>);
  return { api, onSelectClaim, onClaimsChanged, onOpen, navigate };
}

function fileWithText(name: string, content: string, type: string): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  return file;
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('IngestTab', () => {
  it('正常: 申請が無ければ始め方とサンプルの場所を案内する', () => {
    renderTab({ claims: [] });
    expect(screen.getByText('No claims yet. Start by reading a receipt image or importing an expense CSV.')).toBeTruthy();
    expect(screen.getByText(/samples\/expense\//)).toBeTruthy();
  });

  it('正常: 新しい申請は申請者を必須にし、作ったら選ぶ', async () => {
    const { api, onSelectClaim, onClaimsChanged } = renderTab();
    await userEvent.click(screen.getByRole('button', { name: 'New claim' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create the claim' }));
    expect(screen.getByText('Enter the claimant name.')).toBeTruthy();
    expect(api.createClaim).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Claimant name'), '佐藤 花子');
    await userEvent.click(screen.getByRole('button', { name: 'Create the claim' }));
    expect(api.createClaim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ claimant: { name: '佐藤 花子' } }));
    await waitFor(() => expect(onSelectClaim).toHaveBeenCalledWith('c2'));
    expect(onClaimsChanged).toHaveBeenCalled();
  });

  it('異常: 読取が使えないと分かっていれば案内と設定への導線を出す', async () => {
    const { navigate } = renderTab({ selectedClaimId: 'c1', capabilities: { extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } } });
    expect(await screen.findByText('AI reading is not available yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Set the main model in Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
  });

  it('正常: 画像を読み取り、精算書の分割を行ごとに見せ、申請者の候補はチップで申請者欄へ入れ、下書きを確認フォームで保存する', async () => {
    const result: ExtractExpenseReceiptResultDto = {
      claimantHint: '鈴木 一郎', warnings: [],
      drafts: [
        { facts: { amount: 1200, description: '昼食代' }, source: { type: 'image', fileName: 'report.jpg' }, extraction: { method: 'llm', warnings: ['精算書の明細には日付が無いため入力してください', '登録番号の桁数が合いません'] } },
        { facts: { amount: 800, description: 'タクシー' }, source: { type: 'image', fileName: 'report.jpg' }, extraction: { method: 'llm', warnings: [] } },
      ],
    };
    const api = fakeApi({ extractReceipt: vi.fn().mockResolvedValue(result) });
    renderTab({ api, selectedClaimId: 'c1' });
    await screen.findByRole('heading', { name: '山田 太郎' });
    await userEvent.upload(screen.getByLabelText('Receipt images or PDFs'), new File(['x'], 'report.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Read with AI' }));
    expect(await screen.findByText('This expense report was split into 2 items. Review each one.')).toBeTruthy();
    expect(api.extractReceipt).toHaveBeenCalledWith(expect.anything(), { images: ['data:image/jpeg;base64,AAA'], fileName: 'report.jpg' }, expect.any(AbortSignal));

    await userEvent.click(screen.getByRole('button', { name: 'Use "鈴木 一郎" as the claimant' }));
    expect((screen.getByLabelText('Claimant name') as HTMLInputElement).value).toBe('鈴木 一郎');

    await userEvent.click(screen.getAllByRole('button', { name: 'Review in the form' })[0] as HTMLElement);
    // 警告のある欄（日付・登録番号）を強調し、値は読取のまま（日付を推測で埋めない）。
    expect(byId('expense-item-registrationNumber').closest('label')?.className).toContain('expense-warned');
    expect(byId('expense-item-transactionDate').closest('label')?.className).toContain('expense-warned');
    expect(byId('expense-item-transactionDate').value).toBe('');
    fireEvent.change(byId('expense-item-categoryId'), { target: { value: 'meal.meeting' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save the item' }));
    expect(api.saveItem).toHaveBeenCalledWith(expect.anything(), 'c1', expect.objectContaining({
      categoryId: 'meal.meeting', facts: { amount: 1200, description: '昼食代' }, source: { type: 'image', fileName: 'report.jpg' },
      receipt: { dataUrl: 'data:image/jpeg;base64,AAA', fileName: 'report.jpg' },
    }));
  });

  it('異常: 読取が 409 で断られたら原因と設定への導線を出す', async () => {
    const api = fakeApi({ extractReceipt: vi.fn().mockRejectedValue(new ApiError(409, 'JOURNAL_EXTRACTION_UNAVAILABLE', 'The main model does not accept images.')) });
    const { navigate } = renderTab({ api, selectedClaimId: 'c1' });
    await screen.findByRole('heading', { name: '山田 太郎' });
    await userEvent.upload(screen.getByLabelText('Receipt images or PDFs'), new File(['x'], 'r.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Read with AI' }));
    expect(await screen.findByText('AI reading is not available')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Set the main model in Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
  });

  it('異常: スキーマ違反（502）は別のモデルを試す案内', async () => {
    const api = fakeApi({ extractReceipt: vi.fn().mockRejectedValue(new ApiError(502, 'JOURNAL_EXTRACTION_SCHEMA', 'bad json')) });
    renderTab({ api, selectedClaimId: 'c1' });
    await screen.findByRole('heading', { name: '山田 太郎' });
    await userEvent.upload(screen.getByLabelText('Receipt images or PDFs'), new File(['x'], 'r.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Read with AI' }));
    expect(await screen.findByRole('button', { name: 'Try another model in Settings' })).toBeTruthy();
  });

  it('正常: 読み取りは中断でき、未読のファイルは一覧に残る', async () => {
    const api = fakeApi({
      extractReceipt: vi.fn((_scope: unknown, _input: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as ExpenseApi['extractReceipt'],
    });
    renderTab({ api, selectedClaimId: 'c1' });
    await screen.findByRole('heading', { name: '山田 太郎' });
    await userEvent.upload(screen.getByLabelText('Receipt images or PDFs'), new File(['x'], 'r.jpg', { type: 'image/jpeg' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Read with AI' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled. Files not read yet are still in the list; nothing was saved.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'r.jpg' })).toBeTruthy();
  });

  it('正常: 手入力は費目で必須の欄に印と上限を出し、「発行日を取引日にする」は issue-copied で保存する', async () => {
    const { api } = renderTab({ selectedClaimId: 'c1' });
    await screen.findByRole('heading', { name: '山田 太郎' });
    await userEvent.click(screen.getByRole('tab', { name: 'Manual entry' }));
    await userEvent.click(screen.getByRole('button', { name: 'New item' }));
    fireEvent.change(byId('expense-item-categoryId'), { target: { value: 'meal.meeting' } });
    expect(screen.getByText('Up to ¥10,000 per item')).toBeTruthy();
    expect(byId('expense-item-purpose').closest('label')?.querySelector('.expense-required')).toBeTruthy();
    expect(byId('expense-item-payeeName').closest('label')?.querySelector('.expense-required')).toBeNull();
    fireEvent.change(byId('expense-item-issueDate'), { target: { value: '2026-09-03' } });
    await userEvent.click(screen.getByRole('button', { name: 'Use the issue date as the transaction date' }));
    expect(byId('expense-item-transactionDate').value).toBe('2026-09-03');
    await userEvent.type(byId('expense-item-amount'), '2200');
    await userEvent.click(screen.getByRole('button', { name: 'Save the item' }));
    expect(api.saveItem).toHaveBeenCalledWith(expect.anything(), 'c1', {
      categoryId: 'meal.meeting', facts: { transactionDate: '2026-09-03', issueDate: '2026-09-03', amount: 2200, dateSource: 'issue-copied' }, source: { type: 'manual' },
    });
  });

  it('異常: 手入力の金額が数字でなければ保存せず欄の下に理由を出す', async () => {
    const { api } = renderTab({ selectedClaimId: 'c1' });
    await screen.findByRole('heading', { name: '山田 太郎' });
    await userEvent.click(screen.getByRole('tab', { name: 'Manual entry' }));
    await userEvent.click(screen.getByRole('button', { name: 'New item' }));
    await userEvent.type(byId('expense-item-amount'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save the item' }));
    expect(screen.getByText('Enter the amount as a whole number of yen (1 or more).')).toBeTruthy();
    expect(api.saveItem).not.toHaveBeenCalled();
  });

  it('正常: 理由カードの「金額を入力」から来たら、その明細を開いて金額欄へフォーカスする', async () => {
    renderTab({ selectedClaimId: 'c1', focus: { tab: 'ingest', section: 'item', id: 'c1', itemId: 'i1', field: 'amount', seq: 1 } });
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-item-amount'));
    expect(byId('expense-item-amount').value).toBe('1100');
  });

  it('正常: 読取の印（attendees-read）が付いた欄を人が直して保存すると、その印だけ外して送る（直していない purpose-read は残す）', async () => {
    const flagged: ExpenseClaimDto = { ...claim, items: [{ ...claim.items[0]!, source: { type: 'image', fileName: 'r.jpg' }, extraction: { method: 'llm', warnings: [], flags: ['attendees-read', 'purpose-read'] } }] };
    const api = fakeApi({ getClaim: vi.fn().mockResolvedValue(flagged), saveItem: vi.fn().mockResolvedValue(flagged) });
    renderTab({ api, selectedClaimId: 'c1', focus: { tab: 'ingest', section: 'item', id: 'c1', itemId: 'i1', field: 'amount', seq: 1 } });
    await waitFor(() => expect(byId('expense-item-amount').value).toBe('1100'));
    fireEvent.change(byId('expense-item-attendeesCount'), { target: { value: '3' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(api.saveItem).toHaveBeenCalledWith(expect.anything(), 'c1', expect.objectContaining({ itemId: 'i1', extraction: expect.objectContaining({ flags: ['purpose-read'] }) }));
  });

  it('正常: 導線「申請者を選ぶ」（claimant）から来たら、明細ではなく申請の編集フォームを開いて氏名欄へフォーカスする', async () => {
    renderTab({ selectedClaimId: 'c1', focus: { tab: 'ingest', section: 'claimant', id: 'c1', seq: 1 } });
    expect(await screen.findByRole('heading', { name: 'Edit the claim' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-claim-name'));
    expect(screen.queryByRole('region', { name: 'Item form' })).toBeNull();
  });

  it('境界: 導線「仮払の紐付けを開く」（advance-link）は明細フォームも申請の編集も開かない', async () => {
    renderTab({ selectedClaimId: 'c1', focus: { tab: 'ingest', section: 'advance-link', id: 'c1', seq: 1 } });
    await screen.findByRole('heading', { name: '山田 太郎' });
    expect(document.getElementById('expense-claim-advance-link')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Edit the claim' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Item form' })).toBeNull();
  });

  it('正常: 導線「区間を入力」（item-route）はその明細を開く', async () => {
    renderTab({ selectedClaimId: 'c1', focus: { tab: 'ingest', section: 'item-route', id: 'c1', itemId: 'i1', field: 'route', seq: 1 } });
    await waitFor(() => expect(byId('expense-item-amount').value).toBe('1100'));
  });

  it('正常: 明細の削除は確認ダイアログを挟む', async () => {
    const { api } = renderTab({ selectedClaimId: 'c1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 弁当' }));
    expect(api.deleteItem).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);
    expect(api.deleteItem).toHaveBeenCalledWith(expect.anything(), 'c1', 'i1');
  });

  it('正常: CSV は先頭 5 行をプレビューし、取込結果で列の対応（当たらない列も）と読み飛ばした行を見せる', async () => {
    const api = fakeApi({
      importCsv: vi.fn().mockResolvedValue({
        claims: [{ id: 'c3', claimant: { name: '山田' }, itemCount: 1, importedCount: 1, created: true }],
        skippedRows: [{ row: 3, reason: '列の数が見出しと合いません' }], warnings: [],
        columnMatches: [{ header: '日付', field: 'transactionDate' }, { header: '金額', field: 'amount' }, { header: 'メモ欄', field: null }],
      }),
    });
    const { onSelectClaim } = renderTab({ api, claims: [] });
    await userEvent.click(screen.getByRole('tab', { name: 'CSV' }));
    const content = '日付,金額,メモ欄\n2026-09-01,1200,x\n2026-09-02,800\n';
    await userEvent.upload(screen.getByLabelText('Expense CSV'), fileWithText('claims.csv', content, 'text/csv'));
    expect(await screen.findByRole('columnheader', { name: 'メモ欄' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '2026-09-02' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(api.importCsv).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ content, fileName: 'claims.csv' }));
    expect(await screen.findByRole('cell', { name: 'Transaction date' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '(not used)' })).toBeTruthy();
    expect(screen.getByText('1 rows were skipped')).toBeTruthy();
    expect(screen.getByText(/列の数が見出しと合いません/)).toBeTruthy();
    await waitFor(() => expect(onSelectClaim).toHaveBeenCalledWith('c3'));
  });
});
