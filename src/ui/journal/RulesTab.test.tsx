// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto, JournalDocumentSummaryDto, JournalRuleDto, SaveJournalRuleDto } from '../api/types';
import { RulesTab } from './RulesTab';

afterEach(cleanup);

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 2 },
    { id: 'old', name: '旧科目', category: 'expense', aliases: [], enabled: false, sortOrder: 3 },
  ],
  dimensions: [],
  taxCategories: [
    { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true },
    { code: 'JP-NA', name: '対象外', side: 'none', enabled: false },
  ],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function makeRule(overrides: Partial<JournalRuleDto> = {}): JournalRuleDto {
  return {
    id: 'r1', name: 'カフェ', enabled: true, mode: 'auto', priority: 10, scope: { direction: 'out' },
    conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
    outcome: { lines: [{ side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: 'total' }] },
    askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

const documents: readonly JournalDocumentSummaryDto[] = [
  { id: 'doc-1', kind: 'receipt', status: 'undecided', sourceType: 'structured', transactionDate: '2026-09-01', issuerName: 'サンプルカフェ', grandTotal: 1100, direction: 'out', createdAt: 'now', updatedAt: 'now' },
  { id: 'doc-2', kind: 'invoice', status: 'undecided', sourceType: 'structured', transactionDate: '2026-09-02', issuerName: 'サンプル商事', grandTotal: 67960, direction: 'out', createdAt: 'now', updatedAt: 'now' },
];

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listJournalDocuments: vi.fn().mockResolvedValue(documents),
    saveJournalRule: vi.fn().mockImplementation((_scope: unknown, rule: SaveJournalRuleDto) => Promise.resolve({ ...makeRule(), ...rule, id: rule.id ?? 'r-new' })),
    deleteJournalRule: vi.fn().mockResolvedValue(undefined),
    testJournalRule: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderTab(client: ToolApiClient, options: { readonly rules?: readonly JournalRuleDto[]; readonly draft?: SaveJournalRuleDto; readonly chart?: JournalChartOfAccountsDto } = {}) {
  const reloadRules = vi.fn().mockResolvedValue(undefined);
  render(<RulesTab client={client} chart={options.chart ?? chart} rules={options.rules ?? []} reloadRules={reloadRules}
    focus={undefined} draft={options.draft === undefined ? undefined : { rule: options.draft, seq: 1 }} />);
  return reloadRules;
}

describe('RulesTab', () => {
  it('正常: 一覧は優先度 → 特異度の順に並べる', async () => {
    const rules = [
      makeRule({ id: 'low', name: '低優先', priority: 1 }),
      makeRule({ id: 'wide', name: '同点・条件ゆるい', priority: 20, scope: {}, conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'a' }] }),
      makeRule({ id: 'narrow', name: '同点・条件きびしい', priority: 20, scope: { direction: 'out' }, conditions: [{ field: 'issuerName', op: 'equals', value: 'A' }, { field: 'descriptionNorm', op: 'contains', value: 'a' }] }),
    ];
    renderTab(stubClient(), { rules });

    const table = await screen.findByRole('table', { name: 'Rule list' });
    const names = within(table).getAllByRole('row').slice(1).map((row) => row.querySelector('button')?.textContent);
    expect(names).toEqual(['同点・条件きびしい', '同点・条件ゆるい', '低優先']);
  });

  it('境界: ルールが無いときは、判定からの「ルールを作る」か「新規」を案内する', async () => {
    renderTab(stubClient());
    expect(await screen.findByText(/No rules yet\./)).toBeTruthy();
  });

  it('異常: 名前なし・マスタに無い科目・不正な正規表現・between の片側だけ・貸方行なしを欄の下に指摘して保存しない', async () => {
    const client = stubClient();
    const broken: SaveJournalRuleDto = {
      name: ' ', enabled: true, mode: 'auto', priority: 0, scope: {},
      conditions: [{ field: 'descriptionNorm', op: 'regex', value: '(' }, { field: 'grandTotal', op: 'between', value: [5000, 0] }],
      outcome: { lines: [{ side: 'debit', accountId: 'ghost', taxCode: 'JP-IN-10-S', amount: 'total' }] },
      askIf: [], requiredFacts: [],
    };
    renderTab(client, { draft: broken });
    await userEvent.click(await screen.findByRole('button', { name: 'Save rule' }));

    expect(await screen.findByText('Enter a rule name')).toBeTruthy();
    expect(screen.getByText('The regular expression is invalid')).toBeTruthy();
    expect(screen.getByText('Enter the range as "min, max" (both numbers, min first)')).toBeTruthy();
    expect(screen.getByText("Account 'ghost' is not an enabled account in the chart")).toBeTruthy();
    expect(screen.getByText('Add a credit line')).toBeTruthy();
    expect(screen.getByText('Fix the highlighted fields before saving.')).toBeTruthy();
    expect(client.saveJournalRule).not.toHaveBeenCalled();
  });

  it('異常: 無効化された科目・税区分は選べない（セレクトは科目マスタから作る）', async () => {
    renderTab(stubClient(), { draft: { ...makeRule(), id: undefined } as unknown as SaveJournalRuleDto });

    const account = await screen.findByLabelText('Line 1 account');
    const accountOptions = within(account).getAllByRole('option').map((option) => option.textContent);
    expect(accountOptions).toContain('会議費');
    expect(accountOptions).toContain('現金');
    expect(accountOptions).not.toContain('旧科目');

    const tax = screen.getByLabelText('Line 1 tax');
    const taxOptions = within(tax).getAllByRole('option').map((option) => option.textContent);
    expect(taxOptions).toContain('課税仕入 10% (JP-IN-10-S)');
    expect(taxOptions.some((option) => option?.includes('JP-NA'))).toBe(false);
  });

  it('正常: 整ったルールは保存され、次の一手（再判定）を案内する', async () => {
    const client = stubClient();
    const reloadRules = renderTab(client, { draft: { ...makeRule(), id: undefined, name: '電気料金' } as unknown as SaveJournalRuleDto });
    await userEvent.click(await screen.findByRole('button', { name: 'Save rule' }));

    await waitFor(() => expect(client.saveJournalRule).toHaveBeenCalled());
    expect((client.saveJournalRule as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ name: '電気料金' });
    expect(await screen.findByText(/Judge the pending documents again from the Judge tab/)).toBeTruthy();
    expect(reloadRules).toHaveBeenCalled();
  });

  it('正常: 「文書でテスト」は文書ごとに一致 / 不一致と仕訳・理由を出す', async () => {
    const testJournalRule = vi.fn().mockResolvedValue([
      { documentId: 'doc-1', matched: true, specificity: 4, entry: { date: '2026-09-01', description: 'コーヒー', invoiceStatus: 'not_required', lines: [{ side: 'debit', accountId: 'meeting', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100 }] } },
      { documentId: 'doc-2', matched: false, reasons: [{ code: 'no-rule' }] },
    ]);
    const client = stubClient({ testJournalRule });
    renderTab(client, { draft: { ...makeRule(), id: undefined } as unknown as SaveJournalRuleDto });

    await userEvent.click(await screen.findByRole('button', { name: 'Test against documents' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /サンプルカフェ/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /サンプル商事/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));

    await waitFor(() => expect(testJournalRule).toHaveBeenCalled());
    expect(testJournalRule.mock.calls[0]?.[1]).toMatchObject({ documentIds: ['doc-1', 'doc-2'] });
    const table = await screen.findByRole('table', { name: 'Test results' });
    expect(within(table).getByText(/Yes \(4\)/)).toBeTruthy();
    expect(within(table).getByText('No')).toBeTruthy();
    expect(within(table).getByText(/会議費/)).toBeTruthy();
    expect(within(table).getByText('No matching rule')).toBeTruthy();
  });

  it('異常: 文書を選ばずにテストを実行したら、先に選ぶよう促す', async () => {
    const client = stubClient();
    renderTab(client, { draft: { ...makeRule(), id: undefined } as unknown as SaveJournalRuleDto });
    await userEvent.click(await screen.findByRole('button', { name: 'Test against documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Run test' }));

    expect(await screen.findByText('Pick at least one document.')).toBeTruthy();
    expect(client.testJournalRule).not.toHaveBeenCalled();
  });

  it('例外: テスト対象の文書一覧が取れなくてもテスト欄は開ける', async () => {
    renderTab(stubClient({ listJournalDocuments: vi.fn().mockRejectedValue(new Error('documents down')) }), { draft: { ...makeRule(), id: undefined } as unknown as SaveJournalRuleDto });
    await userEvent.click(await screen.findByRole('button', { name: 'Test against documents' }));
    expect(await screen.findByText('documents down')).toBeTruthy();
    expect(await screen.findByText('No documents to test against.')).toBeTruthy();
  });

  it('境界: 削除は確認ダイアログを経由し、キャンセルすれば消さない', async () => {
    const client = stubClient();
    const reloadRules = renderTab(client, { rules: [makeRule()] });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('カフェ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(client.deleteJournalRule).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteJournalRule).toHaveBeenCalledWith('r1', expect.anything()));
    expect(reloadRules).toHaveBeenCalled();
  });

  it('例外: 保存がサーバーで失敗したらその理由を編集欄の近くに出す', async () => {
    const client = stubClient({ saveJournalRule: vi.fn().mockRejectedValue(new Error('JOURNAL_RULE_INVALID: duplicate name')) });
    renderTab(client, { draft: { ...makeRule(), id: undefined } as unknown as SaveJournalRuleDto });
    await userEvent.click(await screen.findByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText('JOURNAL_RULE_INVALID: duplicate name')).toBeTruthy();
  });

  it('境界: 科目マスタが未読込のときは、科目をまだ選べないことを知らせる', async () => {
    render(<RulesTab client={stubClient()} chart={undefined} rules={[]} reloadRules={vi.fn().mockResolvedValue(undefined)} focus={undefined} draft={undefined} />);
    expect(await screen.findByText(/The chart of accounts is not loaded/)).toBeTruthy();
  });
});

describe('RulesTab（仕訳行・条件・対象帳票の編集）', () => {
  const draft: SaveJournalRuleDto = {
    name: '編集用', enabled: true, mode: 'auto', priority: 0, scope: {},
    conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
    outcome: { lines: [
      { side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total' },
      { side: 'credit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: 'total' },
    ] },
    askIf: [], requiredFacts: [],
  };

  it('正常: 仕訳行の貸借・科目・税区分・金額の指定を切り替えられる', async () => {
    renderTab(stubClient(), { draft });

    const side = await screen.findByLabelText('Line 1 side');
    await userEvent.selectOptions(side, 'credit');
    expect((side as HTMLSelectElement).value).toBe('credit');

    const account = screen.getByLabelText('Line 1 account');
    await userEvent.selectOptions(account, 'cash');
    expect((account as HTMLSelectElement).value).toBe('cash');

    const amount = screen.getByLabelText('Line 1 amount');
    await userEvent.selectOptions(amount, 'taxable:10');
    expect((amount as HTMLSelectElement).value).toBe('taxable:10');
  });

  it('境界: 金額を固定額にすると値の入力欄が出る（それ以外の指定では出さない）', async () => {
    renderTab(stubClient(), { draft });

    expect(screen.queryByLabelText('Line 1 amount value')).toBeNull();
    await userEvent.selectOptions(await screen.findByLabelText('Line 1 amount'), 'fixed');
    const value = screen.getByLabelText('Line 1 amount value');
    await userEvent.type(value, '1000');
    expect((value as HTMLInputElement).value).toContain('1000');
  });

  it('正常: 条件の項目・演算・値を編集できる', async () => {
    renderTab(stubClient(), { draft });

    const field = await screen.findByLabelText('Condition 1 field');
    await userEvent.clear(field);
    await userEvent.type(field, 'issuerName');
    expect((field as HTMLInputElement).value).toBe('issuerName');

    const operator = screen.getByLabelText('Condition 1 operator');
    await userEvent.selectOptions(operator, 'equals');
    expect((operator as HTMLSelectElement).value).toBe('equals');

    const value = screen.getByLabelText('Condition 1 value');
    await userEvent.clear(value);
    await userEvent.type(value, 'サンプル商事');
    expect((value as HTMLInputElement).value).toBe('サンプル商事');
  });

  it('境界: 存在を見るだけの演算（exists）では値の入力欄を出さない', async () => {
    renderTab(stubClient(), { draft });

    await userEvent.selectOptions(await screen.findByLabelText('Condition 1 operator'), 'exists');
    expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
  });

  it('正常: 対象帳票の種別は付け外しでき、全て外すと種別の指定なしに戻る', async () => {
    renderTab(stubClient(), { draft });

    const invoice = (await screen.findAllByRole('checkbox')).find((box) => (box as HTMLInputElement).checked === false);
    expect(invoice).toBeTruthy();
    if (invoice === undefined) return;
    await userEvent.click(invoice);
    expect((invoice as HTMLInputElement).checked).toBe(true);
    await userEvent.click(invoice);
    expect((invoice as HTMLInputElement).checked).toBe(false);
  });
});
