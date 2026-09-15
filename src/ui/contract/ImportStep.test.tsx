// @vitest-environment jsdom
/**
 * 取込。テキスト / PDF（テキスト層・スキャン）/ 画像の 3 系統が「本文 1 本 + ページ境界」にそろって送られること、
 * 文字起こしの進捗と中断（読めたページは残る）、PDF の失敗の種類ごとの案内、選択中文書の区分の保存と削除を守る。
 * pdfjs は重く jsdom で動かないので、動的 import される ./pdf-text ごと差し替える。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractApi } from '../api/contract-api';
import type { ContractCapabilitiesDto, ContractDocumentDto, ContractDocumentSummaryDto, ImportContractDocumentDto } from '../api/contract-types';
import { ApiError } from '../api/tool-api';
import { consumePendingOpen } from '../navigation';
import { ImportStep } from './ImportStep';

const pdf = vi.hoisted(() => ({ extract: vi.fn(), sha: vi.fn(), render: vi.fn() }));

vi.mock('./pdf-text', () => ({
  extractPdfText: (...args: unknown[]) => pdf.extract(...args),
  sha256Hex: (...args: unknown[]) => pdf.sha(...args),
  renderPdfPage: (...args: unknown[]) => pdf.render(...args),
}));

beforeEach(() => {
  pdf.extract.mockReset();
  pdf.sha.mockReset().mockResolvedValue('sha-abc');
  pdf.render.mockReset().mockImplementation(async (_bytes: Uint8Array, page: number) => `data:image/png;base64,P${page}`);
});

afterEach(() => { cleanup(); consumePendingOpen('Settings'); vi.restoreAllMocks(); });

function fakeApi(overrides: Partial<Record<keyof ContractApi, unknown>>): ContractApi {
  const cache = new Map<PropertyKey, unknown>(Object.entries(overrides));
  return new Proxy({}, {
    get: (_target, key) => {
      if (!cache.has(key)) cache.set(key, vi.fn(async () => { throw new Error(`unexpected call ${String(key)}`); }));
      return cache.get(key);
    },
  }) as ContractApi;
}

const visionOn: ContractCapabilitiesDto = { extraction: { enabled: true, vision: true }, review: { llm: true } };
const visionOff: ContractCapabilitiesDto = { extraction: { enabled: true, vision: false }, review: { llm: false } };

const PREAMBLE = '株式会社サンプル商事（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は、次のとおり契約を締結する。\n第1条（目的）\n甲は乙に保守業務を委託する。';

function documentOf(extra: Partial<ContractDocumentDto> = {}): ContractDocumentDto {
  return {
    id: 'doc-1', title: '保守業務委託', source: { type: 'pdf-text', fileName: 'a.pdf', pageCount: 1 }, body: PREAMBLE, pages: [{ page: 1, start: 0, end: PREAMBLE.length, method: 'text-layer', warnings: [] }], articles: [],
    parties: { A: { label: '甲', name: '株式会社サンプル商事' }, B: { label: '乙', name: '架空テック合同会社' } }, ourParty: 'A', ourRole: 'client',
    counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, contractAmount: 300000,
    clauses: [], status: 'extracted', createdAt: 'c', updatedAt: 'u', ...extra,
  };
}

const summary: ContractDocumentSummaryDto = { id: 'doc-1', title: '保守業務委託', status: 'extracted', sourceType: 'text', bodyLength: 10, clauseCount: 0, counterpartyName: '架空テック合同会社', createdAt: 'c', updatedAt: 'u' };

function fileOf(name: string, type: string): File {
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  const file = new File([buffer], name, { type });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
  return file;
}

/** signal が中断されるまで待ち、中断で AbortError を投げる。 */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
}

interface Setup {
  readonly capabilities?: ContractCapabilitiesDto;
  readonly documents?: readonly ContractDocumentSummaryDto[];
  readonly selected?: ContractDocumentDto;
  readonly overrides?: Partial<Record<keyof ContractApi, unknown>>;
}

function setup(options: Setup = {}) {
  const api = fakeApi({
    importDocument: vi.fn(async (_scope: unknown, input: ImportContractDocumentDto) => ({ document: documentOf({ id: 'doc-2', title: input.title }), warnings: [] })),
    updateDocument: vi.fn(async () => documentOf()),
    deleteDocument: vi.fn(async () => undefined),
    ...options.overrides,
  });
  const onImported = vi.fn();
  const onSelect = vi.fn();
  const onDeleted = vi.fn();
  render(<ImportStep api={api} capabilities={options.capabilities ?? visionOn} documents={options.documents ?? []} {...(options.selected === undefined ? {} : { selected: options.selected })} onImported={onImported} onSelect={onSelect} onDeleted={onDeleted} />);
  return { api, onImported, onSelect, onDeleted };
}

const imported = (api: ContractApi) => vi.mocked(api.importDocument).mock.calls.at(-1)?.[1];
const importButton = () => screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;

async function uploadPdf(pages: readonly { page: number; text: string; hasTextLayer: boolean }[], name = '業務委託.pdf') {
  pdf.extract.mockResolvedValue({ totalPages: pages.length, pages });
  await userEvent.click(screen.getByRole('tab', { name: 'PDF' }));
  await userEvent.upload(screen.getByLabelText('PDF file'), fileOf(name, 'application/pdf'));
}

describe('ImportStep: テキスト', () => {
  it('正常: 貼り付けた本文から甲乙を初期値に入れ、立場・区分・性質・金額（カンマと円を除く）を添えて送る', async () => {
    const { api, onImported } = setup();
    expect(screen.getByText('Import a contract to extract its clauses and check them against your playbook.')).toBeTruthy();
    expect(importButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Contract text'), { target: { value: PREAMBLE } });
    expect((screen.getByLabelText('Party A (甲)') as HTMLInputElement).value).toBe('株式会社サンプル商事');
    expect((screen.getByLabelText('Party B (乙)') as HTMLInputElement).value).toBe('架空テック合同会社');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '業務委託契約' } });
    await userEvent.click(screen.getByLabelText('We are party B (乙)'));
    fireEvent.change(screen.getByLabelText('Our role'), { target: { value: 'vendor' } });
    fireEvent.change(screen.getByLabelText(/^Contract nature/), { target: { value: 'nda' } });
    fireEvent.change(screen.getByLabelText('Contract amount (JPY, optional)'), { target: { value: '1,200,000円' } });
    fireEvent.change(screen.getByLabelText(/^Covered by the Toriteki Act/), { target: { value: 'yes' } });
    fireEvent.change(screen.getByLabelText(/^A specified contractor under the Freelance Act/), { target: { value: 'no' } });
    await userEvent.click(importButton());
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(imported(api)).toEqual({
      title: '業務委託契約', body: PREAMBLE, source: { type: 'text' },
      parties: { A: '株式会社サンプル商事', B: '架空テック合同会社' }, ourParty: 'B', ourRole: 'vendor',
      counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, contractNature: 'nda', contractAmount: 1200000,
    });
    // 取り込んだら入力欄を空に戻す（同じ本文を二重に取り込まない）。
    expect((screen.getByLabelText('Contract text') as HTMLTextAreaElement).value).toBe('');
  });

  it('境界: タイトル空は「無題」、数値でない金額・不明の性質・空の当事者は送らず、サーバーの警告を出す', async () => {
    const { api } = setup({ overrides: { importDocument: vi.fn(async () => ({ document: documentOf(), warnings: ['甲乙の行が見つかりません'] })) } });
    fireEvent.change(screen.getByLabelText('Contract text'), { target: { value: '前文の無い本文' } });
    fireEvent.change(screen.getByLabelText('Contract amount (JPY, optional)'), { target: { value: 'abc' } });
    // 前文から拾えなかった当事者は手で入れる。前後の空白は落とし、空欄は送らない。
    fireEvent.change(screen.getByLabelText('Party A (甲)'), { target: { value: ' 甲社 ' } });
    fireEvent.change(screen.getByLabelText('Party B (乙)'), { target: { value: '   ' } });
    await userEvent.click(importButton());
    expect(await screen.findByText('甲乙の行が見つかりません')).toBeTruthy();
    expect(imported(api)).toEqual({ title: 'Untitled contract', body: '前文の無い本文', source: { type: 'text' }, parties: { A: '甲社' }, ourRole: 'client', counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' } });
  });

  it('境界: 本文が 300,000 文字を超えると送らずに別紙を分ける案内を出す', async () => {
    const { api } = setup();
    fireEvent.change(screen.getByLabelText('Contract text'), { target: { value: 'あ'.repeat(300_001) } });
    await userEvent.click(importButton());
    expect(screen.getByText('The text exceeds 300,000 characters. Import the appendices separately.')).toBeTruthy();
    expect(api.importDocument).not.toHaveBeenCalled();
  });

  it('異常: モデルが使えない 409 は設定でモデルを変える導線を出す', async () => {
    let fail!: (cause: unknown) => void;
    setup({ overrides: { importDocument: vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })) } });
    fireEvent.change(screen.getByLabelText('Contract text'), { target: { value: PREAMBLE } });
    await userEvent.click(importButton());
    // 送信中は処理中の表示を出し、二重送信できない。
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(importButton().disabled).toBe(true);
    fail(new ApiError(409, 'CONTRACT_EXTRACTION_UNAVAILABLE', 'no model'));
    await userEvent.click(await screen.findByRole('button', { name: 'Change the model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
  });
});

describe('ImportStep: PDF', () => {
  it('正常: テキスト層のある PDF はページ本文を編集でき、ファイル名をタイトルに、ハッシュとページ境界を添えて送る', async () => {
    const { api } = setup();
    await uploadPdf([{ page: 1, text: PREAMBLE, hasTextLayer: true }]);
    expect(await screen.findByText('1 pages · 0 need transcription')).toBeTruthy();
    expect(screen.getByText('text layer')).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('業務委託');
    expect((screen.getByLabelText('Party A (甲)') as HTMLInputElement).value).toBe('株式会社サンプル商事');
    const edited = `${PREAMBLE}\n追記`;
    fireEvent.change(screen.getByLabelText('Text of page 1'), { target: { value: edited } });
    await userEvent.click(importButton());
    await waitFor(() => expect(api.importDocument).toHaveBeenCalled());
    expect(imported(api)).toMatchObject({
      title: '業務委託', body: edited,
      source: { type: 'pdf-text', fileName: '業務委託.pdf', pageCount: 1, sha256: 'sha-abc' },
      pages: [{ page: 1, start: 0, end: edited.length, method: 'text-layer', warnings: [] }],
    });
  });

  it('正常: スキャンページは 1 ページずつ画像にして文字起こしし、全部済むと pdf-ocr として送る', async () => {
    const transcribe = vi.fn()
      .mockResolvedValueOnce({ pages: [{ index: 0, text: '第2条（期間）', warnings: ['かすれ'] }], promptTemplateVersion: 'v1' })
      .mockResolvedValueOnce({ pages: [], promptTemplateVersion: 'v1' });
    const { api } = setup({ overrides: { transcribe } });
    await uploadPdf([{ page: 1, text: PREAMBLE, hasTextLayer: true }, { page: 2, text: '', hasTextLayer: false }, { page: 3, text: '', hasTextLayer: false }], 'scan.PDF');
    expect(await screen.findByText('3 pages · 2 need transcription')).toBeTruthy();
    expect(importButton().disabled).toBe(true);
    expect(screen.getByText('Transcribe the scanned pages before importing.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Transcribe the scanned pages' }));
    expect(await screen.findByText('3 pages · 0 need transcription')).toBeTruthy();
    expect(pdf.render).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), 2);
    expect(pdf.render).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), 3);
    expect(transcribe).toHaveBeenCalledWith(expect.anything(), ['data:image/png;base64,P2'], 'scan.PDF', expect.any(AbortSignal));
    expect(screen.getByText('かすれ')).toBeTruthy();
    expect(screen.getAllByText('transcribed — check it')).toHaveLength(2);
    await userEvent.click(importButton());
    await waitFor(() => expect(api.importDocument).toHaveBeenCalled());
    const sent = imported(api)!;
    expect(sent.title).toBe('scan');
    expect(sent.source).toMatchObject({ type: 'pdf-ocr', pageCount: 3 });
    // 応答にページが無いときは空文字で埋め、ページ境界は崩さない。
    expect(sent.body).toBe(`${PREAMBLE}\n第2条（期間）\n`);
    expect(sent.pages?.map((page) => page.method)).toEqual(['text-layer', 'vision', 'vision']);
    expect(sent.pages?.[1]?.warnings).toEqual(['かすれ']);
  });

  it('例外: 文字起こしを中断しても読めたページは残り、残りのページだけが未処理になる', async () => {
    const transcribe = vi.fn()
      .mockResolvedValueOnce({ pages: [{ index: 0, text: '2ページ目', warnings: [] }], promptTemplateVersion: 'v1' })
      .mockImplementationOnce((_scope: unknown, _images: unknown, _name: unknown, signal: AbortSignal) => untilAborted(signal));
    setup({ overrides: { transcribe } });
    await uploadPdf([{ page: 1, text: '', hasTextLayer: false }, { page: 2, text: '', hasTextLayer: false }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Transcribe the scanned pages' }));
    expect(await screen.findByText('1 / 2 pages (about 20 seconds per page)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Transcription stopped. The pages read so far are kept.')).toBeTruthy();
    expect(screen.getByText('2 pages · 1 need transcription')).toBeTruthy();
    expect((screen.getByLabelText('Text of page 1') as HTMLTextAreaElement).value).toBe('2ページ目');
    expect(screen.queryByLabelText('Text of page 2')).toBeNull();
  });

  it('異常: 文字起こしの失敗は案内を出し、画像を読めるモデルが無ければ文字起こしを押せない', async () => {
    setup({ overrides: { transcribe: vi.fn(async () => { throw new Error('vision failed'); }) } });
    await uploadPdf([{ page: 1, text: '', hasTextLayer: false }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Transcribe the scanned pages' }));
    expect((await screen.findByRole('alert')).textContent).toContain('vision failed');
    cleanup();
    setup({ capabilities: visionOff });
    await uploadPdf([{ page: 1, text: '', hasTextLayer: false }]);
    expect(((await screen.findByRole('button', { name: 'Transcribe the scanned pages' })) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['パスワード', Object.assign(new Error('x'), { kind: 'password' }), 'This PDF is password-protected. Choose a PDF without a password, or paste the text.'],
    ['100 ページ超', Object.assign(new Error('x'), { kind: 'too-large' }), 'The PDF has more than 100 pages. Split it and import the parts separately.'],
    ['壊れている', Object.assign(new Error('x'), { kind: 'corrupt' }), 'The PDF could not be read. Choose another file, or paste the text.'],
    ['Error 以外', 'broken', 'The PDF could not be read. Choose another file, or paste the text.'],
  ])('異常: PDF の失敗（%s）は種類ごとの次の一手を案内する', async (_label, cause, message) => {
    setup();
    pdf.extract.mockRejectedValue(cause);
    await userEvent.click(screen.getByRole('tab', { name: 'PDF' }));
    await userEvent.upload(screen.getByLabelText('PDF file'), fileOf('x.pdf', 'application/pdf'));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(/pages ·/)).toBeNull();
  });

  it('境界: 取込方法のタブを切り替えると読み込み途中のページを捨てる', async () => {
    setup();
    await uploadPdf([{ page: 1, text: PREAMBLE, hasTextLayer: true }]);
    await screen.findByText('1 pages · 0 need transcription');
    await userEvent.click(screen.getByRole('tab', { name: 'Paste text' }));
    await userEvent.click(screen.getByRole('tab', { name: 'PDF' }));
    expect(screen.queryByText(/pages ·/)).toBeNull();
  });
});

describe('ImportStep: 画像', () => {
  it('正常: 画像を読めるモデルが無ければ設定と貼り付けへの導線を出し、文字起こしは押せない', async () => {
    setup({ capabilities: visionOff });
    await userEvent.click(screen.getByRole('tab', { name: 'Images' }));
    expect(screen.getByText('Reading images needs a main model with vision.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Set the main model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
    await userEvent.upload(screen.getByLabelText('Page images'), [fileOf('p1.png', 'image/png')]);
    expect(((await screen.findByRole('button', { name: 'Transcribe the scanned pages' })) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Paste the text instead' }));
    expect(screen.getByRole('tab', { name: 'Paste text', selected: true })).toBeTruthy();
    expect(screen.getByLabelText('Contract text')).toBeTruthy();
  });

  it('正常: 複数の画像をページとして文字起こしし、image-ocr としてハッシュ無しで送る', async () => {
    const transcribe = vi.fn()
      .mockResolvedValueOnce({ pages: [{ index: 0, text: PREAMBLE, warnings: [] }], promptTemplateVersion: 'v1' })
      .mockResolvedValueOnce({ pages: [{ index: 0, text: '第2条', warnings: [] }], promptTemplateVersion: 'v1' });
    const { api } = setup({ overrides: { transcribe } });
    await userEvent.click(screen.getByRole('tab', { name: 'Images' }));
    expect(screen.queryByText('Reading images needs a main model with vision.')).toBeNull();
    await userEvent.upload(screen.getByLabelText('Page images'), [fileOf('p1.png', 'image/png'), fileOf('p2.png', 'image/png')]);
    expect(await screen.findByText('2 pages · 2 need transcription')).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('p1.png');
    await userEvent.click(screen.getByRole('button', { name: 'Transcribe the scanned pages' }));
    expect(await screen.findByText('2 pages · 0 need transcription')).toBeTruthy();
    const firstImages = transcribe.mock.calls[0]?.[1] as string[];
    expect(firstImages[0]?.startsWith('data:image/png')).toBe(true);
    expect(pdf.render).not.toHaveBeenCalled();
    // 文字起こしの後に前文から甲乙を拾う。
    await waitFor(() => expect((screen.getByLabelText('Party A (甲)') as HTMLInputElement).value).toBe('株式会社サンプル商事'));
    await userEvent.click(importButton());
    await waitFor(() => expect(api.importDocument).toHaveBeenCalled());
    expect(imported(api)?.source).toEqual({ type: 'image-ocr', fileName: 'p1.png', pageCount: 2 });
  });
});

describe('ImportStep: 取込済みの文書', () => {
  it('正常: 一覧から選べ、選択中の文書は保存済みの当事者・区分で編集して保存できる', async () => {
    const { api, onImported, onSelect } = setup({ documents: [summary], selected: documentOf({ contractNature: { value: 'ukeoi', source: 'manual' } as ContractDocumentDto['contractNature'] }) });
    expect(screen.getByText('Extracted')).toBeTruthy();
    expect(screen.getByText('架空テック合同会社')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '保守業務委託' }));
    expect(onSelect).toHaveBeenCalledWith('doc-1');
    expect(screen.getByRole('heading', { name: 'Selected: 保守業務委託' })).toBeTruthy();
    const title = screen.getAllByLabelText('Title')[0] as HTMLInputElement;
    expect(title.value).toBe('保守業務委託');
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.change(screen.getAllByLabelText(/^Covered by the Toriteki Act/)[0]!, { target: { value: 'unknown' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save parties and categories' }));
    expect(await screen.findByText('Saved the parties, role and counterparty category.')).toBeTruthy();
    expect(onImported).toHaveBeenCalled();
    expect(api.updateDocument).toHaveBeenCalledWith(expect.anything(), 'doc-1', {
      title: '保守業務委託', body: PREAMBLE, source: documentOf().source, pages: documentOf().pages,
      parties: { A: '株式会社サンプル商事', B: '架空テック合同会社' }, ourParty: 'A', ourRole: 'client',
      counterpartyProfile: { toriteki: 'unknown', freelance: 'no' }, contractNature: 'ukeoi', contractAmount: 300000,
    });
  });

  it('異常: 区分の保存に失敗したら案内を出す', async () => {
    setup({ documents: [summary], selected: documentOf(), overrides: { updateDocument: vi.fn(async () => { throw new Error('update failed'); }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Save parties and categories' }));
    expect((await screen.findByRole('alert')).textContent).toContain('update failed');
  });

  it('境界: 締結登録済みの文書は削除ボタンを出さず、区分も保存できない', () => {
    const minimal = documentOf({ status: 'signed', parties: { A: { label: '甲' }, B: { label: '乙' } }, contractAmount: undefined });
    delete (minimal as { ourParty?: unknown }).ourParty;
    delete (minimal as { ourRole?: unknown }).ourRole;
    setup({ documents: [{ ...summary, status: 'signed' }], selected: minimal });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save parties and categories' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('Party A (甲)')[0] as HTMLInputElement).value).toBe('');
    expect((screen.getAllByLabelText('Not decided')[0] as HTMLInputElement).checked).toBe(true);
  });

  it('正常: 確認して削除すると親へ知らせ、取り消すと何もしない。失敗は案内を出す', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteDocument = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('delete failed'));
    const { onDeleted } = setup({ documents: [{ ...summary, counterpartyName: undefined }], overrides: { deleteDocument } });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteDocument).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(deleteDocument).toHaveBeenCalledWith(expect.anything(), 'doc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toContain('delete failed');
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('境界: 選択中の文書の区分フォームと新規取込のフォームは状態を共有しない', async () => {
    setup({ documents: [summary], selected: documentOf() });
    const titles = screen.getAllByLabelText('Title') as HTMLInputElement[];
    expect(titles).toHaveLength(2);
    expect(titles[0]!.value).not.toBe('');
    expect(titles[1]!.value).toBe('');
    fireEvent.change(titles[1]!, { target: { value: '新規の契約' } });
    expect((screen.getAllByLabelText('Title') as HTMLInputElement[])[0]!.value).not.toBe('新規の契約');
  });
});

