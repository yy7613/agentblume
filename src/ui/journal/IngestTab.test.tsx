// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { JournalCapabilitiesDto, JournalChartOfAccountsDto, JournalCsvPresetDto, JournalDocumentDto } from '../api/types';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { IngestTab } from './IngestTab';

afterEach(() => { cleanup(); consumePendingOpen('Settings'); });

const chart: JournalChartOfAccountsDto = {
  accounts: [{ id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 }],
  dimensions: [],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const presets: readonly JournalCsvPresetDto[] = [
  { id: 'generic', name: '汎用', description: '日付・摘要・出金・入金・残高', headerSignature: ['日付', '摘要', '出金', '入金', '残高'], kind: 'generic' },
  { id: 'rakuten', name: '楽天銀行', description: '', headerSignature: ['取引日', '入出金(円)', '取引後残高(円)', '入出金内容'], kind: 'bank_statement' },
];

const offCapabilities: JournalCapabilitiesDto = { extraction: { enabled: false, vision: false }, hearing: { enabled: false } };

const savedDocument: JournalDocumentDto = {
  id: 'doc-9', kind: 'receipt', source: { type: 'structured' }, facts: { grandTotal: 1100 }, extraction: { method: 'manual', warnings: [] }, status: 'extracted',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

const existingDocument: JournalDocumentDto = {
  id: 'doc-1', kind: 'invoice', source: { type: 'structured' },
  facts: { direction: 'out', issuerName: 'サンプル商事', transactionDate: '2026-09-01', grandTotal: 67960, description: '9 月分' },
  extraction: { method: 'structured', warnings: [] }, status: 'undecided', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

/** バイト列そのままの CSV ファイル。jsdom の File は arrayBuffer を持たないことがあるので明示的に生やす。 */
function csvFile(name: string, source: string | Uint8Array): File {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([buffer], name, { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
  return file;
}

const genericCsv = ['日付,摘要,出金,入金,残高',
  '2026/09/01,ﾃﾞﾝｷﾘｮｳｷﾝ,18420,,481580',
  '2026/09/02,ATM ﾋｷﾀﾞｼ,20000,,461580',
  '2026/09/03,ﾌﾘｺﾐ ｶ)ｻﾝﾌﾟﾙｼｮｳｼﾞ,,67960,529540',
  '2026/09/04,ﾃｽｳﾘｮｳ,220,,529320',
  '2026/09/05,ｶｰﾄﾞﾋｷｵﾄｼ,38000,,491320',
  '2026/09/06,ｷｭｳﾖ,,310000,801320',
  '2026/09/07,ｳﾘｶｹ ﾆｭｳｷﾝ,,88000,889320'].join('\r\n');

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return {
    listJournalCsvPresets: vi.fn().mockResolvedValue(presets),
    importJournalCsv: vi.fn().mockResolvedValue({ preset: 'generic', imported: [], skippedRows: [], warnings: [] }),
    saveJournalDocument: vi.fn().mockResolvedValue(savedDocument),
    getJournalDocument: vi.fn().mockResolvedValue(existingDocument),
    ...overrides,
  } as unknown as ToolApiClient;
}

function renderTab(client: ToolApiClient, options: { readonly capabilities?: JournalCapabilitiesDto; readonly chart?: JournalChartOfAccountsDto; readonly editDocument?: { readonly id: string; readonly seq: number } } = {}, navigate = vi.fn()) {
  render(<NavigationProvider navigate={navigate}>
    <IngestTab client={client} chart={options.chart ?? chart} capabilities={options.capabilities ?? offCapabilities} editDocument={options.editDocument} />
  </NavigationProvider>);
  return navigate;
}

describe('IngestTab', () => {
  it('正常: CSV を選ぶと判定したプリセットと先頭 5 行のプレビューを出す', async () => {
    renderTab(stubClient());
    await userEvent.upload(screen.getByLabelText('CSV file'), csvFile('bank-generic.csv', genericCsv));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Detected preset: 汎用');
    expect(status.textContent).toContain('UTF-8');
    expect(status.textContent).toContain('7 rows');
    expect((screen.getByLabelText('CSV preset') as HTMLSelectElement).value).toBe('generic');

    const table = await screen.findByRole('table', { name: 'CSV preview' });
    // ヘッダー 1 行 + データ 5 行（7 行あっても 5 行で止める）。
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(within(table).getByText('ﾃﾞﾝｷﾘｮｳｷﾝ')).toBeTruthy();
    expect(within(table).queryByText('ｷｭｳﾖ')).toBeNull();
  });

  it('正常: 取込結果は取り込んだ件数と、取り込めなかった行の理由を出す', async () => {
    const importJournalCsv = vi.fn().mockResolvedValue({
      preset: 'generic',
      imported: [{ id: 'doc-1' }, { id: 'doc-2' }],
      skippedRows: [{ row: 3, reason: '金額の列を数値として読めませんでした' }, { row: 6, reason: '日付が空です' }],
      warnings: ['摘要が空の行が 1 件あります'],
    });
    const client = stubClient({ importJournalCsv });
    renderTab(client);
    await userEvent.upload(screen.getByLabelText('CSV file'), csvFile('bank-generic.csv', genericCsv));
    await userEvent.type(screen.getByLabelText('Account name (bank / card)'), '楽天銀行 普通');
    await userEvent.click(await screen.findByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importJournalCsv).toHaveBeenCalled());
    expect(importJournalCsv.mock.calls[0]?.[1]).toMatchObject({ fileName: 'bank-generic.csv', preset: 'generic', accountHint: '楽天銀行 普通' });
    expect(await screen.findByText(/Imported 2 documents \(preset: generic\)/)).toBeTruthy();
    expect(screen.getByText('摘要が空の行が 1 件あります')).toBeTruthy();

    const skipped = screen.getByRole('table', { name: 'Skipped rows' });
    expect(within(skipped).getByText('金額の列を数値として読めませんでした')).toBeTruthy();
    expect(within(skipped).getByText('日付が空です')).toBeTruthy();
    expect(within(skipped).getByText('6')).toBeTruthy();
  });

  it('異常: どのプリセットにも当たらないヘッダーは自動判定せず、手動選択（サーバー側の列判定）へ倒す', async () => {
    renderTab(stubClient());
    await userEvent.upload(screen.getByLabelText('CSV file'), csvFile('unknown.csv', 'colA,colB,colC\r\n1,2,3'));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('No preset matched the header (colA, colB, colC)');
    expect((screen.getByLabelText('CSV preset') as HTMLSelectElement).value).toBe('');
    expect(within(screen.getByLabelText('CSV preset')).getByRole('option', { name: '汎用' })).toBeTruthy();
  });

  it('境界: Shift-JIS の CSV を置換文字（U+FFFD）なしで読み、その旨を表示する', async () => {
    // 「日付」の Shift-JIS: 93 FA 95 74。UTF-8 として読むと U+FFFD になるバイト列。
    const bytes = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, ...new TextEncoder().encode('amount'), 0x0d, 0x0a, ...new TextEncoder().encode('2026/09/01,100')]);
    renderTab(stubClient());
    await userEvent.upload(screen.getByLabelText('CSV file'), csvFile('bank-mufg.sjis.csv', bytes));

    const table = await screen.findByRole('table', { name: 'CSV preview' });
    expect(within(table).getByText('日付')).toBeTruthy();
    expect(table.textContent).not.toContain('�');
    expect((await screen.findByRole('status')).textContent).toContain('decoded as Shift_JIS');
  });

  it('正常: 画像 / PDF とテキストの AI 読取が使えないときは原因と設定への導線を出す', async () => {
    const navigate = renderTab(stubClient());

    await userEvent.click(screen.getByRole('button', { name: 'Image / PDF' }));
    expect(await screen.findByText('AI reading is not available yet')).toBeTruthy();
    expect(screen.getByText(/LLM extraction is not enabled on this server/)).toBeTruthy();
    expect((screen.getByLabelText('Image (JPEG / PNG)') as HTMLInputElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Set the main model in Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });

    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(await screen.findByText('AI reading is not available yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read with AI' }).hasAttribute('disabled')).toBe(true);
  });

  it('異常: 事実フォームの日付形式・金額の誤りを欄の直下に出し、保存しない', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Facts form' }));
    await userEvent.type(await screen.findByLabelText('Transaction date'), '2026/09/01');
    await userEvent.type(screen.getByLabelText('Grand total'), '1234.5');
    await userEvent.type(screen.getByLabelText('Registration number'), 'T123');
    await userEvent.click(screen.getByRole('button', { name: 'Save document' }));

    expect(await screen.findByText('Use YYYY-MM-DD')).toBeTruthy();
    expect(screen.getByText('Enter an integer amount in yen')).toBeTruthy();
    expect(screen.getByText('Use T + 13 digits')).toBeTruthy();
    expect(screen.getByText('Fix the highlighted fields before saving.')).toBeTruthy();
    expect(client.saveJournalDocument).not.toHaveBeenCalled();
  });

  it('正常: 事実フォームの入力が整っていれば帳票を保存し、次の一手を案内する', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Facts form' }));
    await userEvent.type(await screen.findByLabelText('Transaction date'), '2026-09-01');
    await userEvent.type(screen.getByLabelText('Grand total'), '1,100');
    await userEvent.type(screen.getByLabelText('Issuer name'), 'サンプルカフェ');
    await userEvent.click(screen.getByRole('button', { name: 'Save document' }));

    await waitFor(() => expect(client.saveJournalDocument).toHaveBeenCalled());
    expect((client.saveJournalDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ kind: 'receipt', facts: { transactionDate: '2026-09-01', grandTotal: 1100, issuerName: 'サンプルカフェ' } });
    expect(await screen.findByText(/Saved. Next: open the Judge tab/)).toBeTruthy();
  });

  it('異常: 貼り付けた JSON が事実の形でなければ、項目ごとの問題を並べて保存させない', async () => {
    const client = stubClient();
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Paste JSON' }));
    fireEvent.change(await screen.findByLabelText('Facts JSON'), { target: { value: '{"amount": 1100, "transactionDate": "2026/09/01", "grandTotal": 12.5}' } });

    const errors = await screen.findByRole('alert');
    expect(errors.textContent).toContain('amount: unknown field (use "extra" for document-specific values)');
    expect(errors.textContent).toContain('transactionDate: expected YYYY-MM-DD');
    expect(errors.textContent).toContain('grandTotal: expected an integer (yen, tax included)');

    await userEvent.click(screen.getByRole('button', { name: 'Save document' }));
    expect(await screen.findByText('Fix the JSON errors listed below before saving.')).toBeTruthy();
    expect(client.saveJournalDocument).not.toHaveBeenCalled();
  });

  it('例外: 保存がサーバーで失敗したら、その理由をフォームの近くに出す', async () => {
    const client = stubClient({ saveJournalDocument: vi.fn().mockRejectedValue(new Error('JOURNAL_DOCUMENT_INVALID: grandTotal is required')) });
    renderTab(client);
    await userEvent.click(screen.getByRole('button', { name: 'Facts form' }));
    await userEvent.type(await screen.findByLabelText('Transaction date'), '2026-09-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save document' }));

    expect(await screen.findByText('JOURNAL_DOCUMENT_INVALID: grandTotal is required')).toBeTruthy();
  });

  it('正常: 判定タブからの「項目を編集」は事実フォームにその帳票を読み込み、同じ id で更新する', async () => {
    const client = stubClient();
    renderTab(client, { editDocument: { id: 'doc-1', seq: 1 } });

    expect(await screen.findByRole('heading', { name: 'Edit facts of document doc-1' })).toBeTruthy();
    expect((screen.getByLabelText('Issuer name') as HTMLInputElement).value).toBe('サンプル商事');
    expect((screen.getByLabelText('Grand total') as HTMLInputElement).value).toBe('67960');

    await userEvent.click(screen.getByRole('button', { name: 'Update document' }));
    await waitFor(() => expect(client.saveJournalDocument).toHaveBeenCalled());
    expect((client.saveJournalDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ id: 'doc-1', kind: 'invoice' });
  });

  it('例外: 編集対象の帳票を読めなかったらフォームの上にその理由を出す', async () => {
    renderTab(stubClient({ getJournalDocument: vi.fn().mockRejectedValue(new Error('not found')) }), { editDocument: { id: 'missing', seq: 1 } });
    expect(await screen.findByText(/Could not load the document/)).toBeTruthy();
  });

  it('境界: 有効な科目が 1 つも無い科目マスタでは、ルールを作れないことを先に知らせる', async () => {
    const emptyChart: JournalChartOfAccountsDto = { ...chart, accounts: [{ ...chart.accounts[0]!, enabled: false }] };
    renderTab(stubClient(), { chart: emptyChart });
    expect(await screen.findByText(/The chart of accounts has no enabled accounts/)).toBeTruthy();
  });

  it('例外: CSV プリセットの取得に失敗しても取込欄は使える', async () => {
    renderTab(stubClient({ listJournalCsvPresets: vi.fn().mockRejectedValue(new Error('presets down')) }));
    expect(await screen.findByText(/Could not load CSV presets/)).toBeTruthy();
    expect(screen.getByLabelText('CSV file')).toBeTruthy();
  });
});
