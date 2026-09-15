import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from '../errors';
import { DEFAULT_ZENGIN_FORMAT, type ZenginFormatSettings } from '../payout';
import { toZenginText } from '../zengin-charset';
import {
  buildZenginTransferFile, zenginAlpha, zenginDataRecord, zenginEndRecord, zenginFileName, zenginHeaderRecord, zenginNumeric, zenginTrailerRecord,
  ZENGIN_EOF_MARK, ZENGIN_RECORD_BYTES, type ZenginFileLine, type ZenginFileRequester,
} from './zengin-file';

/** samples/expense/expected-zengin.hex と同じ入力（値はすべて架空）。 */
const REQUESTER: ZenginFileRequester = { requesterCode: '0000000001', requesterNameKana: 'サンプルシヨウジ', bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: '0000009' };
const LINES: readonly ZenginFileLine[] = [
  { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: '0000001', holderKana: 'テスト タロウ', amount: 5180 },
  { bankCode: '9999', branchCode: '999', accountType: 'savings', accountNumber: '0000004', holderKana: 'テスト サブロウ', amount: 32000 },
];
const DATE = '2026-09-25';
const format = (overrides: Partial<ZenginFormatSettings> = {}): ZenginFormatSettings => ({ ...DEFAULT_ZENGIN_FORMAT, ...overrides });
const spaces = (count: number): string => ' '.repeat(count);
const kana = (text: string, width: number): string => toZenginText(text).text.padEnd(width, ' ');

describe('zengin-file: レコードのバイト配置（§20.6.2）', () => {
  it('正常: ヘッダーの各項目の位置と値', () => {
    const record = zenginHeaderRecord(REQUESTER, format(), DATE);
    const fields: readonly [number, number, string][] = [
      [0, 1, '1'], [1, 3, '21'], [3, 4, '0'], [4, 14, '0000000001'], [14, 54, kana('サンプルシヨウジ', 40)], [54, 58, '0925'],
      [58, 62, '9999'], [62, 77, spaces(15)], [77, 80, '998'], [80, 95, spaces(15)], [95, 96, '1'], [96, 103, '0000009'], [103, 120, spaces(17)],
    ];
    expect(record).toHaveLength(ZENGIN_RECORD_BYTES);
    for (const [from, to, value] of fields) expect(record.slice(from, to), `${from + 1}-${to}`).toBe(value);
  });

  it('正常: データの各項目の位置と値（預金種目・前ゼロ・名義の変換・既定の書式）', () => {
    const record = zenginDataRecord(LINES[1] as ZenginFileLine, format(), 1);
    const fields: readonly [number, number, string][] = [
      [0, 1, '2'], [1, 5, '9999'], [5, 20, spaces(15)], [20, 23, '999'], [23, 38, spaces(15)], [38, 42, '0000'], [42, 43, '4'], [43, 50, '0000004'],
      [50, 80, kana('テスト サブロウ', 30)], [80, 90, '0000032000'], [90, 91, '0'], [91, 101, '0000000000'], [101, 111, '0000000000'], [111, 112, '7'], [112, 113, ' '], [113, 120, spaces(7)],
    ];
    expect(record).toHaveLength(ZENGIN_RECORD_BYTES);
    for (const [from, to, value] of fields) expect(record.slice(from, to), `${from + 1}-${to}`).toBe(value);
  });

  it('正常: トレーラーは件数 N6・合計 N12 の前ゼロ、エンドは 9 とスペース', () => {
    expect(zenginTrailerRecord(2, 37180)).toBe(`8000002000000037180${spaces(101)}`);
    expect(zenginEndRecord()).toBe(`9${spaces(119)}`);
    expect(zenginTrailerRecord(999999, 999_999_999_999)).toHaveLength(120);
    expect(() => zenginTrailerRecord(1_000_000, 1)).toThrow(ExpenseDomainError);
  });

  it('境界: 金額 N10 は 9,999,999,999 まで。10,000,000,000・負・小数は実装の誤りとして投げる', () => {
    expect(zenginDataRecord({ ...(LINES[0] as ZenginFileLine), amount: 9_999_999_999 }, format(), 0).slice(80, 90)).toBe('9999999999');
    expect(zenginDataRecord({ ...(LINES[0] as ZenginFileLine), amount: 1 }, format(), 0).slice(80, 90)).toBe('0000000001');
    for (const amount of [10_000_000_000, -1, 1.5]) expect(() => zenginDataRecord({ ...(LINES[0] as ZenginFileLine), amount }, format(), 0)).toThrow(ExpenseDomainError);
  });

  it('正常: 銀行差の設定（銀行名を入れる・手形交換所番号スペース・振込指定区分 8 / スペース・新規コード・顧客コード 1 に社員番号）', () => {
    const named = { ...(LINES[0] as ZenginFileLine), bankNameKana: 'サンプル', branchNameKana: 'ホンテン', employeeCode: '12' };
    const record = zenginDataRecord(named, format({ includeBankNames: true, clearingHouse: 'spaces', transferKind: '8', newCode: '1', customerCode1: 'employee-code' }), 0);
    expect(record.slice(5, 20)).toBe(kana('サンプル', 15));
    expect(record.slice(23, 38)).toBe(kana('ホンテン', 15));
    expect(record.slice(38, 42)).toBe('    ');
    expect(record.slice(90, 91)).toBe('1');
    expect(record.slice(91, 101)).toBe('0000000012');
    expect(record.slice(111, 112)).toBe('8');
    expect(zenginDataRecord(named, format({ transferKind: 'space' }), 0).slice(111, 112)).toBe(' ');
    expect(zenginHeaderRecord({ ...REQUESTER, bankNameKana: 'サンプル', branchNameKana: 'ホンテン' }, format({ includeBankNames: true }), DATE).slice(62, 77)).toBe(kana('サンプル', 15));
  });

  it('異常: 社員番号が無い・11 桁、名義が 31 バイト、使えない文字、形の違う振込日は投げる（点検を通さずに組んだ実装の誤り）', () => {
    const employeeCode = format({ customerCode1: 'employee-code' });
    expect(() => zenginDataRecord(LINES[0] as ZenginFileLine, employeeCode, 0)).toThrow('employeeCode');
    expect(() => zenginDataRecord({ ...(LINES[0] as ZenginFileLine), employeeCode: '12345678901' }, employeeCode, 0)).toThrow('at most 10 digits');
    expect(zenginAlpha('ｱ'.repeat(30), 30, 'strict', 'holder')).toHaveLength(30);
    expect(() => zenginAlpha('ｱ'.repeat(31), 30, 'strict', 'holder')).toThrow('31 bytes, over 30');
    expect(() => zenginAlpha('テスト・タロウ', 30, 'strict', 'holder')).toThrow('cannot be written');
    expect(() => zenginHeaderRecord(REQUESTER, format(), '2026/09/25')).toThrow('transferDate');
    expect(() => zenginNumeric('12a', 4, 'code')).toThrow(ExpenseDomainError);
    expect(zenginAlpha(undefined, 5, 'strict', 'x')).toBe(spaces(5));
  });
});

describe('buildZenginTransferFile', () => {
  it('正常: ヘッダー → データ × N → トレーラー → エンド。全レコード 120 バイト、既定は CR LF で 122 バイトずつ', () => {
    const result = buildZenginTransferFile(REQUESTER, format(), LINES, DATE);
    expect(result.records.map((record) => record[0])).toEqual(['1', '2', '2', '8', '9']);
    for (const record of result.records) expect(record).toHaveLength(ZENGIN_RECORD_BYTES);
    expect(result).toMatchObject({ recordCount: 2, totalAmount: 37180 });
    expect(result.bytes).toHaveLength(5 * 122);
    for (let index = 0; index < 5; index += 1) expect([result.bytes[index * 122 + 120], result.bytes[index * 122 + 121]]).toEqual([0x0d, 0x0a]);
    // 半角カナは JIS X 0201 の 1 バイト（ｻ = 0xBB）。
    expect(result.bytes[14]).toBe(0xbb);
  });

  it('正常: samples/expense/expected-zengin.hex とバイト単位で一致する（再作成しても同じ SHA-256 になる前提）', () => {
    const expected = readFileSync(join(process.cwd(), 'samples', 'expense', 'expected-zengin.hex'), 'utf8').replace(/\s+/gu, '');
    expect(Buffer.from(buildZenginTransferFile(REQUESTER, format(), LINES, DATE).bytes).toString('hex')).toBe(expected);
  });

  it('境界: 改行なしは 120 バイトずつ、EOF を付けると末尾に 0x1A が 1 バイト増える', () => {
    const none = buildZenginTransferFile(REQUESTER, format({ lineEnding: 'none' }), LINES, DATE);
    expect(none.bytes).toHaveLength(5 * 120);
    const eof = buildZenginTransferFile(REQUESTER, format({ lineEnding: 'none', eofMark: true }), LINES, DATE);
    expect(eof.bytes).toHaveLength(5 * 120 + 1);
    expect(eof.bytes[600]).toBe(ZENGIN_EOF_MARK);
    expect(buildZenginTransferFile(REQUESTER, format({ eofMark: true }), LINES, DATE).bytes.at(-1)).toBe(ZENGIN_EOF_MARK);
  });

  it('境界: 0 円の行は作らず件数・合計に入れない。行が 1 件も無ければ投げる', () => {
    const result = buildZenginTransferFile(REQUESTER, format(), [...LINES, { ...(LINES[0] as ZenginFileLine), amount: 0 }], DATE);
    expect(result.recordCount).toBe(2);
    expect(result.records[3]).toBe(`8000002000000037180${spaces(101)}`);
    expect(() => buildZenginTransferFile(REQUESTER, format(), [{ ...(LINES[0] as ZenginFileLine), amount: 0 }], DATE)).toThrow('at least one line');
  });

  it('正常: ファイル名は振込日とバッチ id の先頭 8 桁', () => {
    expect(zenginFileName(DATE, '0123456789abcdef')).toBe('zengin-sofuri-20260925-01234567.txt');
  });
});
