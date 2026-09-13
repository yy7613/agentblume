/**
 * PDF をブラウザ側でページ画像にする（docs/20 §6、ADR-0038: サーバーに PDF ライブラリを持ち込まない）。
 *
 * `pdfjs-dist` 本体はこのモジュールの中で **動的 import** する。ImageIngest 側も `await import('./pdf-raster')`
 * で読むので、PDF を選ぶまで初期バンドルに載らない（画像だけを使う利用者に数百 KB を配らない）。
 * テストでは `vi.mock('pdfjs-dist', …)` でこの動的 import ごと差し替えられる。
 *
 * ワーカーは Vite の `?url` で同梱した資産を指す（CDN を参照しない = オフラインでも動く）。
 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { IMAGE_JPEG_QUALITY, MAX_EXTRACTION_IMAGES, pdfRenderScale } from './journal-model';

/** password = 暗号化されていて開けない / corrupt = PDF として読めない / render = 画像化に失敗した。 */
export type PdfRasterFailure = 'password' | 'corrupt' | 'render';

export class PdfRasterError extends Error {
  readonly kind: PdfRasterFailure;
  constructor(kind: PdfRasterFailure, message: string) {
    super(message);
    this.name = 'PdfRasterError';
    this.kind = kind;
  }
}

export interface RasterPage {
  readonly pageNumber: number;
  /** data:image/jpeg;base64,… */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface RasterResult {
  readonly pages: readonly RasterPage[];
  /** PDF 全体のページ数（先頭 maxPages 枚しか画像化しないので、案内に使う）。 */
  readonly totalPages: number;
  /** テキスト層（無ければ空文字）。画像と一緒に渡すとモデルの読み取りが安定する。 */
  readonly text: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** pdfjs の例外名から失敗の種類を決める（pdfjs は独自の Error サブクラスを name で名乗る）。 */
function failureKind(cause: unknown): PdfRasterFailure {
  const name = cause instanceof Error ? cause.name : '';
  return name === 'PasswordException' ? 'password' : 'corrupt';
}

/**
 * 先頭 `maxPages` ページを JPEG の data URL にし、テキスト層があれば併せて返す。
 * 倍率はページごとに決める（長辺 1600〜2000px。固定倍率だと小さいページが潰れる）。
 */
export async function rasterizePdf(bytes: Uint8Array, options: { readonly maxPages?: number } = {}): Promise<RasterResult> {
  const maxPages = options.maxPages ?? MAX_EXTRACTION_IMAGES;
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  // 破棄はローディングタスク側（ワーカーごと止める）。
  const loadingTask = pdfjs.getDocument({ data: bytes });
  let document_;
  try {
    document_ = await loadingTask.promise;
  } catch (cause: unknown) {
    throw new PdfRasterError(failureKind(cause), messageOf(cause));
  }

  try {
    const totalPages = document_.numPages;
    const pages: RasterPage[] = [];
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, maxPages); pageNumber += 1) {
      const page = await document_.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pdfRenderScale(base.width, base.height) });
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d');
      if (context === null) throw new PdfRasterError('render', 'The browser did not provide a 2D canvas context.');
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      pages.push({ pageNumber, dataUrl: canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY), width: canvas.width, height: canvas.height });
      // テキスト層は「あれば添える」だけ。取れなくても画像で読めるので失敗にはしない。
      try {
        const content = await page.getTextContent();
        const line = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim();
        if (line !== '') texts.push(line);
      } catch { /* テキスト層なし（スキャン PDF）。画像だけで読む。 */ }
    }
    return { pages, totalPages, text: texts.join('\n') };
  } catch (cause: unknown) {
    if (cause instanceof PdfRasterError) throw cause;
    throw new PdfRasterError('render', messageOf(cause));
  } finally {
    try { await loadingTask.destroy(); } catch { /* 破棄の失敗は結果に影響しない。 */ }
  }
}
