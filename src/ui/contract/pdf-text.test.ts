// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** pdfjs は動的 import ごと差し替える（jsdom はワーカーも canvas も持たない）。 */
const pdf = vi.hoisted(() => ({ load: undefined as unknown as () => Promise<unknown>, destroyed: 0 }));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: pdf.load(), destroy: () => { pdf.destroyed += 1; return Promise.resolve(); } }),
}));

import { extractPdfText, hasTextLayer, joinPages, pageTextOf, PdfTextError, renderPdfPage, sha256Hex, TEXT_LAYER_MIN_CHARS } from './pdf-text';

function fakePdf(pages: readonly (readonly { str: string; hasEOL?: boolean }[] | 'broken')[]) {
  return {
    numPages: pages.length,
    getPage: (pageNumber: number) => Promise.resolve({
      getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: () => pages[pageNumber - 1] === 'broken' ? Promise.reject(new Error('no text')) : Promise.resolve({ items: pages[pageNumber - 1] }),
    }),
  };
}

beforeEach(() => { pdf.destroyed = 0; });
afterEach(() => { vi.restoreAllMocks(); });

describe('pageTextOf / hasTextLayer', () => {
  it('正常: hasEOL で改行を復元し、行末の空白を落とす（条見出しを行頭で検出するため）', () => {
    expect(pageTextOf([{ str: '第1条（目的）  ', hasEOL: true }, { str: '甲は' }, { str: '乙に委託する。', hasEOL: true }, {}])).toBe('第1条（目的）\n甲は乙に委託する。');
  });

  it('境界: 空白を除いて 20 文字未満はテキスト層なし', () => {
    expect(hasTextLayer('あ'.repeat(TEXT_LAYER_MIN_CHARS))).toBe(true);
    expect(hasTextLayer(`${'あ'.repeat(TEXT_LAYER_MIN_CHARS - 1)}    \n`)).toBe(false);
  });
});

describe('extractPdfText', () => {
  it('正常: 全ページを読み、テキスト層の無いページ（スキャン・壊れた層）を見分ける。ワーカーは必ず破棄する', async () => {
    const long = [{ str: '第1条（目的）甲は乙に対し本業務を委託し、乙はこれを受託する。', hasEOL: true }];
    pdf.load = () => Promise.resolve(fakePdf([long, [{ str: '1' }], 'broken']));
    const result = await extractPdfText(new Uint8Array([1]));
    expect(result.totalPages).toBe(3);
    expect(result.pages.map((page) => [page.page, page.hasTextLayer])).toEqual([[1, true], [2, false], [3, false]]);
    expect(pdf.destroyed).toBe(1);
  });

  it.each([
    ['PasswordException', 'password'],
    ['InvalidPDFException', 'corrupt'],
  ] as const)('異常: 開けない PDF（%s）は種類つきの PdfTextError', async (name, kind) => {
    pdf.load = () => Promise.reject(Object.assign(new Error('cannot open'), { name }));
    await expect(extractPdfText(new Uint8Array([1]))).rejects.toMatchObject({ name: 'PdfTextError', kind });
  });

  it('境界: 上限を超えるページ数は too-large（分冊を案内する）', async () => {
    pdf.load = () => Promise.resolve(fakePdf([[], [], []]));
    await expect(extractPdfText(new Uint8Array([1]), { maxPages: 2 })).rejects.toMatchObject({ kind: 'too-large' });
    expect(pdf.destroyed).toBe(1);
  });

  it('例外: ページの読み込みが壊れていれば render', async () => {
    pdf.load = () => Promise.resolve({ numPages: 1, getPage: () => Promise.reject(new Error('boom')) });
    await expect(extractPdfText(new Uint8Array([1]))).rejects.toMatchObject({ kind: 'render', message: 'boom' });
  });
});

describe('renderPdfPage', () => {
  it('正常: 指定ページを JPEG の data URL にする（長辺 2000px を目安に拡大）', async () => {
    pdf.load = () => Promise.resolve(fakePdf([[], []]));
    const canvas = { width: 0, height: 0, getContext: () => ({}), toDataURL: vi.fn(() => 'data:image/jpeg;base64,AAA') };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
    expect(await renderPdfPage(new Uint8Array([1]), 2)).toBe('data:image/jpeg;base64,AAA');
    expect(canvas.height).toBe(2000);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('異常: 2D コンテキストが無い・描画に失敗したら render', async () => {
    pdf.load = () => Promise.resolve(fakePdf([[]]));
    vi.spyOn(document, 'createElement').mockReturnValue({ getContext: () => null } as unknown as HTMLElement);
    await expect(renderPdfPage(new Uint8Array([1]), 1)).rejects.toBeInstanceOf(PdfTextError);
    vi.restoreAllMocks();
    pdf.load = () => Promise.resolve({ numPages: 1, getPage: () => Promise.reject('string failure') });
    await expect(renderPdfPage(new Uint8Array([1]), 1)).rejects.toMatchObject({ kind: 'render', message: 'string failure' });
  });
});

describe('joinPages / sha256Hex', () => {
  it('正常: ページを改行でつなぎ、本文中の位置でページ境界を返す', () => {
    expect(joinPages([{ page: 1, text: 'ab', method: 'text-layer' }, { page: 2, text: 'cd', method: 'vision', warnings: ['w'] }])).toEqual({
      body: 'ab\ncd',
      pages: [{ page: 1, start: 0, end: 2, method: 'text-layer', warnings: [] }, { page: 2, start: 3, end: 5, method: 'vision', warnings: ['w'] }],
    });
  });

  it('正常: SHA-256 を 16 進で返し、使えない環境では undefined', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no subtle'));
    expect(await sha256Hex(new Uint8Array([1]))).toBeUndefined();
  });
});
