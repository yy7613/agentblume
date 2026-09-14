/**
 * application層: 仕訳を「Agent が読む表」へ畳む（docs/20 §13 フェーズ 3 の組込みツール）。
 *
 * ETL の `journal-entries` ソースノードは domain にあり、リポジトリへ到達できない。実行直前に
 * `ResolveDataSourceGraphUseCase` がこのポートを呼んで行を差し込む（`web-search-source` と同じ規律）。
 * 仕訳 BC 側にこのファイルを置き、**行の畳み方は仕訳 BC が所有する**（列の意味を知っているのはここ）。
 *
 * 畳み方は汎用 CSV（`domain/journal/export.ts` の `genericCsvRows`）と同じ:
 * 借方 1 行 × 貸方 1 行の単純仕訳は 1 行に両側を出し、複合仕訳は行ごとに片側だけを出して
 * 同一 `entry_id` で束ねる。違うのは表現だけで、金額は数値・日付は `YYYY-MM-DD` 文字列・
 * 空欄は空文字ではなく **null**（Agent が数として扱えるようにするため）。
 *
 * 科目名は**現在のマスタ**から引き直す（`genericCsvRows` と同じ考え方）。マスタから消えた科目だけ、
 * 仕訳が持つ確定時の名称（`accountName`）へ落とす — 名前が空の行を Agent に見せないため。
 */
import type { Row } from '../../domain/data/types';
import { JOURNAL_ENTRIES_SCHEMA } from '../../domain/etl/nodes/journal-entries-source';
import { findAccount, type ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import type { EntryStatus, JournalEntry, JournalEntryLine } from '../../domain/journal/entry';
import type { ChartOfAccountsRepository, JournalEntryRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 読み取りの絞り込み（`journal-entries` ノードの config と同じ形）。 */
export interface JournalEntryRowsOptions {
  readonly status?: EntryStatus;
  /** 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  /** 読む**仕訳**の件数上限（出力行数ではない。複合仕訳は 1 件が複数行になる）。 */
  readonly limit?: number;
}

/** 片側（借方 or 貸方）の値。行に出ない側は null で埋める。 */
interface Side {
  readonly account: string | null;
  readonly taxCode: string | null;
  readonly amount: number | null;
}

const EMPTY_SIDE: Side = { account: null, taxCode: null, amount: null };

function sideOf(line: JournalEntryLine, chart: ChartOfAccounts): Side {
  // 現在のマスタの名前を優先し、消えた科目だけ確定時の名称へ落とす。
  const account = findAccount(chart, line.accountId)?.name ?? line.accountName;
  return { account, taxCode: line.taxCode, amount: line.amount };
}

function row(entry: JournalEntry, lineNo: number, debit: Side, credit: Side): Row {
  return {
    entry_id: entry.id,
    line_no: lineNo,
    date: entry.date,
    debit_account: debit.account,
    debit_tax_code: debit.taxCode,
    debit_amount: debit.amount,
    credit_account: credit.account,
    credit_tax_code: credit.taxCode,
    credit_amount: credit.amount,
    description: entry.description,
    invoice_status: entry.invoiceStatus,
    status: entry.status,
    document_id: entry.documentId ?? null,
    rule_id: entry.ruleId ?? null,
  };
}

/** 1 仕訳 → 表の行（単純仕訳は 1 行、複合仕訳は仕訳行ごと）。 */
export function journalEntryRows(entry: JournalEntry, chart: ChartOfAccounts): readonly Row[] {
  const debits = entry.lines.filter((line) => line.side === 'debit');
  const credits = entry.lines.filter((line) => line.side === 'credit');
  if (debits.length === 1 && credits.length === 1) {
    return [row(entry, 1, sideOf(debits[0] as JournalEntryLine, chart), sideOf(credits[0] as JournalEntryLine, chart))];
  }
  return entry.lines.map((line, index) => (line.side === 'debit'
    ? row(entry, index + 1, sideOf(line, chart), EMPTY_SIDE)
    : row(entry, index + 1, EMPTY_SIDE, sideOf(line, chart))));
}

/**
 * `journal-entries` ソースノードの行を供給するポートの実装。
 * `ResolveDataSourceGraphUseCase` のコンストラクタが受け取る `JournalEntryReadPort` を構造的に満たす
 * （リゾルバ側は型だけを宣言し、こちらは import しない — 仕訳 BC がデータソース BC に依存しない）。
 */
export class JournalEntryRowsProvider {
  constructor(
    private readonly entries: JournalEntryRepository,
    private readonly charts: ChartOfAccountsRepository,
  ) {}

  async rows(scope: TenantScope, options?: JournalEntryRowsOptions): Promise<readonly Row[]> {
    // マスタが未保存のワークスペースでも科目名が出るよう、標準セットへ落とす（出力と同じ規律）。
    const chart = (await this.charts.get(scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const entries = await this.entries.list(scope, {
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.from === undefined ? {} : { from: options.from }),
      ...(options?.to === undefined ? {} : { to: options.to }),
    });
    const limited = options?.limit === undefined ? entries : entries.slice(0, options.limit);
    return limited.flatMap((entry) => journalEntryRows(entry, chart));
  }
}

/** 供給する行の列（ノードの固定スキーマと必ず一致する）。 */
export const JOURNAL_ENTRY_ROW_SCHEMA = JOURNAL_ENTRIES_SCHEMA;
