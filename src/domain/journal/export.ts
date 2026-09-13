/**
 * ドメイン: 汎用仕訳 CSV の書き出し（docs/20 §8）。
 *
 * 1 行 = 1 仕訳行。借方 1 行 × 貸方 1 行の単純仕訳は 1 行に両側を出し、複合仕訳は行ごとに片側だけを出す
 * （弥生の複合仕訳と同じ形。同一 `entry_id` で束ねる）。UTF-8 BOM、CRLF、日付 `YYYY/MM/DD`、金額は税込整数。
 * 弥生 / freee / MF 形式への写像は application 層の `export-presets.ts` が持つ（フェーズ 3）。
 */
import { dimensionValueName, type ChartOfAccounts } from './chart-of-accounts';
import { toCsv } from './csv';
import type { JournalEntry, JournalEntryLine } from './entry';

/** 汎用 CSV の 25 列（順序は固定）。 */
export const GENERIC_CSV_COLUMNS = [
  'entry_id', 'line_no', 'date',
  'debit_account', 'debit_sub_account', 'debit_department', 'debit_partner', 'debit_tax_code', 'debit_amount', 'debit_tax_amount',
  'credit_account', 'credit_sub_account', 'credit_department', 'credit_partner', 'credit_tax_code', 'credit_amount', 'credit_tax_amount',
  'description', 'invoice_status', 'registration_number', 'item', 'tags', 'closing_flag', 'source_document_id', 'rule_id',
] as const;
export type GenericCsvColumn = (typeof GENERIC_CSV_COLUMNS)[number];
export type GenericCsvRow = Readonly<Record<GenericCsvColumn, string | number>>;

export const UTF8_BOM = '\uFEFF';

/** `YYYY-MM-DD` → `YYYY/MM/DD`。 */
export function toSlashDate(date: string): string {
  return date.replaceAll('-', '/');
}

type Side = { readonly account: string; readonly subAccount: string; readonly department: string; readonly partner: string; readonly taxCode: string; readonly amount: string | number; readonly taxAmount: string | number };
const EMPTY_SIDE: Side = { account: '', subAccount: '', department: '', partner: '', taxCode: '', amount: '', taxAmount: '' };

function sideOf(line: JournalEntryLine, chart: ChartOfAccounts): Side {
  const sub = line.dimensionValues?.['sub_account'];
  const department = line.dimensionValues?.['department'];
  return {
    account: line.accountName,
    subAccount: sub === undefined ? '' : dimensionValueName(chart, 'sub_account', sub),
    department: department === undefined ? '' : dimensionValueName(chart, 'department', department),
    partner: line.partner ?? '',
    taxCode: line.taxCode,
    amount: line.amount,
    taxAmount: line.taxAmount ?? '',
  };
}

function row(entry: JournalEntry, lineNo: number, debit: Side, credit: Side): GenericCsvRow {
  return {
    entry_id: entry.id, line_no: lineNo, date: toSlashDate(entry.date),
    debit_account: debit.account, debit_sub_account: debit.subAccount, debit_department: debit.department, debit_partner: debit.partner, debit_tax_code: debit.taxCode, debit_amount: debit.amount, debit_tax_amount: debit.taxAmount,
    credit_account: credit.account, credit_sub_account: credit.subAccount, credit_department: credit.department, credit_partner: credit.partner, credit_tax_code: credit.taxCode, credit_amount: credit.amount, credit_tax_amount: credit.taxAmount,
    description: entry.description, invoice_status: entry.invoiceStatus, registration_number: entry.registrationNumber ?? '', item: entry.item ?? '', tags: (entry.tags ?? []).join(';'),
    closing_flag: 0, source_document_id: entry.documentId ?? '', rule_id: entry.ruleId ?? '',
  };
}

/** 1 仕訳 → CSV 行（単純仕訳は 1 行、複合仕訳は行ごと）。 */
export function genericCsvRows(entry: JournalEntry, chart: ChartOfAccounts): readonly GenericCsvRow[] {
  const debits = entry.lines.filter((line) => line.side === 'debit');
  const credits = entry.lines.filter((line) => line.side === 'credit');
  if (debits.length === 1 && credits.length === 1) return [row(entry, 1, sideOf(debits[0]!, chart), sideOf(credits[0]!, chart))];
  return entry.lines.map((line, index) => (line.side === 'debit'
    ? row(entry, index + 1, sideOf(line, chart), EMPTY_SIDE)
    : row(entry, index + 1, EMPTY_SIDE, sideOf(line, chart))));
}

/** 仕訳の配列 → 汎用 CSV（BOM 付き・CRLF・ヘッダ行あり）。 */
export function exportGenericCsv(entries: readonly JournalEntry[], chart: ChartOfAccounts): string {
  const rows = entries.flatMap((entry) => genericCsvRows(entry, chart));
  return UTF8_BOM + toCsv([[...GENERIC_CSV_COLUMNS], ...rows.map((record) => GENERIC_CSV_COLUMNS.map((column) => record[column]))]);
}
