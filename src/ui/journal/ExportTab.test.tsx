// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalChartOfAccountsDto, JournalEntryDto, SaveJournalEntryDto } from '../api/types';
import { ExportTab } from './ExportTab';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(URL as unknown as Record<string, unknown>, 'createObjectURL');
  Reflect.deleteProperty(URL as unknown as Record<string, unknown>, 'revokeObjectURL');
  vi.restoreAllMocks();
});

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 2 },
  ],
  dimensions: [],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const draftEntry: JournalEntryDto = {
  id: 'entry-1', date: '2026-09-01', description: 'コーヒー', invoiceStatus: 'not_required', status: 'draft', decidedBy: 'rule', documentId: 'doc-1', ruleId: 'r1',
  lines: [{ side: 'debit', accountId: 'meeting', accountName: '古い名前', taxCode: 'JP-IN-10-S', amount: 1100 }, { side: 'credit', accountId: 'cash', accountName: '現金', taxCode: 'JP-IN-10-S', amount: 1100 }],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

const exportResult = { format: 'generic' as const, fileName: 'journal-generic-2026-09.csv', content: '日付,借方科目,金額\r\n2026-09-01,会議費,1100\r\n', entryCount: 3, encoding: 'utf-8' as const, warnings: [] as readonly string[] };

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listJournalEntries: vi.fn().mockResolvedValue([draftEntry]),
    confirmJournalEntry: vi.fn().mockResolvedValue({ ...draftEntry, status: 'confirmed' }),
    deleteJournalEntry: vi.fn().mockResolvedValue(undefined),
    saveJournalEntry: vi.fn().mockImplementation((_scope: unknown, entry: SaveJournalEntryDto) => Promise.resolve({ ...draftEntry, ...entry, id: 'entry-9' })),
    exportJournalEntries: vi.fn().mockResolvedValue(exportResult),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderTab(client: ToolApiClient, focus?: { readonly id: string; readonly seq: number }) {
  render(<ExportTab client={client} chart={chart} focus={focus} />);
}

function stubDownload() {
  const createObjectURL = vi.fn().mockReturnValue('blob:entries');
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { /* jsdom は遷移しない。 */ });
  return { createObjectURL, click };
}

/** 貸借の揃った手入力を 1 件ぶん埋める。 */
async function fillManualEntry(amounts: { readonly debit: string; readonly credit: string }) {
  await userEvent.type(screen.getByLabelText('Entry date'), '2026-09-01');
  await userEvent.type(screen.getByLabelText('Entry description'), '打合せのコーヒー');
  await userEvent.selectOptions(screen.getByLabelText('Manual line 1 account'), 'meeting');
  await userEvent.selectOptions(screen.getByLabelText('Manual line 1 tax'), 'JP-IN-10-S');
  await userEvent.type(screen.getByLabelText('Manual line 1 amount'), amounts.debit);
  await userEvent.selectOptions(screen.getByLabelText('Manual line 2 account'), 'cash');
  await userEvent.selectOptions(screen.getByLabelText('Manual line 2 tax'), 'JP-IN-10-S');
  await userEvent.type(screen.getByLabelText('Manual line 2 amount'), amounts.credit);
}

describe('ExportTab: この条件をツールにする', () => {
  /** 一覧の初回読み込みを待ってから操作する（act 警告を避ける）。 */
  async function renderReady(client: ToolApiClient) {
    renderTab(client);
    await waitFor(() => expect(client.listJournalEntries).toHaveBeenCalled());
  }

  it('正常: いまの絞り込みを焼き込んだ読み取り専用ツールとして保存する', async () => {
    const saveTool = vi.fn().mockResolvedValue({});
    const client = stubClient({ saveTool });
    await renderReady(client);

    await userEvent.selectOptions(screen.getByLabelText('Entry status filter'), 'confirmed');
    await userEvent.type(screen.getByLabelText('From date'), '2026-09-01');
    await userEvent.type(screen.getByLabelText('To date'), '2026-09-30');
    await userEvent.type(screen.getByLabelText('Tool name'), 'monthly_supplies');
    await userEvent.click(screen.getByRole('button', { name: 'Save as tool' }));

    await waitFor(() => expect(saveTool).toHaveBeenCalled());
    const sent = saveTool.mock.calls[0]?.[0] as { publishName: string; sideEffect: string; graph: { nodes: { type: string; config: unknown }[] }; agentTool: { name: string } };
    expect(sent.publishName).toBe('monthly_supplies');
    expect(sent.agentTool.name).toBe('monthly_supplies');
    expect(sent.sideEffect).toBe('read-only');
    expect(sent.graph.nodes[0]?.config).toMatchObject({ status: 'confirmed', from: '2026-09-01', to: '2026-09-30' });
    // 保存できたことと、次にどこで使うかを伝える。
    expect(await screen.findByText(/Saved the tool monthly_supplies/)).toBeTruthy();
    expect((screen.getByLabelText('Tool name') as HTMLInputElement).value).toBe('');
  });

  it('境界: 関数名に使えない文字を含む名前は、呼ばれる名前を先に知らせる', async () => {
    const client = stubClient({ saveTool: vi.fn().mockResolvedValue({}) });
    await renderReady(client);
    await userEvent.type(screen.getByLabelText('Tool name'), 'monthly 消耗品費');
    expect(screen.getByText('The agent will call it as monthly.')).toBeTruthy();
  });

  it('異常: 名前が空のまま押しても保存せず、理由を出す', async () => {
    const saveTool = vi.fn();
    const client = stubClient({ saveTool });
    await renderReady(client);
    await userEvent.click(screen.getByRole('button', { name: 'Save as tool' }));
    expect(saveTool).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a name/)).toBeTruthy();
  });

  it('異常: 期間の形式が誤っていれば保存を投げない', async () => {
    const saveTool = vi.fn();
    const client = stubClient({ saveTool });
    await renderReady(client);
    await userEvent.type(screen.getByLabelText('From date'), '2026/09/01');
    await userEvent.type(screen.getByLabelText('Tool name'), 'bad_range');
    await userEvent.click(screen.getByRole('button', { name: 'Save as tool' }));
    expect(saveTool).not.toHaveBeenCalled();
    expect(screen.getByText(/YYYY-MM-DD/)).toBeTruthy();
  });

  it('例外: 保存が失敗しても落ちず、原因を出して操作を続けられる', async () => {
    const saveTool = vi.fn().mockRejectedValue(new Error('tool name is already taken'));
    const client = stubClient({ saveTool });
    await renderReady(client);
    await userEvent.type(screen.getByLabelText('Tool name'), 'dup_name');
    await userEvent.click(screen.getByRole('button', { name: 'Save as tool' }));
    expect(await screen.findByText('tool name is already taken')).toBeTruthy();
    // 入力は残り、直して押し直せる。
    expect((screen.getByLabelText('Tool name') as HTMLInputElement).value).toBe('dup_name');
    expect(screen.getByRole('button', { name: 'Save as tool' })).toBeTruthy();
  });
});

describe('ExportTab', () => {
  it('正常: 仕訳一覧を出し、状態の絞り込みをサーバーへ渡す', async () => {
    const client = stubClient();
    renderTab(client);
    await waitFor(() => expect(client.listJournalEntries).toHaveBeenCalledWith(expect.anything(), { status: '', from: '', to: '' }));
    expect(await screen.findByRole('button', { name: 'コーヒー' })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Entry status filter'), 'draft');
    await waitFor(() => expect(client.listJournalEntries).toHaveBeenCalledWith(expect.anything(), { status: 'draft', from: '', to: '' }));
  });

  it('正常: 行を開くと仕訳行を科目マスタの名前で出す', async () => {
    renderTab(stubClient());
    await userEvent.click(await screen.findByRole('button', { name: 'コーヒー' }));

    const lines = await screen.findByRole('table', { name: 'Lines of entry-1' });
    expect(within(lines).getByText('会議費')).toBeTruthy();
    expect(within(lines).queryByText('古い名前')).toBeNull();
    expect(within(lines).getAllByText('¥1,100')).toHaveLength(2);
  });

  it('境界: 仕訳が 0 件なら、判定するか手入力するよう案内する', async () => {
    renderTab(stubClient({ listJournalEntries: vi.fn().mockResolvedValue([]) }));
    expect(await screen.findByText(/No entries\. Judge documents in the Judge tab/)).toBeTruthy();
  });

  it('正常: ドラフトを確定できる', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(client.confirmJournalEntry).toHaveBeenCalledWith('entry-1', expect.anything()));
  });

  it('境界: 削除は確認ダイアログを経由し、キャンセルすれば消さない', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('コーヒー');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(client.deleteJournalEntry).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteJournalEntry).toHaveBeenCalledWith('entry-1', expect.anything()));
  });

  it('異常: 貸借の合わない手入力は保存せず、差額を示して直し方を出す', async () => {
    const client = stubClient();
    renderTab(client);
    await fillManualEntry({ debit: '1100', credit: '900' });
    await userEvent.click(screen.getByRole('button', { name: 'Save entry' }));

    // 差額は行の下（FieldError）と保存ボタンの近く（InlineFeedback）の両方に出す。
    expect(await screen.findAllByText(/Debit ¥1,100 and credit ¥900 differ/)).toHaveLength(2);
    expect(client.saveJournalEntry).not.toHaveBeenCalled();
  });

  it('異常: 日付形式と金額の誤りを欄の下に出す', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.type(screen.getByLabelText('Entry date'), '2026/09/01');
    await userEvent.type(screen.getByLabelText('Manual line 1 amount'), '1100.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save entry' }));

    expect(await screen.findByText('Use YYYY-MM-DD')).toBeTruthy();
    expect(screen.getAllByText('Enter a positive integer amount').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Choose an account').length).toBe(2);
    expect(client.saveJournalEntry).not.toHaveBeenCalled();
  });

  it('正常: 貸借の揃った手入力はドラフトとして保存され、一覧を読み直す', async () => {
    const client = stubClient();
    renderTab(client);
    await fillManualEntry({ debit: '1100', credit: '1100' });
    await userEvent.click(screen.getByRole('button', { name: 'Save entry' }));

    await waitFor(() => expect(client.saveJournalEntry).toHaveBeenCalled());
    const payload = (client.saveJournalEntry as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as SaveJournalEntryDto;
    expect(payload).toMatchObject({ date: '2026-09-01', description: '打合せのコーヒー', decidedBy: 'manual' });
    expect(payload.lines).toEqual([
      { side: 'debit', accountId: 'meeting', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100 },
      { side: 'credit', accountId: 'cash', accountName: '現金', taxCode: 'JP-IN-10-S', amount: 1100 },
    ]);
    expect(await screen.findByText(/Saved entry entry-9 as a draft/)).toBeTruthy();
    await waitFor(() => expect((client.listJournalEntries as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it('正常: 出力はファイル名と件数を出し、Blob のダウンロードを起こす', async () => {
    const { createObjectURL, click } = stubDownload();
    const client = stubClient();
    renderTab(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    await waitFor(() => expect(client.exportJournalEntries).toHaveBeenCalled());
    expect((client.exportJournalEntries as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ format: 'generic', markExported: false });
    expect(await screen.findByText('journal-generic-2026-09.csv · 3 entries · UTF-8')).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(screen.queryByText(/did not start a download/)).toBeNull();
  });

  it('例外: URL.createObjectURL が無い環境でも落ちず、テキストエリアへの退避を案内する', async () => {
    // jsdom は createObjectURL を持つので、持たない環境（古い WebView・埋め込みブラウザ）を再現する。
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true, writable: true });
    renderTab(stubClient());
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    expect(await screen.findByText(/The browser did not start a download/)).toBeTruthy();
    // textarea の value は仕様上 CRLF が LF に正規化される（CSV そのものは CRLF のままサーバーから届く）。
    expect(((await screen.findByLabelText('Exported CSV')) as HTMLTextAreaElement).value).toBe(exportResult.content.replace(/\r\n/g, '\n'));
  });

  it('正常: 「出力済にする」を選ぶと markExported がサーバーへ渡り、一覧を読み直す', async () => {
    stubDownload();
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByRole('checkbox', { name: /Mark exported entries/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(client.exportJournalEntries).toHaveBeenCalled());
    expect((client.exportJournalEntries as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ markExported: true });
    await waitFor(() => expect((client.listJournalEntries as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it('正常: 判定タブから渡された仕訳 id は最初から開いた状態にする', async () => {
    renderTab(stubClient(), { id: 'entry-1', seq: 1 });
    expect(await screen.findByRole('table', { name: 'Lines of entry-1' })).toBeTruthy();
  });

  it('例外: 一覧の取得が失敗したらエラーと再試行ボタンを出す', async () => {
    const listJournalEntries = vi.fn().mockRejectedValueOnce(new Error('entries down')).mockResolvedValue([draftEntry]);
    renderTab(stubClient({ listJournalEntries }));
    expect(await screen.findByText(/entries down/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'コーヒー' })).toBeTruthy();
  });

  it('例外: 出力がサーバーで失敗したらその理由を出す', async () => {
    renderTab(stubClient({ exportJournalEntries: vi.fn().mockRejectedValue(new Error('JOURNAL_EXPORT_EMPTY: no entries in range')) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByText('JOURNAL_EXPORT_EMPTY: no entries in range')).toBeTruthy();
  });

  it('正常: 4 形式すべて選べ（無効な選択肢が無く）、選んだ形式をサーバーへ渡す', async () => {
    stubDownload();
    const client = stubClient();
    renderTab(client);

    const select = screen.getByLabelText('Export format') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['generic', 'yayoi', 'freee', 'mf']);
    expect(Array.from(select.options).some((option) => option.disabled)).toBe(false);

    await userEvent.selectOptions(select, 'yayoi');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect((client.exportJournalEntries as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ format: 'yayoi' }));
  });

  it('正常: Shift-JIS の出力は contentBase64 のバイト列から Blob を作る（charset を付けない）', async () => {
    const { createObjectURL, click } = stubDownload();
    const yayoi = { format: 'yayoi' as const, fileName: 'journal-yayoi-2026-09-13.csv', content: '2000,000123', contentBase64: 'g2U=', encoding: 'shift_jis' as const, warnings: [] as readonly string[] };
    renderTab(stubClient({ exportJournalEntries: vi.fn().mockResolvedValue(yayoi) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('text/csv');
    expect(blob.size).toBe(2);
    expect(click).toHaveBeenCalled();
    // 受け取った文字コードは画面にも出す。テキストエリアは読める本文（バイト列ではない）。
    expect(await screen.findByText(/· Shift-JIS/)).toBeTruthy();
    expect(((await screen.findByLabelText('Exported CSV')) as HTMLTextAreaElement).value).toBe('2000,000123');
  });

  it('異常: サーバーが返した警告は取り込む前の注意として並べる', async () => {
    stubDownload();
    const warned = { ...exportResult, warnings: ['税区分 JP-IN-10-S に弥生の対応名が無いため、内部コードのまま出力しました。', '仕訳 J-1 の摘要が 64 文字を超えたため末尾を切り詰めました。'] };
    renderTab(stubClient({ exportJournalEntries: vi.fn().mockResolvedValue(warned) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    expect(await screen.findByText(/Check these before importing/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/内部コードのまま出力しました/)).toBeTruthy();
  });

  it('[回帰固定] 境界: 警告が無ければ注意書きを出さない', async () => {
    stubDownload();
    renderTab(stubClient());
    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    expect(await screen.findByText(/journal-generic-2026-09\.csv/)).toBeTruthy();
    expect(screen.queryByText(/Check these before importing/)).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
