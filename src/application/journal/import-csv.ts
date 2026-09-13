/**
 * application層: 銀行 / カード明細 CSV の取込（docs/20 §6）。1 行 = 1 文書。
 *
 * ## 1 行の失敗で取込全体を捨てない
 *
 * 明細 CSV には合計行・注記行・空行・「お預り残高」だけの行が混ざる。厳格に全体を失敗させると、
 * 利用者は数百行のうちどこが悪いのか分からないまま何も取り込めない。ここでは**行ごとに捨てる**:
 * 読めなかった行は `skippedRows`（行番号 + 理由）へ積み、残りは保存する。画面はその一覧を出して
 * 「この行は取り込めなかった」と示せる。全列が空白の行は `parseCsv` が黙って捨てる（報告もしない）。
 *
 * 行番号は**ヘッダ行を 1 とした 1 始まり**。表計算ソフトの行番号と一致するので、直す場所を探せる。
 *
 * プリセットが決まらないこと（列名がどの銀行にも一致せず、列マッピングも指定が無い）だけは
 * 行の問題ではなく取込全体の前提なので、`JournalCsvImportError`（行番号なし）で断る。
 */
import { randomUUID } from 'node:crypto';
import { parseCsv, rowToRecord, stripBom } from '../../domain/journal/csv';
import {
  detectPreset, JOURNAL_CSV_PRESET_IDS, normalizeHeader, rowToDocument, rowToDocumentWithMapping,
  type ColumnMapping, type JournalCsvPresetId, type JournalDocumentInput,
} from '../../domain/journal/csv-presets';
import { createJournalDocument, toJournalDocumentSummary, type JournalDocumentSummary } from '../../domain/journal/document';
import { JournalCsvImportError } from '../../domain/journal/errors';
import type { JournalDocumentRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 列マッピングで取り込んだときの `preset` の値（どのプリセットでもない、の意）。 */
export const CUSTOM_CSV_PRESET = 'custom';

export interface ImportJournalCsvInput {
  readonly scope: TenantScope;
  readonly content: string;
  /** 明示指定。省略時は `columnMapping` → 列名署名の自動判定の順で決める。 */
  readonly preset?: string;
  readonly columnMapping?: ColumnMapping;
  readonly fileName?: string;
  /** 銀行口座 / カード名。ルールの `scope.accountHints` に効く。 */
  readonly accountHint?: string;
}

export interface ImportJournalCsvResult {
  readonly preset: string;
  readonly imported: readonly JournalDocumentSummary[];
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly string[];
}

function isPresetId(value: string): value is JournalCsvPresetId {
  return (JOURNAL_CSV_PRESET_IDS as readonly string[]).includes(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ImportJournalCsvUseCase {
  constructor(
    private readonly documents: JournalDocumentRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ImportJournalCsvInput): Promise<ImportJournalCsvResult> {
    // 引用符が閉じていなければ parseCsv が JournalCsvImportError（行番号つき）を投げる。
    const rows = parseCsv(stripBom(input.content));
    if (rows.length === 0) throw new JournalCsvImportError('CSV: the file has no rows');
    const headers = rows[0]!.map(normalizeHeader);
    const warnings: string[] = [];

    let presetId: JournalCsvPresetId | undefined;
    let mapping: ColumnMapping | undefined;
    if (input.preset !== undefined && input.preset !== '') {
      if (!isPresetId(input.preset)) throw new JournalCsvImportError(`CSV: unknown preset: ${input.preset} (expected one of ${JOURNAL_CSV_PRESET_IDS.join(', ')})`);
      presetId = input.preset;
    } else if (input.columnMapping !== undefined) {
      mapping = input.columnMapping;
    } else {
      presetId = detectPreset(rows[0]!);
      if (presetId === undefined) {
        throw new JournalCsvImportError(`CSV: could not detect a preset from the header row (${headers.join(', ')}); choose a preset or map the columns`);
      }
      warnings.push(`detected preset: ${presetId}`);
    }

    const at = this.now().toISOString();
    const imported: JournalDocumentSummary[] = [];
    const skippedRows: { row: number; reason: string }[] = [];
    const options = {
      ...(input.accountHint === undefined ? {} : { accountHint: input.accountHint }),
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
    };

    for (const [index, row] of rows.slice(1).entries()) {
      // ヘッダ行が 1。データ 1 行目は 2。
      const line = index + 2;
      let draft: JournalDocumentInput;
      try {
        const record = rowToRecord(headers, row);
        draft = presetId === undefined
          ? rowToDocumentWithMapping(mapping!, record, options, line)
          : rowToDocument(presetId, record, options, line);
      } catch (error) {
        skippedRows.push({ row: line, reason: messageOf(error) });
        continue;
      }
      try {
        const document = createJournalDocument({
          tenant: input.scope,
          kind: draft.kind,
          source: draft.source,
          facts: draft.facts,
          ...(draft.extraction === undefined ? {} : { extraction: draft.extraction }),
          status: 'extracted',
          createdAt: at,
          updatedAt: at,
        }, this.makeId);
        await this.documents.save(document);
        imported.push(toJournalDocumentSummary(document));
      } catch (error) {
        // domain の不変条件違反（金額や日付の形）も 1 行の問題として扱う。
        skippedRows.push({ row: line, reason: messageOf(error) });
      }
    }

    if (skippedRows.length > 0) warnings.push(`skipped ${skippedRows.length} of ${rows.length - 1} rows`);
    return { preset: presetId ?? CUSTOM_CSV_PRESET, imported, skippedRows, warnings };
  }
}