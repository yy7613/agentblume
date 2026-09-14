/**
 * application層: 仕訳の CSV 出力（docs/20 §8）。
 *
 * 汎用 25 列の組み立ては domain（`exportGenericCsv` / `genericCsvRows`）が持ち、弥生 / freee / MF は
 * その行の**純粋な写像**（`export-presets.ts`）。ここは「どれを出すか」「どの文字コードで返すか」
 * 「出したことを記録するか」を決める。
 *
 * 文字コード: 弥生は Shift-JIS でないと取込画面で文字化けする。JSON は任意のバイト列を運べないので、
 * Shift-JIS のときだけ `contentBase64` にバイト列を入れ、`content` は読める UTF-8 のまま返す
 * （画面のテキストエリアのフォールバックが空にならないようにするため）。
 *
 * `warnings` は「値を作れなかったこと」の申告（税区分の対応名が無い・摘要を切り詰めた・伝票番号にできる
 * 数字が無い・1 伝票の行数上限を超えた・Shift-JIS に無い文字）。**黙って埋めない**。
 *
 * `markExported: true` は出力した仕訳を `exported` にする。会計ソフトへ入れた仕訳を二重に出さないための印で、
 * 既定は off（画面で中身を確かめるだけのダウンロードで状態を動かさない）。
 */
import iconv from 'iconv-lite';
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { toCsv } from '../../domain/journal/csv';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import { markEntryExported, type EntryStatus } from '../../domain/journal/entry';
import { JournalExportError } from '../../domain/journal/errors';
import { exportGenericCsv, genericCsvRows, UTF8_BOM } from '../../domain/journal/export';
import type { ChartOfAccountsRepository, JournalEntryRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import {
  findJournalExportPreset, JOURNAL_EXPORT_FORMATS, SUPPORTED_JOURNAL_EXPORT_FORMATS, vendorCsvRows,
  type JournalExportFormat, type VendorId,
} from './export-presets';

export interface ExportJournalEntriesInput {
  readonly scope: TenantScope;
  readonly format: JournalExportFormat;
  readonly status?: EntryStatus;
  /** 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  /** 出力した仕訳を `exported` にする。 */
  readonly markExported?: boolean;
}

export type JournalExportEncoding = 'utf-8' | 'shift_jis';

export interface JournalExportResult {
  readonly format: JournalExportFormat;
  readonly fileName: string;
  /** 人が読める本文（Shift-JIS 形式でも UTF-8 のまま。画面のテキストエリア用）。 */
  readonly content: string;
  readonly entryCount: number;
  readonly encoding: JournalExportEncoding;
  /** `shift_jis` のときだけ。会計ソフトへ渡すバイト列（base64）。 */
  readonly contentBase64?: string;
  readonly warnings: readonly string[];
}

/** Shift-JIS で表せない文字（`?` に潰れる）を拾う。黙って化けさせない。 */
function shiftJisUnsupported(content: string): readonly string[] {
  const lost = new Set<string>();
  for (const char of new Set(content)) {
    if (char === '?') continue;
    const encoded = iconv.encode(char, 'Shift_JIS');
    if (encoded.length === 1 && encoded[0] === 0x3f) lost.add(char);
  }
  return [...lost];
}

export class ExportJournalEntriesUseCase {
  constructor(
    private readonly entries: JournalEntryRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ExportJournalEntriesInput): Promise<JournalExportResult> {
    if (!(SUPPORTED_JOURNAL_EXPORT_FORMATS as readonly string[]).includes(input.format)) {
      throw new JournalExportError(`journal export: unknown format: ${input.format} (expected one of ${JOURNAL_EXPORT_FORMATS.join(', ')})`);
    }

    const at = this.now();
    const chart: ChartOfAccounts = (await this.charts.get(input.scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const entries = await this.entries.list(input.scope, {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });

    const stamp = at.toISOString().slice(0, 10);
    const warnings: string[] = [];
    let content: string;
    let encoding: JournalExportEncoding = 'utf-8';
    let fileName = `journal-${stamp}.csv`;

    if (input.format === 'generic') {
      content = exportGenericCsv(entries, chart);
    } else {
      const preset = findJournalExportPreset(input.format)!;
      const rows = entries.flatMap((entry) => genericCsvRows(entry, chart));
      const vendor = vendorCsvRows(input.format as VendorId, rows, chart);
      warnings.push(...vendor.warnings);
      encoding = preset.encoding;
      content = (encoding === 'utf-8' ? UTF8_BOM : '') + toCsv(vendor.rows);
      fileName = `journal-${input.format}-${stamp}.csv`;
    }

    let contentBase64: string | undefined;
    if (encoding === 'shift_jis') {
      const lost = shiftJisUnsupported(content);
      if (lost.length > 0) warnings.push(`Shift-JIS にできない文字（${lost.join(' ')}）が含まれていたため、その文字は「?」になります。摘要や科目名から取り除いてください。`);
      contentBase64 = iconv.encode(content, 'Shift_JIS').toString('base64');
    }

    if (input.markExported === true) {
      const isoStamp = at.toISOString();
      for (const entry of entries) await this.entries.save(markEntryExported(entry, isoStamp));
    }

    return {
      format: input.format,
      fileName,
      content,
      entryCount: entries.length,
      encoding,
      ...(contentBase64 === undefined ? {} : { contentBase64 }),
      warnings,
    };
  }
}
