import { describe, expect, it } from 'vitest';
import { csvValue, parseCsv, rowToRecord, stripBom, toCsv } from './csv';
import { JournalCsvImportError } from './errors';

describe('stripBom', () => {
  it('正常: 先頭の BOM だけを落とす（途中の同じ文字は残す）', () => {
    expect(stripBom('﻿a,b')).toBe('a,b');
    expect(stripBom('a﻿b')).toBe('a﻿b');
  });

  it('境界: BOM の無い文字列と空文字はそのまま', () => {
    expect(stripBom('a,b')).toBe('a,b');
    expect(stripBom('')).toBe('');
  });
});

describe('parseCsv', () => {
  it('正常: 行 × 列へ分解する（CRLF / LF のどちらでも同じ結果）', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('正常: 引用符の中のカンマは区切りにしない', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('正常: 引用符の中の改行はセルの一部として残す（行を割らない。RFC 4180）', () => {
    // 引用符の中では CR も LF もそのまま残る（行の区切りとして扱うのは引用符の外だけ）。
    expect(parseCsv('a,"line1\r\nline2",c')).toEqual([['a', 'line1\r\nline2', 'c']]);
    expect(parseCsv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
    // 摘要に改行が入った明細でも 1 行として読める。
    expect(parseCsv('日付,摘要\r\n2026-09-10,"1 行目\r\n2 行目"\r\n')).toEqual([['日付', '摘要'], ['2026-09-10', '1 行目\r\n2 行目']]);
  });

  it('正常: 引用符の中の "" は 1 個の引用符になる', () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('正常: 先頭の BOM を落としてから解析する（1 列目の列名が壊れない）', () => {
    expect(parseCsv('﻿日付,摘要\r\n2026-09-10,テスト')).toEqual([['日付', '摘要'], ['2026-09-10', 'テスト']]);
  });

  it('境界: 末尾の改行は空行を作らない', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('境界: 全列が空白の行は捨てる（明細 CSV の区切り行・空行）', () => {
    expect(parseCsv('a,b\r\n\r\n1,2\r\n , \r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('境界: 空文字と空白だけの入力は空配列', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\r\n\r\n')).toEqual([]);
  });

  it('境界: 列数が揃わない行もそのまま返す（穴埋めは rowToRecord の仕事）', () => {
    expect(parseCsv('a,b,c\r\n1,2')).toEqual([['a', 'b', 'c'], ['1', '2']]);
  });

  it('境界: 空セルは空文字として残る', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });

  it('例外: 閉じていない引用符は JournalCsvImportError（行番号つき）', () => {
    expect(() => parseCsv('a,"unterminated')).toThrow(JournalCsvImportError);
    expect(() => parseCsv('a,"unterminated')).toThrow(/unterminated quote/);
    try {
      parseCsv('a,b\r\nc,"broken');
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(JournalCsvImportError);
      expect((error as JournalCsvImportError).row).toBe(2);
    }
  });
});

describe('csvValue', () => {
  it('正常: 特別な文字を含まない値はそのまま', () => {
    expect(csvValue('abc')).toBe('abc');
    expect(csvValue(123)).toBe('123');
    expect(csvValue(0)).toBe('0');
  });

  it('正常: カンマ・引用符・改行を含む値だけを引用する（引用符は二重化）', () => {
    expect(csvValue('a,b')).toBe('"a,b"');
    expect(csvValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvValue('line1\r\nline2')).toBe('"line1\r\nline2"');
    expect(csvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('境界: undefined / null / 空文字は空セル', () => {
    expect(csvValue(undefined)).toBe('');
    expect(csvValue(null)).toBe('');
    expect(csvValue('')).toBe('');
  });
});

describe('toCsv', () => {
  it('正常: CRLF 区切り・末尾にも CRLF（Excel と会計ソフトが期待する形）', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('a,b\r\n1,2\r\n');
  });

  it('境界: 空の行配列でも末尾 CRLF を返す（ヘッダだけの CSV と同じ扱い）', () => {
    expect(toCsv([])).toBe('\r\n');
  });

  it('正常: parseCsv と往復する（引用が要る値を含んでも）', () => {
    const rows = [['日付', '摘要'], ['2026-09-10', 'a,b "c"']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('rowToRecord', () => {
  it('正常: 列名 → 値のオブジェクトに写す', () => {
    expect(rowToRecord(['a', 'b'], ['1', '2'])).toEqual({ a: '1', b: '2' });
  });

  it('境界: 列数が足りない行は空文字で埋める（末尾の列が欠けた明細 CSV）', () => {
    expect(rowToRecord(['a', 'b', 'c'], ['1'])).toEqual({ a: '1', b: '', c: '' });
  });

  it('境界: 余った値は捨てる。ヘッダが空なら空オブジェクト', () => {
    expect(rowToRecord(['a'], ['1', '2'])).toEqual({ a: '1' });
    expect(rowToRecord([], ['1'])).toEqual({});
  });
});
