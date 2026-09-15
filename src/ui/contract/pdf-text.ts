/**
 * PDF のテキスト層をブラウザで全ページ抜き出す（docs/23 §3.1、ADR-0042 §1: サーバーに PDF ライブラリを持ち込まない）。
 *
 * - `pdfjs-dist` は動的 import（PDF を選ぶまで初期バンドルに載らない）。ワーカーは Vite の `?url` で同梱した資産。
 * - `getTextContent()` の `hasEOL` で改行を復元する（条見出し「第N条」を行頭で検出するため、改行を潰さない）。
 * - テキスト層が 1 ページあたり 20 文字未満のページは「文字起こしが必要」とみなし、そのページだけを画像にする関数も持つ
 *   （仕訳の `pdf-raster.ts` は先頭 N ページしか画像化できないので、契約側にページ指定の小関数を持つ。docs/23 §9.4 C6 は後回し）。
 * - テストでは `vi.mock('pdfjs-dist', …)` で動的 import ごと差し替える。
 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ContractPageDto } from '../api/contract-types';

export const PDF_MAX_PAGES = 100;
/** これ未満の文字数のページはテキスト層が無い（スキャン）とみなす。 */
export const TEXT_LAYER_MIN_CHARS = 20;
const JPEG_QUALITY = 0.85;
const TARGET_LONG_EDGE = 2000;

/** password = 暗号化 / corrupt = PDF として読めない / render = 画像化に失敗 / too-large = ページが多すぎる。 */
export type PdfTextFailure = 'password' | 'corrupt' | 'render' | 'too-large';

export class PdfTextError extends Error {
  constructor(readonly kind: PdfTextFailure, message: string) {
    super(message);
    this.name = 'PdfTextError';
  }
}

export interface PdfPageText {
  readonly page: number;
  readonly text: string;
  readonly hasTextLayer: boolean;
}

export interface PdfTextResult {
  readonly totalPages: number;
  readonly pages: readonly PdfPageText[];
}

interface TextItemLike { readonly str?: string; readonly hasEOL?: boolean }

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function openPdf(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({ data: bytes });
  try {
    return { loadingTask, document: await loadingTask.promise };
  } catch (cause: unknown) {
    const name = cause instanceof Error ? cause.name : '';
    throw new PdfTextError(name === 'PasswordException' ? 'password' : 'corrupt', messageOf(cause));
  }
}

/** テキスト項目 → 1 ページの本文（`hasEOL` で改行。行末の空白は落とす）。 */
export function pageTextOf(items: readonly TextItemLike[]): string {
  let text = '';
  for (const item of items) {
    text += item.str ?? '';
    if (item.hasEOL === true) text += '\n';
  }
  return text.split('\n').map((line) => line.replace(/[ \t]+$/u, '')).join('\n').trim();
}

export function hasTextLayer(text: string): boolean {
  return text.replace(/\s/gu, '').length >= TEXT_LAYER_MIN_CHARS;
}

/** 全ページ（上限 100）のテキスト層を読む。上限を超える PDF は分冊を案内するために投げる。 */
export async function extractPdfText(bytes: Uint8Array, options: { readonly maxPages?: number } = {}): Promise<PdfTextResult> {
  const maxPages = options.maxPages ?? PDF_MAX_PAGES;
  const { loadingTask, document } = await openPdf(bytes);
  try {
    if (document.numPages > maxPages) throw new PdfTextError('too-large', `the PDF has ${document.numPages} pages; import at most ${maxPages} pages at a time`);
    const pages: PdfPageText[] = [];
    for (let page = 1; page <= document.numPages; page += 1) {
      const handle = await document.getPage(page);
      let text = '';
      try {
        const content = await handle.getTextContent();
        text = pageTextOf(content.items as readonly TextItemLike[]);
      } catch { /* テキスト層が壊れているページは文字起こしの対象にする。 */ }
      pages.push({ page, text, hasTextLayer: hasTextLayer(text) });
    }
    return { totalPages: document.numPages, pages };
  } catch (cause: unknown) {
    if (cause instanceof PdfTextError) throw cause;
    throw new PdfTextError('render', messageOf(cause));
  } finally {
    try { await loadingTask.destroy(); } catch { /* 破棄の失敗は結果に影響しない。 */ }
  }
}

/** 指定ページを JPEG の data URL にする（文字起こし用。長辺 2000px を目安に拡大）。 */
export async function renderPdfPage(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const { loadingTask, document } = await openPdf(bytes);
  try {
    const page = await document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(1, TARGET_LONG_EDGE / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d');
    if (context === null) throw new PdfTextError('render', 'The browser did not provide a 2D canvas context.');
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch (cause: unknown) {
    if (cause instanceof PdfTextError) throw cause;
    throw new PdfTextError('render', messageOf(cause));
  } finally {
    try { await loadingTask.destroy(); } catch { /* 同上 */ }
  }
}

/** ページごとの本文 → 本文 1 本 + ページ境界（本文中の文字位置）。 */
export function joinPages(pages: readonly { readonly page: number; readonly text: string; readonly method: 'text-layer' | 'vision'; readonly warnings?: readonly string[] }[]): { readonly body: string; readonly pages: readonly ContractPageDto[] } {
  let body = '';
  const ranges: ContractPageDto[] = [];
  for (const page of pages) {
    if (body !== '') body += '\n';
    const start = body.length;
    body += page.text;
    ranges.push({ page: page.page, start, end: body.length, method: page.method, warnings: page.warnings ?? [] });
  }
  return { body, pages: ranges };
}

/** 同じファイルの二重取込の警告に使う SHA-256（使えない環境では undefined）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}
