/**
 * ドメイン: 請求書番号の書式（docs/22 §2.1 `numbering`）。
 *
 * 書式は利用者データ（既定 `INV-{YYYY}-{SEQ4}`）。使える差し込みは `{YYYY}` `{YY}` `{MM}` `{SEQ3}`〜`{SEQ6}` だけで、
 * `{SEQn}` はちょうど 1 つ要る（無いと同じ番号しか作れず、2 つあると採番の意味が曖昧になる）。
 * 系列キーは書式の年月部分を発行日で展開した文字列（`INV-2026-{SEQ4}`）。年が変われば系列が変わり、番号は 1 から振り直す。
 * 連番が桁を超えたら切り詰めずにそのまま伸ばす（切り詰めると番号が重複する）。
 */
import { ReceivablesDomainError } from './errors';

const TOKEN = /\{[^}]*\}/gu;
const SEQ = /^\{SEQ([3-6])\}$/u;
const DATE_TOKENS = new Set(['{YYYY}', '{YY}', '{MM}']);
export const DEFAULT_NUMBERING_FORMAT = 'INV-{YYYY}-{SEQ4}';
export const NUMBERING_FORMAT_MAX_LENGTH = 60;

/** 書式の不正を文で返す（無ければ undefined）。 */
export function numberingFormatProblem(format: string): string | undefined {
  if (typeof format !== 'string' || format.trim() === '') return 'numbering.format must be a non-empty string';
  if (format.length > NUMBERING_FORMAT_MAX_LENGTH) return `numbering.format must be at most ${NUMBERING_FORMAT_MAX_LENGTH} characters`;
  const tokens = format.match(TOKEN) ?? [];
  const unknown = tokens.filter((token) => !DATE_TOKENS.has(token) && !SEQ.test(token));
  if (unknown.length > 0) return `numbering.format has unknown placeholders: ${unknown.join(', ')} (use {YYYY} {YY} {MM} {SEQ3}..{SEQ6})`;
  const sequences = tokens.filter((token) => SEQ.test(token));
  if (sequences.length !== 1) return 'numbering.format must contain exactly one {SEQn} placeholder';
  return undefined;
}

export function assertNumberingFormat(format: string): void {
  const problem = numberingFormatProblem(format);
  if (problem !== undefined) throw new ReceivablesDomainError(problem);
}

/** 発行日で年月を展開した系列キー。 */
export function numberingSeriesKey(format: string, issueDate: string): string {
  assertNumberingFormat(format);
  const [year = '', month = ''] = issueDate.split('-');
  return format.replaceAll('{YYYY}', year).replaceAll('{YY}', year.slice(-2)).replaceAll('{MM}', month);
}

/** 系列キーと連番から番号を作る。 */
export function formatInvoiceNumber(seriesKey: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new ReceivablesDomainError('invoice sequence must be a positive integer');
  return seriesKey.replace(/\{SEQ([3-6])\}/u, (_token, digits: string) => String(sequence).padStart(Number(digits), '0'));
}
