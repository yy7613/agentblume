/**
 * application層: 銀行明細 CSV の文字コード判定（docs/22 §5.2）。
 *
 * 判定はサーバーで行う（ブラウザの TextDecoder に依存しない）。銀行 CSV はヘッダ行の前に口座情報の行が数行ある形式が多く、
 * 文字コード・ヘッダ行・プロファイルの判定を同じ規則でテストしたいため。
 *
 * 1. BOM があれば UTF-8。
 * 2. 明示指定があればそれで読む。Shift_JIS は WHATWG の `shift_jis`（= Windows-31J / CP932 相当）で読むので、
 *    銀行 CSV に混ざる NEC 特殊文字（①）・IBM 拡張文字も化けない。
 * 3. 自動: 厳格な UTF-8 で読めれば UTF-8、例外なら Shift_JIS。
 * 読んだ結果に置換文字（U+FFFD）が残れば、化けた行番号を警告に積む（画面は文字コードの切替を出す）。
 */

export const CSV_ENCODING_HINTS = ['auto', 'utf-8', 'shift_jis'] as const;
export type CsvEncodingHint = (typeof CSV_ENCODING_HINTS)[number];
export type CsvEncoding = 'utf-8' | 'shift_jis';

/** 取込の警告（文言は UI が code + params から組み立てる）。 */
export interface CsvWarning {
  readonly code: 'garbled-rows' | 'no-balance-column' | 'detected-profile' | 'skipped-rows';
  readonly params: Readonly<Record<string, string | number>>;
}

export interface DecodedCsv {
  readonly text: string;
  readonly encoding: CsvEncoding;
  readonly warnings: readonly CsvWarning[];
}

/** 取込の本文の上限（生バイト）。 */
export const BANK_CSV_MAX_BYTES = 5 * 1024 * 1024;

export function decodeBankCsv(bytes: Uint8Array, hint: CsvEncodingHint = 'auto'): DecodedCsv {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let encoding: CsvEncoding;
  let text: string;
  if (hasBom || hint === 'utf-8') {
    encoding = 'utf-8';
    text = new TextDecoder('utf-8').decode(bytes);
  } else if (hint === 'shift_jis') {
    encoding = 'shift_jis';
    text = new TextDecoder('shift_jis').decode(bytes);
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      encoding = 'utf-8';
    } catch {
      text = new TextDecoder('shift_jis').decode(bytes);
      encoding = 'shift_jis';
    }
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const garbled = text.split(/\r?\n/u).flatMap((line, index) => (line.includes('�') ? [index + 1] : []));
  return {
    text,
    encoding,
    warnings: garbled.length === 0 ? [] : [{ code: 'garbled-rows', params: { rows: garbled.slice(0, 10).join(', '), count: garbled.length } }],
  };
}

/** base64 を生バイトに。上限を超えたら undefined（呼び出し側が理由付きで断る）。 */
export function bytesFromBase64(content: string): Uint8Array | undefined {
  const bytes = Buffer.from(content, 'base64');
  return bytes.length > BANK_CSV_MAX_BYTES ? undefined : new Uint8Array(bytes);
}
