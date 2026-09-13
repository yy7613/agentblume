// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { ExtractJournalDocumentResultDto, JournalCapabilitiesDto } from '../api/types';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { ImageIngest } from './ImageIngest';

/**
 * jsdom は canvas も createImageBitmap も持たないので、縮小の経路は「呼ばれ方」で確かめる
 * （長辺 2000px の計算・再エンコードの有無・実寸表示）。pdfjs は動的 import ごと差し替える。
 */
const pdf = vi.hoisted(() => ({ load: undefined as unknown as () => Promise<unknown>, destroyed: 0 }));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: pdf.load(), destroy: () => { pdf.destroyed += 1; return Promise.resolve(); } }),
}));

/** A4（595x842pt）の n ページ PDF。テキスト層つき。 */
function fakePdf(pages: number) {
  return {
    numPages: pages,
    getPage: (pageNumber: number) => Promise.resolve({
      getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: () => Promise.resolve({ items: [{ str: `ページ${pageNumber}の本文` }] }),
    }),
  };
}

const visionOn: JournalCapabilitiesDto = { extraction: { enabled: true, vision: true }, hearing: { enabled: false } };
const visionOff: JournalCapabilitiesDto = { extraction: { enabled: true, vision: false }, hearing: { enabled: false } };

const extraction: ExtractJournalDocumentResultDto = {
  kind: 'receipt',
  facts: { grandTotal: 1100, issuerName: 'サンプルカフェ' },
  extraction: { method: 'llm', warnings: [], confidence: 0.9 },
};

function fileOf(name: string, type: string, bytes = 32): File {
  const buffer = new ArrayBuffer(bytes);
  const file = new File([buffer], name, { type });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

/** createImageBitmap の戻り（テストごとに寸法の並びを与える）。 */
function stubBitmaps(sizes: readonly { readonly width: number; readonly height: number }[]) {
  const queue = [...sizes];
  vi.stubGlobal('createImageBitmap', vi.fn().mockImplementation(() => {
    const size = queue.shift() ?? { width: 1000, height: 1000 };
    return Promise.resolve({ ...size, close: vi.fn() });
  }));
}

function stubClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return { extractJournalDocument: vi.fn().mockResolvedValue(extraction), ...overrides } as unknown as ToolApiClient;
}

function renderIngest(client: ToolApiClient, capabilities: JournalCapabilitiesDto = visionOn, onExtracted = vi.fn()) {
  render(<NavigationProvider navigate={vi.fn()}><ImageIngest client={client} capabilities={capabilities} onExtracted={onExtracted} /></NavigationProvider>);
  return onExtracted;
}

let toDataURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pdf.load = () => Promise.resolve(fakePdf(1));
  pdf.destroyed = 0;
  toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,ENCODED');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', { configurable: true, writable: true, value: toDataURL });
});

afterEach(() => { cleanup(); consumePendingOpen('Settings'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ImageIngest', () => {
  it('正常: 大きい画像は長辺 2000px の JPEG に縮小して送り、サムネイルに縮小後の実寸を出す', async () => {
    stubBitmaps([{ width: 4000, height: 3000 }]);
    const client = stubClient();
    renderIngest(client);
    await userEvent.upload(screen.getByLabelText('Image (JPEG / PNG)'), fileOf('receipt.png', 'image/png', 2_000_000));

    const thumbs = await screen.findByRole('list', { name: 'Images to send' });
    // 4000x3000 → 長辺 2000px（2000x1500）。
    expect(within(thumbs).getByText('2000×1500')).toBeTruthy();
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);

    await userEvent.click(screen.getByRole('button', { name: 'Read with AI' }));
    await waitFor(() => expect(client.extractJournalDocument).toHaveBeenCalled());
    const sent = (client.extractJournalDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { images: string[]; fileName: string };
    expect(sent.images).toEqual(['data:image/jpeg;base64,ENCODED']);
    expect(sent.fileName).toBe('receipt.png');
  });

  it('境界: 元より大きくは引き伸ばさず、小さく上限内の画像は再エンコードせずそのまま送る', async () => {
    stubBitmaps([{ width: 900, height: 600 }]);
    const client = stubClient();
    renderIngest(client);
    await userEvent.upload(screen.getByLabelText('Image (JPEG / PNG)'), fileOf('small.png', 'image/png', 40_000));

    const thumbs = await screen.findByRole('list', { name: 'Images to send' });
    // 長辺 2000px へ引き伸ばさない（900x600 のまま）。
    expect(within(thumbs).getByText(/900×600/)).toBeTruthy();
    expect(toDataURL).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Read with AI' }));
    await waitFor(() => expect(client.extractJournalDocument).toHaveBeenCalled());
    const sent = (client.extractJournalDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { images: string[] };
    expect(sent.images[0]?.startsWith('data:image/png')).toBe(true);
  });

  it('境界: 長辺 1200px 未満は「解像度が低い」と注意するが、送信は止めない', async () => {
    stubBitmaps([{ width: 510, height: 881 }]);
    const client = stubClient();
    renderIngest(client);
    await userEvent.upload(screen.getByLabelText('Image (JPEG / PNG)'), fileOf('tiny.jpg', 'image/jpeg', 30_000));

    expect(await screen.findByText('These images may be misread')).toBeTruthy();
    expect(screen.getByText(/under 1200px on the long edge/)).toBeTruthy();
    expect(screen.getByText(/photograph it again larger/)).toBeTruthy();
    expect(screen.getByText(/510×881 · low resolution/)).toBeTruthy();

    const read = screen.getByRole('button', { name: 'Read with AI' });
    expect(read.hasAttribute('disabled')).toBe(false);
    await userEvent.click(read);
    await waitFor(() => expect(client.extractJournalDocument).toHaveBeenCalled());
  });

  it('正常: PDF はページを画像化し、テキスト層も一緒に送る', async () => {
    pdf.load = () => Promise.resolve(fakePdf(2));
    const client = stubClient();
    renderIngest(client);
    await userEvent.upload(screen.getByLabelText('PDF'), fileOf('invoice.pdf', 'application/pdf', 5_000));

    const thumbs = await screen.findByRole('list', { name: 'Images to send' });
    expect(within(thumbs).getByText('invoice.pdf p.1')).toBeTruthy();
    expect(within(thumbs).getByText('invoice.pdf p.2')).toBeTruthy();
    // A4（595x842pt）は長辺 1800px を目標に倍率を決める → 1272x1800。
    expect(within(thumbs).getAllByText('1272×1800')).toHaveLength(2);
    expect(pdf.destroyed).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Read with AI' }));
    await waitFor(() => expect(client.extractJournalDocument).toHaveBeenCalled());
    const sent = (client.extractJournalDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { images: string[]; text: string };
    expect(sent.images).toHaveLength(2);
    expect(sent.text).toContain('ページ1の本文');
    expect(sent.text).toContain('ページ2の本文');
  });

  it('異常: パスワード付き PDF は原因と次の一手を出し、画像を作らない', async () => {
    const denied = new Error('No password given');
    denied.name = 'PasswordException';
    pdf.load = () => Promise.reject(denied);
    const client = stubClient();
    renderIngest(client);
    await userEvent.upload(screen.getByLabelText('PDF'), fileOf('locked.pdf', 'application/pdf', 5_000));

    expect(await screen.findByText(/"locked.pdf" is password-protected/)).toBeTruthy();
    expect(screen.getByText(/Remove the password/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Images to send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Read with AI' }).hasAttribute('disabled')).toBe(true);
  });

  it('例外: 壊れた PDF は「PDF として読めない」と直し方を出す', async () => {
    const broken = new Error('Invalid PDF structure');
    broken.name = 'InvalidPDFException';
    pdf.load = () => Promise.reject(broken);
    renderIngest(stubClient());
    await userEvent.upload(screen.getByLabelText('PDF'), fileOf('broken.pdf', 'application/pdf', 5_000));

    expect(await screen.findByText(/could not be read as a PDF/)).toBeTruthy();
    expect(screen.getByText(/print it to a new PDF/)).toBeTruthy();
  });

  it('境界: 5 枚選ぶと 4 枚に切り詰め、分けて読み取るよう案内する', async () => {
    stubBitmaps(Array.from({ length: 5 }, () => ({ width: 1600, height: 1200 })));
    renderIngest(stubClient());
    await userEvent.upload(screen.getByLabelText('Image (JPEG / PNG)'), [
      fileOf('a.png', 'image/png'), fileOf('b.png', 'image/png'), fileOf('c.png', 'image/png'), fileOf('d.png', 'image/png'), fileOf('e.png', 'image/png'),
    ]);

    const thumbs = await screen.findByRole('list', { name: 'Images to send' });
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText(/Only 4 images can be read at once/)).toBeTruthy();
    expect(within(thumbs).queryByText('e.png')).toBeNull();
  });

  it('異常: 画像でも PDF でもないファイルは受け取らず、何を選べばよいかを言う', async () => {
    renderIngest(stubClient());
    // accept 属性を通り抜けてくる経路（ドラッグ＆ドロップ、ファイル選択の「すべてのファイル」）を再現する。
    fireEvent.change(screen.getByLabelText('Image (JPEG / PNG)'), { target: { files: [fileOf('notes.txt', 'text/plain')] } });

    expect(await screen.findByText(/"notes.txt" is not an image or a PDF/)).toBeTruthy();
    expect(screen.getByText(/Choose a PNG \/ JPEG \/ WebP \/ GIF image or a PDF/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Images to send' })).toBeNull();
  });

  it('正常: 選んだ画像は 1 枚ずつ外せる', async () => {
    stubBitmaps([{ width: 1600, height: 1200 }, { width: 1600, height: 1200 }]);
    renderIngest(stubClient());
    await userEvent.upload(screen.getByLabelText('Image (JPEG / PNG)'), [fileOf('a.png', 'image/png'), fileOf('b.png', 'image/png')]);

    const thumbs = await screen.findByRole('list', { name: 'Images to send' });
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Images to send' })).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.queryByText('a.png')).toBeNull();
  });

  it('異常: vision 非対応のモデルでは入力を止め、原因と設定画面への導線を出す', async () => {
    renderIngest(stubClient(), visionOff);
    expect(await screen.findByText('AI reading is not available yet')).toBeTruthy();
    expect(screen.getByText(/does not accept images/)).toBeTruthy();
    expect((screen.getByLabelText('Image (JPEG / PNG)') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('PDF') as HTMLInputElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Set the main model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
  });

  it('例外: 抽出がサーバーで失敗したら理由を出し、選んだ画像は残す', async () => {
    stubBitmaps([{ width: 1600, height: 1200 }]);
    const client = stubClient({ extractJournalDocument: vi.fn().mockRejectedValue(new Error('model provider unreachable')) });
    const onExtracted = renderIngest(client);
    await userEvent.upload(screen.getByLabelText('Image (JPEG / PNG)'), fileOf('a.png', 'image/png'));
    await userEvent.click(await screen.findByRole('button', { name: 'Read with AI' }));

    expect(await screen.findByText('model provider unreachable')).toBeTruthy();
    expect(onExtracted).not.toHaveBeenCalled();
    expect(within(screen.getByRole('list', { name: 'Images to send' })).getAllByRole('listitem')).toHaveLength(1);
  });
});
