/**
 * application層: 仕訳の CSV 出力（docs/20 §8）。
 *
 * 列の組み立ては domain（`exportGenericCsv`）が持ち、ここは「どれを出すか」「出したことを記録するか」を決める。
 * 弥生 / freee / MF は列写像（`export-presets.ts`）を用意しただけでまだ変換を書いていないので、
 * `generic` 以外は `JournalExportError`（400）で断る — 空の CSV や列だけ違う汎用 CSV を返すと、
 * 利用者は会計ソフトの取込画面で初めて失敗に気づくことになる。
 *
 * `markExported: true` は出力した仕訳を `exported` にする。会計ソフトへ入れた仕訳を二重に出さないための印で、
 * 既定は off（画面で中身を確かめるだけのダウンロードで状態を動かさない）。
 */
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import { markEntryExported, type EntryStatus } from '../../domain/journal/entry';
import { JournalExportError } from '../../domain/journal/errors';
import { exportGenericCsv } from '../../domain/journal/export';
import type { ChartOfAccountsRepository, JournalEntryRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { JOURNAL_EXPORT_FORMATS, SUPPORTED_JOURNAL_EXPORT_FORMATS, type JournalExportFormat } from './export-presets';

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

export interface JournalExportResult {
  readonly format: JournalExportFormat;
  readonly fileName: string;
  readonly content: string;
  readonly entryCount: number;
}

export class ExportJournalEntriesUseCase {
  constructor(
    private readonly entries: JournalEntryRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ExportJournalEntriesInput): Promise<JournalExportResult> {
    if (!(SUPPORTED_JOURNAL_EXPORT_FORMATS as readonly string[]).includes(input.format)) {
      const known = (JOURNAL_EXPORT_FORMATS as readonly string[]).includes(input.format);
      throw new JournalExportError(known
        ? `journal export: the '${input.format}' format is not available yet (only ${SUPPORTED_JOURNAL_EXPORT_FORMATS.join(', ')} is supported)`
        : `journal export: unknown format: ${input.format} (expected one of ${JOURNAL_EXPORT_FORMATS.join(', ')})`);
    }

    const at = this.now();
    const chart: ChartOfAccounts = (await this.charts.get(input.scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const entries = await this.entries.list(input.scope, {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    const content = exportGenericCsv(entries, chart);

    if (input.markExported === true) {
      const stamp = at.toISOString();
      for (const entry of entries) await this.entries.save(markEntryExported(entry, stamp));
    }

    return {
      format: 'generic',
      fileName: `journal-${at.toISOString().slice(0, 10)}.csv`,
      content,
      entryCount: entries.length,
    };
  }
}