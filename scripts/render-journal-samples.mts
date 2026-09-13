/**
 * samples/journal/templates/*.html を Playwright (Chromium) で描画し、
 * samples/journal/rendered/<name>.png と <name>.pdf を出力する。
 *
 *   npx tsx scripts/render-journal-samples.mts
 *
 * 各テンプレートは samples/journal/<name>.json（SaveJournalDocumentDto）と 1:1 に対応し、
 * LLM 抽出テストの正解データとして使う。描画前に JSON の grandTotal がテンプレート本文に
 * 含まれているかを検査し、食い違いがあれば失敗させる（数値の改変漏れ防止）。
 */
import { chromium } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_DIR = join(ROOT, 'samples', 'journal');
const TEMPLATE_DIR = join(SAMPLE_DIR, 'templates');
const OUT_DIR = join(SAMPLE_DIR, 'rendered');

/** 名前 → 描画設定。receipt は 58mm 幅の感熱紙風に細く描く。 */
interface RenderSpec {
  readonly name: string;
  readonly viewportWidth: number;
  readonly pdf: { readonly format?: 'A4'; readonly width?: string };
}

const SPECS: readonly RenderSpec[] = [
  { name: 'invoice-qualified', viewportWidth: 900, pdf: { format: 'A4' } },
  { name: 'receipt-simplified', viewportWidth: 340, pdf: { width: '80mm' } },
  { name: 'receipt-handwritten', viewportWidth: 700, pdf: { format: 'A4' } },
  { name: 'expense-report', viewportWidth: 900, pdf: { format: 'A4' } },
];

const MAX_PNG_BYTES = 600 * 1024;

const formatYen = (value: number): string => value.toLocaleString('en-US');

async function assertMatchesJson(name: string, html: string): Promise<void> {
  const json = JSON.parse(await readFile(join(SAMPLE_DIR, `${name}.json`), 'utf8')) as {
    facts: { grandTotal?: number; registrationNumber?: string; lines?: { amount: number }[] };
  };
  const missing: string[] = [];
  if (json.facts.grandTotal !== undefined && !html.includes(formatYen(json.facts.grandTotal))) {
    missing.push(`grandTotal ${formatYen(json.facts.grandTotal)}`);
  }
  if (json.facts.registrationNumber && !html.includes(json.facts.registrationNumber)) {
    missing.push(`registrationNumber ${json.facts.registrationNumber}`);
  }
  for (const line of json.facts.lines ?? []) {
    if (!html.includes(formatYen(line.amount))) missing.push(`line amount ${formatYen(line.amount)}`);
  }
  if (missing.length > 0) {
    throw new Error(`${name}: テンプレートに JSON の値が見つかりません: ${missing.join(', ')}`);
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const spec of SPECS) {
      const html = await readFile(join(TEMPLATE_DIR, `${spec.name}.html`), 'utf8');
      await assertMatchesJson(spec.name, html);

      const context = await browser.newContext({
        viewport: { width: spec.viewportWidth, height: 400 }, // fullPage なので高さは内容に合わせて伸びる
        deviceScaleFactor: 1.5,
        locale: 'ja-JP',
      });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);

      const pngPath = join(OUT_DIR, `${spec.name}.png`);
      const pdfPath = join(OUT_DIR, `${spec.name}.pdf`);
      await page.screenshot({ path: pngPath, fullPage: true, type: 'png' });
      const pdf = await page.pdf({ ...spec.pdf, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
      await writeFile(pdfPath, pdf);
      await context.close();

      const pngSize = (await stat(pngPath)).size;
      if (pngSize > MAX_PNG_BYTES) {
        throw new Error(`${spec.name}.png が ${Math.round(pngSize / 1024)} KB で上限 ${MAX_PNG_BYTES / 1024} KB を超えています`);
      }
      console.log(`${spec.name}: png ${Math.round(pngSize / 1024)} KB, pdf ${Math.round(pdf.byteLength / 1024)} KB`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
