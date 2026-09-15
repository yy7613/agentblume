import { describe, expect, it } from 'vitest';
import { CLAIM_CSV_MAX_ROWS, matchClaimCsvColumns, normalizeCsvHeader, parseClaimCsv } from './claim-csv';
import { ExpenseCsvImportError } from './errors';

const csv = (...lines: string[]): string => `${lines.join('\r\n')}\r\n`;
const parse = (content: string, requireClaimant = true) => parseClaimCsv(content, { requireClaimant });

function importError(action: () => unknown): ExpenseCsvImportError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ExpenseCsvImportError);
    return error as ExpenseCsvImportError;
  }
  throw new Error('ExpenseCsvImportError was not thrown');
}

describe('列の対応', () => {
  it('正常: 日本語・英語の別名、全角・空白・大小違いを同じ列として当てる', () => {
    const matches = matchClaimCsvColumns(['氏名', 'ＤＡＴＥ', ' 税込 金額 ', 'Vendor', '経費科目', '稟議番号', '使わない列']);
    expect(matches.map((match) => match.field)).toEqual(['claimant', 'transactionDate', 'amount', 'payeeName', 'category', 'preApprovalRef', null]);
  });

  it('境界: 同じ項目に当たる列が複数あれば先の列を採り、後の列は使わない', () => {
    expect(matchClaimCsvColumns(['日付', '利用日']).map((match) => match.field)).toEqual(['transactionDate', null]);
  });

  it('正常: normalizeCsvHeader は BOM を落とす', () => {
    expect(normalizeCsvHeader('﻿申請者')).toBe('申請者');
  });
});

describe('parseClaimCsv: 正常', () => {
  it('正常: 全項目を読み、行番号（ヘッダ = 1）と生値を残す', () => {
    const content = csv(
      '申請者,社員番号,部署,日付,支払先,金額,費目,目的,人数,参加者,関係,日数,支払方法,会社払い,登録番号,事前承認番号,摘要',
      '山田 太郎,E001,営業部,2026/9/10,甲商店,"1,100",タクシー,訪問,2名,乙；丙; ,取引先,1泊,クレジットカード,はい,T-1234-5678-90123,R-1,メモ',
    );
    const result = parse(content);
    expect(result.skippedRows).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row).toMatchObject({
      line: 2,
      claimant: { name: '山田 太郎', employeeCode: 'E001', department: '営業部' },
      categoryText: 'タクシー',
      facts: {
        transactionDate: '2026-09-10', dateSource: 'manual', payeeName: '甲商店', amount: 1100, paymentMethod: 'credit_card', corporatePayment: true,
        description: 'メモ', purpose: '訪問', attendees: { count: 2, names: ['乙', '丙'], relation: '取引先' }, unitCount: 1, registrationNumber: 'T1234567890123', preApprovalRef: 'R-1',
      },
      warnings: [],
    });
    expect(row.record['金額']).toBe('1,100');
    expect(result.columnMatches).toHaveLength(17);
  });

  it('正常: 会社払い いいえ は false、空欄は持たない', () => {
    const result = parse(csv('申請者,日付,金額,会社払い', '太郎,2026-09-10,100,いいえ', '太郎,2026-09-10,100,'));
    expect(result.rows[0]!.facts.corporatePayment).toBe(false);
    expect(result.rows[1]!.facts).not.toHaveProperty('corporatePayment');
    expect(result.rows[1]!.facts).toEqual({ transactionDate: '2026-09-10', dateSource: 'manual', amount: 100 });
  });

  it('正常: requireClaimant false なら申請者の列が無くても読み、行に claimant を持たない', () => {
    const result = parse(csv('日付,金額', '2026-09-10,100'), false);
    expect(result.rows[0]).not.toHaveProperty('claimant');
  });

  it('正常: BOM 付き・LF のファイルも読む', () => {
    const result = parse('﻿申請者,日付,金額\n太郎,2026-09-10,100\n');
    expect(result.rows).toHaveLength(1);
  });
});

describe('parseClaimCsv: 読めない値は空にして警告', () => {
  it.each([
    ['日付', '日付', 'きのう', '日付「きのう」を読めなかったので空にしました', 'transactionDate'],
    ['金額', '金額', 'たくさん', '金額「たくさん」を読めなかったので空にしました', 'amount'],
    ['人数', '人数', '0名', '参加人数「0名」を読めなかったので空にしました', 'attendees'],
    ['人数（文字）', '人数', '数名', '参加人数「数名」を読めなかったので空にしました', 'attendees'],
    ['日数', '日数', '0日', '日数・泊数「0日」を読めなかったので空にしました', 'unitCount'],
    ['日数（文字）', '日数', '半日', '日数・泊数「半日」を読めなかったので空にしました', 'unitCount'],
    ['支払方法', '支払方法', 'ツケ', '支払方法「ツケ」が分からなかったので空にしました', 'paymentMethod'],
    ['会社払い', '会社払い', 'たぶん', '会社払い「たぶん」が分からなかったので空にしました', 'corporatePayment'],
    ['登録番号', '登録番号', 'T12345', '登録番号「T12345」は T + 数字 13 桁の形ではない（数字 5 桁）ため採用していません', 'registrationNumber'],
  ])('異常: %s', (_label, column, value, message, factKey) => {
    const header = column === '日付' || column === '金額' ? '申請者,日付,金額' : `申請者,日付,金額,${column}`;
    const body = column === '日付' ? `太郎,${value},100` : column === '金額' ? `太郎,2026-09-10,${value}` : `太郎,2026-09-10,100,${value}`;
    const result = parse(csv(header, body));
    expect(result.skippedRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.facts).not.toHaveProperty(factKey);
    expect(result.rows[0]!.warnings[0]).toContain(`2 行目: ${message}`);
    expect(result.warnings).toEqual(result.rows[0]!.warnings);
  });

  it('異常: 形の合わない登録番号は rejectedRegistrationNumber に生の文字列を残す', () => {
    const result = parse(csv('申請者,日付,金額,登録番号', '太郎,2026-09-10,100,T12345'));
    expect(result.rows[0]!.rejectedRegistrationNumber).toBe('T12345');
  });
});

describe('parseClaimCsv: 壊れた行と前提違反', () => {
  it('異常: 列数不一致の行は skippedRows（行番号はヘッダ = 1）で、他の行は読む', () => {
    const result = parse(csv('申請者,日付,金額', '太郎,2026-09-10', '花子,2026-09-11,200', '次郎,2026-09-12,300,余分'));
    expect(result.rows.map((row) => row.line)).toEqual([3]);
    expect(result.skippedRows.map((row) => row.row)).toEqual([2, 4]);
    expect(result.skippedRows[0]!.reason).toContain('列の数（2）がヘッダ（3）と合いません');
  });

  it('異常: 申請者が空欄の行は skip する（requireClaimant のときだけ）', () => {
    const content = csv('申請者,日付,金額', ',2026-09-10,100', '太郎,2026-09-10,100');
    expect(parse(content).skippedRows).toEqual([{ row: 2, reason: '申請者が空欄です。申請者の氏名を入れてください' }]);
    expect(parse(content, false).rows).toHaveLength(2);
  });

  it('異常: 取引日・金額の列が無ければ ExpenseCsvImportError（見つかった列を並べる）', () => {
    expect(importError(() => parse(csv('申請者,金額', '太郎,100'))).message).toContain('取引日の列が見つかりません');
    const noAmount = importError(() => parse(csv('申請者,日付', '太郎,2026-09-10')));
    expect(noAmount.message).toContain('金額の列が見つかりません');
    expect(noAmount.message).toContain('見つかった列: 申請者, 日付');
  });

  it('異常: 申請者の列が無いのは requireClaimant のときだけ ExpenseCsvImportError', () => {
    expect(importError(() => parse(csv('日付,金額', '2026-09-10,100'))).message).toContain('申請者の列が見つかりません');
    expect(parse(csv('日付,金額', '2026-09-10,100'), false).rows).toHaveLength(1);
  });

  it('境界: 明細 2000 行は読み、2001 行で拒否する', () => {
    const lines = (count: number): string[] => Array.from({ length: count }, () => '太郎,2026-09-10,100');
    expect(parse(csv('申請者,日付,金額', ...lines(CLAIM_CSV_MAX_ROWS))).rows).toHaveLength(2000);
    expect(importError(() => parse(csv('申請者,日付,金額', ...lines(CLAIM_CSV_MAX_ROWS + 1)))).message).toContain('2001 行');
  });

  it('例外: 引用符の閉じ忘れは ExpenseCsvImportError（行番号付き）', () => {
    const error = importError(() => parse('申請者,日付,金額\r\n"太郎,2026-09-10,100\r\n'));
    expect(error.message).toContain('引用符');
    expect(error.row).toBeTypeOf('number');
  });

  it('異常: 空ファイル・空行だけは ExpenseCsvImportError', () => {
    expect(importError(() => parse('')).message).toContain('CSV に行がありません');
    expect(importError(() => parse('\r\n , \r\n')).message).toContain('CSV に行がありません');
  });
});
