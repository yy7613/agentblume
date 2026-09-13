// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalAccountDto, JournalChartOfAccountsDto, SaveJournalChartOfAccountsDto } from '../api/types';
import { ChartTab } from './ChartTab';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(URL as unknown as Record<string, unknown>, 'createObjectURL');
  Reflect.deleteProperty(URL as unknown as Record<string, unknown>, 'revokeObjectURL');
  vi.restoreAllMocks();
});

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: ['小口現金'], enabled: true, sortOrder: 1 },
    { id: 'meeting', name: '会議費', category: 'expense', defaultTaxCode: 'JP-IN-10-S', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [],
  taxCategories: [
    { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true, mapping: { yayoi: '課対仕入10%' } },
    { code: 'JP-NA', name: '対象外', side: 'none', enabled: true },
  ],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    saveJournalChart: vi.fn().mockImplementation((_scope: unknown, saved: SaveJournalChartOfAccountsDto) => Promise.resolve({ ...saved, updatedAt: '2026-09-02T00:00:00.000Z' })),
    resetJournalChart: vi.fn().mockResolvedValue({ ...chart, accounts: [chart.accounts[0]!], updatedAt: '2026-09-03T00:00:00.000Z' }),
    exportJournalChartCsv: vi.fn().mockResolvedValue('id,code,name,category\r\ncash,,現金,asset\r\n'),
    importJournalChartCsv: vi.fn().mockResolvedValue({ ...chart, updatedAt: '2026-09-04T00:00:00.000Z' }),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderTab(client: ToolApiClient, options: { readonly chart?: JournalChartOfAccountsDto | undefined; readonly focus?: { readonly id: string; readonly seq: number } } = {}) {
  const onChartChanged = vi.fn();
  render(<ChartTab client={client} chart={'chart' in options ? options.chart : chart} onChartChanged={onChartChanged} focus={options.focus} />);
  return onChartChanged;
}

function savedPayload(client: ToolApiClient): SaveJournalChartOfAccountsDto {
  return (client.saveJournalChart as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as SaveJournalChartOfAccountsDto;
}

function csvFile(name: string, content: string): File {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], name, { type: 'text/csv' });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
  return file;
}

describe('ChartTab', () => {
  it('境界: 科目マスタがまだ無いときは読み込み中を出す', () => {
    renderTab(stubClient(), { chart: undefined });
    expect(screen.getByText('Loading the chart of accounts…')).toBeTruthy();
  });

  it('正常: 科目を追加して保存すると、新しい科目がマスタに載る', async () => {
    const client = stubClient();
    const onChartChanged = renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await userEvent.type(screen.getByLabelText('Account 3 name'), '通信費');
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    await waitFor(() => expect(client.saveJournalChart).toHaveBeenCalled());
    const added = savedPayload(client).accounts.find((account) => account.name === '通信費');
    expect(added).toMatchObject({ id: 'acct-3', category: 'expense', enabled: true, sortOrder: 3 });
    expect(await screen.findByText('Chart saved.')).toBeTruthy();
    expect(onChartChanged).toHaveBeenCalled();
  });

  it('異常: 科目 ID が重複したら保存せず、その欄の下と要約に問題を出す', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.clear(screen.getByLabelText('Account 2 id'));
    await userEvent.type(screen.getByLabelText('Account 2 id'), 'cash');
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    expect(await screen.findByText("Account id 'cash' is duplicated (row 1)")).toBeTruthy();
    expect(screen.getByText(/1 problem\(s\):/)).toBeTruthy();
    expect(client.saveJournalChart).not.toHaveBeenCalled();
  });

  it('正常: 名前を変えて保存すると、新しいマスタが画面全体へ配られる（科目セレクトの表示が変わる）', async () => {
    const client = stubClient();
    const onChartChanged = renderTab(client);
    await userEvent.clear(screen.getByLabelText('Account 2 name'));
    await userEvent.type(screen.getByLabelText('Account 2 name'), '打合せ費');
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    await waitFor(() => expect(onChartChanged).toHaveBeenCalled());
    const delivered = onChartChanged.mock.calls[0]?.[0] as JournalChartOfAccountsDto;
    expect(delivered.accounts.find((account) => account.id === 'meeting')?.name).toBe('打合せ費');
  });

  it('正常: 科目を無効化して保存すると enabled: false になる（ルール編集の選択肢から消える）', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByLabelText('Account 2 enabled'));
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    await waitFor(() => expect(client.saveJournalChart).toHaveBeenCalled());
    expect(savedPayload(client).accounts.find((account) => account.id === 'meeting')?.enabled).toBe(false);
  });

  it('正常: 並べ替えのボタンで sortOrder が入れ替わる', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Move 会議費 up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    await waitFor(() => expect(client.saveJournalChart).toHaveBeenCalled());
    const order = Object.fromEntries(savedPayload(client).accounts.map((account: JournalAccountDto) => [account.id, account.sortOrder]));
    expect(order).toEqual({ meeting: 1, cash: 2 });
  });

  it('境界: 先頭の科目を上へ動かしても順序は変わらない', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Move 現金 up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    await waitFor(() => expect(client.saveJournalChart).toHaveBeenCalled());
    const order = Object.fromEntries(savedPayload(client).accounts.map((account: JournalAccountDto) => [account.id, account.sortOrder]));
    expect(order).toEqual({ cash: 1, meeting: 2 });
  });

  it('正常: 税区分の弥生 / freee / MF の対応名を読み書きできる', async () => {
    const client = stubClient();
    renderTab(client);
    expect((screen.getByLabelText('Tax 1 yayoi name') as HTMLInputElement).value).toBe('課対仕入10%');
    await userEvent.type(screen.getByLabelText('Tax 1 freee name'), '課対仕入10%');
    await userEvent.type(screen.getByLabelText('Tax 1 mf name'), '課仕 10%');
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));

    await waitFor(() => expect(client.saveJournalChart).toHaveBeenCalled());
    expect(savedPayload(client).taxCategories[0]?.mapping).toEqual({ yayoi: '課対仕入10%', freee: '課対仕入10%', mf: '課仕 10%' });
  });

  it('境界: 「標準に戻す」は確認ダイアログを経由し、キャンセルすれば戻さない', async () => {
    const client = stubClient();
    const onChartChanged = renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Restore standard set' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('replaced by the standard set');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(client.resetJournalChart).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Restore standard set' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.resetJournalChart).toHaveBeenCalled());
    expect(await screen.findByText('Restored the standard chart.')).toBeTruthy();
    expect(onChartChanged).toHaveBeenCalled();
  });

  it('正常: CSV 出力は内容を欄に出し、ダウンロードを起こす', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:chart');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { /* jsdom は遷移しない。 */ });

    renderTab(stubClient());
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    const textarea = await screen.findByLabelText('Chart CSV') as HTMLTextAreaElement;
    expect(textarea.value).toContain('cash,,現金,asset');
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(screen.queryByText(/did not start a download/)).toBeNull();
  });

  it('異常: 壊れた行を含む CSV の取込はその理由を出し、マスタを差し替えない', async () => {
    const client = stubClient({ importJournalChartCsv: vi.fn().mockRejectedValue(new Error('row 3: category "資産" is not one of asset/liability/equity/revenue/expense/other')) });
    const onChartChanged = renderTab(client);
    await userEvent.upload(screen.getByLabelText('Chart CSV file'), csvFile('chart.csv', 'id,name,category\r\nx,壊れた行,資産\r\n'));

    expect(await screen.findByText(/row 3: category "資産" is not one of/)).toBeTruthy();
    expect(onChartChanged).not.toHaveBeenCalled();
  });

  it('正常: CSV 取込に成功したら取り込んだファイル名を知らせ、新しいマスタを配る', async () => {
    const client = stubClient();
    const onChartChanged = renderTab(client);
    await userEvent.upload(screen.getByLabelText('Chart CSV file'), csvFile('chart.csv', 'id,name,category\r\ncash,現金,asset\r\n'));

    await waitFor(() => expect(client.importJournalChartCsv).toHaveBeenCalled());
    expect(await screen.findByText('Imported chart.csv.')).toBeTruthy();
    expect(onChartChanged).toHaveBeenCalled();
  });

  it('正常: 判定タブから渡された科目 id がマスタに無ければ、その id での追加を促す', async () => {
    const client = stubClient();
    renderTab(client, { focus: { id: 'ghost', seq: 1 } });
    expect(await screen.findByText('Account "ghost" is not in the chart.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add account "ghost"' }));
    await userEvent.type(screen.getByLabelText('Account 3 name'), '幽霊科目');
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));
    await waitFor(() => expect(client.saveJournalChart).toHaveBeenCalled());
    expect(savedPayload(client).accounts.some((account) => account.id === 'ghost')).toBe(true);
  });

  it('例外: 保存がサーバーで失敗したらその理由を出す', async () => {
    const client = stubClient({ saveJournalChart: vi.fn().mockRejectedValue(new Error('JOURNAL_CHART_INVALID: account in use')) });
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Save chart' }));
    expect(await screen.findByText('JOURNAL_CHART_INVALID: account in use')).toBeTruthy();
  });
});

describe('ChartTab（科目行の各項目を編集する）', () => {
  it('正常: 名前・コード・区分・既定税区分・別名・有効を編集すると、その場の表示に反映される', async () => {
    renderTab(stubClient(), {});

    const name = await screen.findByLabelText('Account 1 name');
    await userEvent.clear(name);
    await userEvent.type(name, '現金（小口）');
    expect((name as HTMLInputElement).value).toBe('現金（小口）');

    const code = screen.getByLabelText('Account 1 code');
    await userEvent.type(code, '100');
    expect((code as HTMLInputElement).value).toBe('100');

    await userEvent.selectOptions(screen.getByLabelText('Account 1 category'), 'expense');
    expect((screen.getByLabelText('Account 1 category') as HTMLSelectElement).value).toBe('expense');

    await userEvent.selectOptions(screen.getByLabelText('Account 1 default tax'), 'JP-IN-10-S');
    expect((screen.getByLabelText('Account 1 default tax') as HTMLSelectElement).value).toBe('JP-IN-10-S');

    const aliases = screen.getByLabelText('Account 1 aliases');
    await userEvent.clear(aliases);
    await userEvent.type(aliases, '小口現金, キャッシュ');
    // 入力のたびに別名を配列へ解釈して結合し直すので、区切りの見た目ではなく中身が残ることを見る。
    expect((aliases as HTMLInputElement).value).toContain('小口現金');
    expect((aliases as HTMLInputElement).value).toContain('キャッシュ');

    const enabled = screen.getByLabelText('Account 1 enabled') as HTMLInputElement;
    await userEvent.click(enabled);
    expect(enabled.checked).toBe(false);
  });

  it('境界: 税区分行の名前と区分も編集できる（科目だけでなく税区分マスタも利用者が定義する）', async () => {
    renderTab(stubClient(), {});

    const taxName = await screen.findByLabelText('Tax 1 name');
    await userEvent.clear(taxName);
    await userEvent.type(taxName, '課税仕入 10％（標準）');
    expect((taxName as HTMLInputElement).value).toBe('課税仕入 10％（標準）');
  });
});
