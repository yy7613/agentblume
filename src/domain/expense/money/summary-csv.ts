/**
 * ドメイン: 集計の CSV（docs/21 §20.9.3 `GET /expense/summary/export`。UC6。純関数）。
 *
 * UTF-8 BOM・CRLF。列はエージェントツール `expense_summary` の出力列と同じ（画面・CSV・ツールで同じ数字にする）。
 */
import { toCsv } from '../../journal/csv';
import { EXPENSE_SUMMARY_COLUMNS, summaryTableRows, type ExpenseSummaryResult } from './summary';

export function summaryCsvFileName(result: Pick<ExpenseSummaryResult, 'from' | 'to' | 'basis'>): string {
  return `expense-summary-${result.from}-${result.to}-${result.basis}.csv`;
}

export function summaryToCsv(result: ExpenseSummaryResult): { readonly content: string; readonly fileName: string } {
  const rows = summaryTableRows(result).map((row) => EXPENSE_SUMMARY_COLUMNS.map((column) => row[column]));
  return { content: `﻿${toCsv([EXPENSE_SUMMARY_COLUMNS, ...rows])}`, fileName: summaryCsvFileName(result) };
}
