/**
 * ドメイン: 小さな RFC 4180 CSV パーサ / 書き出し（仕訳 BC 専用）。
 *
 * 評価データセットの取込（`application/evaluation/evaluation-dataset-transfer.ts`）と同じ規則だが、
 * BC をまたいで import しないためここに持つ。BOM は落とし、CRLF / LF の両方を受け、
 * 引用符内の改行・カンマ・`""` を扱う。空行（全列が空白）は捨てる。
 */
import { JournalCsvImportError } from './errors';

/** 先頭の UTF-8 BOM を落とす。 */
export function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

/** CSV 全体を行 × 列の文字列配列に。引用符が閉じていなければ `JournalCsvImportError`。 */
export function parseCsv(content: string): string[][] {
  const text = stripBom(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new JournalCsvImportError('CSV: unterminated quote', rows.length + 1);
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((item) => item.some((value) => value.trim().length > 0));
}

/** 1 セルを CSV 用に引用する（カンマ・引用符・改行を含むときだけ）。 */
export function csvValue(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 行の配列を CRLF 区切りの CSV に（末尾にも CRLF）。 */
export function toCsv(rows: readonly (readonly (string | number | undefined | null)[])[]): string {
  return rows.map((row) => row.map(csvValue).join(',')).join('\r\n') + '\r\n';
}

/** ヘッダ行を列名 → 値のオブジェクトに写す。列数が足りない行は空文字で埋める。 */
export function rowToRecord(headers: readonly string[], row: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => { record[header] = row[index] ?? ''; });
  return record;
}
