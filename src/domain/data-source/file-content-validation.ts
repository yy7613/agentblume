/**
 * ドメイン: アップロードされたfileデータソース本文の検証（UX改善: 壊れたCSV/JSONの早期検出）。
 *
 * - CSV: null文字等の制御文字混入（バイナリ混入の目印）を拒否し、ヘッダー行の存在を要求したうえで、
 *   既存のETL CSVパーサ（`csv-source` ノード, `../etl/nodes/csv-source`）で実際にパースできることを確認する。
 *   同パーサは仕様上どんな文字列も例外なく緩くパースする設計（csv-source.test.ts の
 *   「empty text -> no rows, empty schema」等を参照）のため、壊れたファイルの実質的な検出は
 *   制御文字チェックとヘッダー行チェックが担う。
 * - JSON: `JSON.parse` が成功することのみを要求する。
 *
 * 失敗時は {@link InvalidFileContentError} を投げる（api層で 400 / INVALID_FILE_CONTENT にマッピング）。
 */
import { csvSourceNode } from '../etl/nodes/csv-source';
import { InvalidFileContentError } from './errors';

/** タブ(\t)・改行(\n)・復帰(\r)を除くC0制御文字およびDEL。バイナリ混入・null文字の目印として扱う。 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const LINE_BREAK_PATTERN = /\r\n|\r|\n/;

/** 制御文字を `U+XXXX` 形式で表す（メッセージに原因を含めるため）。 */
function describeControlChar(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 1行目（ヘッダー候補）を取り出す。改行が無ければ全体を1行目とみなす。 */
function firstLine(content: string): string {
  const breakIndex = content.search(LINE_BREAK_PATTERN);
  return breakIndex === -1 ? content : content.slice(0, breakIndex);
}

function validateCsvContent(content: string): void {
  const match = CONTROL_CHAR_PATTERN.exec(content);
  if (match !== null) {
    throw new InvalidFileContentError(
      `csv content could not be parsed: contains a control character ${describeControlChar(match[0])} at position ${match.index}`,
    );
  }
  if (firstLine(content).trim() === '') {
    throw new InvalidFileContentError('csv content could not be parsed: header row is missing');
  }
  // 既存のETL CSVパーサ（csv-source ノード）を実際に走らせ、後段のTool実行時と同じ経路で解釈できることを確認する
  // （上記の事前チェックを通過した文字列に対しては例外を投げない設計だが、実行経路を一致させるために呼び出す）。
  csvSourceNode.execute([], { text: content });
}

function validateJsonContent(content: string): void {
  try {
    JSON.parse(content);
  } catch (error) {
    throw new InvalidFileContentError(`json content could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** アップロードされたfileデータソース本文が、指定formatとして解釈可能か検証する。失敗時は {@link InvalidFileContentError}。 */
export function validateFileContent(format: 'csv' | 'json', content: string): void {
  if (format === 'csv') {
    validateCsvContent(content);
    return;
  }
  validateJsonContent(content);
}
