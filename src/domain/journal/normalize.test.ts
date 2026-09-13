import { describe, expect, it } from 'vitest';
import { counterpartyFromDescription, normalizeDescription, normalizeRegistrationNumber, parseAmount, parseJapaneseDate } from './normalize';

describe('normalizeDescription', () => {
  it('正常: 半角カナを全角にし、法人略号（ｶ) / (株) / ㈱ / 有)）を落とし、連続空白を圧縮する', () => {
    expect(normalizeDescription('振込 ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ')).toBe('振込 ヤマダショウジ');
    expect(normalizeDescription('振込　ｶﾌﾞ)ｻﾄｳ')).toBe('振込 サトウ');
    expect(normalizeDescription('(株)山田商事  御中')).toBe('山田商事 御中');
    expect(normalizeDescription('㈱山田商事')).toBe('山田商事');
    expect(normalizeDescription('有)ｽｽﾞｷ')).toBe('スズキ');
    expect(normalizeDescription('ﾃﾞﾝｷﾀﾞｲ (ｶ')).toBe('デンキダイ');
  });

  it('正常: NFKC で全角英数を半角にする（数字列は残す）', () => {
    expect(normalizeDescription('ＡＭＡＺＯＮ　１２３４')).toBe('AMAZON 1234');
  });

  it('境界: 空・空白・非文字列は空文字', () => {
    expect(normalizeDescription('')).toBe('');
    expect(normalizeDescription('   ')).toBe('');
    expect(normalizeDescription(undefined)).toBe('');
    expect(normalizeDescription(null)).toBe('');
  });
});

describe('normalizeRegistrationNumber', () => {
  it('正常: ハイフン・空白・全角・小文字を正規化して T + 13 桁にする', () => {
    expect(normalizeRegistrationNumber('T-1234567890123')).toBe('T1234567890123');
    expect(normalizeRegistrationNumber('Ｔ１２３４５６７８９０１２３')).toBe('T1234567890123');
    expect(normalizeRegistrationNumber(' t 1234 5678 90123 ')).toBe('T1234567890123');
  });

  it('異常: 桁が違う・T が無い・非文字列は undefined', () => {
    expect(normalizeRegistrationNumber('T123456789012')).toBeUndefined();
    expect(normalizeRegistrationNumber('1234567890123')).toBeUndefined();
    expect(normalizeRegistrationNumber('T12345678901234')).toBeUndefined();
    expect(normalizeRegistrationNumber(undefined)).toBeUndefined();
  });
});

describe('parseJapaneseDate', () => {
  it('正常: 西暦の各表記', () => {
    expect(parseJapaneseDate('2026/9/13')).toBe('2026-09-13');
    expect(parseJapaneseDate('2026-09-13')).toBe('2026-09-13');
    expect(parseJapaneseDate('2026.9.13')).toBe('2026-09-13');
    expect(parseJapaneseDate('20260913')).toBe('2026-09-13');
    expect(parseJapaneseDate('2026年9月13日')).toBe('2026-09-13');
    expect(parseJapaneseDate('２０２６／９／１３')).toBe('2026-09-13');
  });

  it('正常: 和暦（R / H / 令和 / 平成 / 元年）', () => {
    expect(parseJapaneseDate('R8.9.13')).toBe('2026-09-13');
    expect(parseJapaneseDate('R08/09/13')).toBe('2026-09-13');
    expect(parseJapaneseDate('令和8年9月13日')).toBe('2026-09-13');
    expect(parseJapaneseDate('令和元年5月1日')).toBe('2019-05-01');
    expect(parseJapaneseDate('H31.4.30')).toBe('2019-04-30');
    expect(parseJapaneseDate('平成31年4月30日')).toBe('2019-04-30');
  });

  it('境界: 2 桁年は 2000 年代、うるう日は受け、存在しない日は undefined', () => {
    expect(parseJapaneseDate('26/09/13')).toBe('2026-09-13');
    expect(parseJapaneseDate('2024/2/29')).toBe('2024-02-29');
    expect(parseJapaneseDate('2025/2/29')).toBeUndefined();
    expect(parseJapaneseDate('2026/13/01')).toBeUndefined();
  });

  it('異常: 解釈できない文字列・空・非文字列は undefined', () => {
    expect(parseJapaneseDate('yesterday')).toBeUndefined();
    expect(parseJapaneseDate('')).toBeUndefined();
    expect(parseJapaneseDate('2026/9')).toBeUndefined();
    expect(parseJapaneseDate(undefined)).toBeUndefined();
  });
});

describe('parseAmount', () => {
  it('正常: 通貨記号・カンマ・円・全角数字', () => {
    expect(parseAmount('¥1,234')).toBe(1234);
    expect(parseAmount('1,234円')).toBe(1234);
    expect(parseAmount('１，２３４')).toBe(1234);
    expect(parseAmount('  1234 ')).toBe(1234);
    expect(parseAmount(1234)).toBe(1234);
  });

  it('正常: 負号（- / △ / ▲ / 括弧 / 末尾 -）', () => {
    expect(parseAmount('-1,234')).toBe(-1234);
    expect(parseAmount('△1,234')).toBe(-1234);
    expect(parseAmount('▲1234')).toBe(-1234);
    expect(parseAmount('(1,234)')).toBe(-1234);
    expect(parseAmount('1,234-')).toBe(-1234);
  });

  it('境界: 0、小数点以下が 0 の表記は整数として受ける', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('1,234.00')).toBe(1234);
  });

  it('異常: 端数のある小数・文字・空・非整数 number は undefined', () => {
    expect(parseAmount('1,234.5')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount(12.5)).toBeUndefined();
    expect(parseAmount(null)).toBeUndefined();
  });
});

describe('counterpartyFromDescription', () => {
  it('正常: 種別語（振込・口座振替 …）の次の語を相手先にする', () => {
    expect(counterpartyFromDescription('振込 ヤマダショウジ')).toBe('ヤマダショウジ');
    expect(counterpartyFromDescription('口座振替 トウキョウデンリョク 9月分')).toBe('トウキョウデンリョク');
    expect(counterpartyFromDescription('AMAZON.CO.JP')).toBe('AMAZON.CO.JP');
  });

  it('境界: 数字だけの語は飛ばす。種別語しか無い・空は undefined', () => {
    expect(counterpartyFromDescription('振込 12345 サトウ')).toBe('サトウ');
    expect(counterpartyFromDescription('振込')).toBeUndefined();
    expect(counterpartyFromDescription('')).toBeUndefined();
    expect(counterpartyFromDescription(undefined)).toBeUndefined();
  });
});

describe('counterpartyFromDescription（カナ表記・ゆうちょ表記の種別語）', () => {
  it('正常: カタカナの種別語（フリコミ / コウザフリカエ）を飛ばして相手先を返す', () => {
    expect(counterpartyFromDescription(normalizeDescription('ﾌﾘｺﾐ ｶ)ｻﾝﾌﾟﾙｼｮｳｼﾞ'))).toBe('サンプルショウジ');
    expect(counterpartyFromDescription(normalizeDescription('ｺｳｻﾞﾌﾘｶｴ ﾄｳｷｮｳﾃﾞﾝﾘｮｸ'))).toBe('トウキョウデンリョク');
  });

  it('正常: ゆうちょの「自動払込み」も種別語として飛ばす', () => {
    expect(counterpartyFromDescription('自動払込み トウキョウデンリョク')).toBe('トウキョウデンリョク');
  });

  it('境界: 種別語しかない摘要は相手先を返さない', () => {
    expect(counterpartyFromDescription('ATM ヒキダシ')).toBeUndefined();
    expect(counterpartyFromDescription('テスウリョウ')).toBeUndefined();
  });

  it('異常: 空文字・空白のみ・非文字列は undefined', () => {
    expect(counterpartyFromDescription('')).toBeUndefined();
    expect(counterpartyFromDescription('   ')).toBeUndefined();
    expect(counterpartyFromDescription(null)).toBeUndefined();
  });
});

describe('normalize（壊れた入力の扱い）', () => {
  it('例外: 解釈できない日付・金額・登録番号は throw せず undefined を返す', () => {
    expect(parseJapaneseDate('令和99年13月45日')).toBeUndefined();
    expect(parseJapaneseDate('')).toBeUndefined();
    expect(parseAmount('￥￥￥')).toBeUndefined();
    expect(normalizeRegistrationNumber('T12')).toBeUndefined();
  });

  it('例外: 制御文字や極端に長い文字列を渡しても throw しない', () => {
    expect(() => normalizeDescription('\u0000制御\u001f文字')).not.toThrow();
    expect(() => normalizeDescription('ア'.repeat(20000))).not.toThrow();
    expect(() => counterpartyFromDescription('ア'.repeat(20000))).not.toThrow();
  });

  it('例外: 文字列以外（null / undefined）を渡しても throw せず undefined を返す', () => {
    expect(counterpartyFromDescription(null)).toBeUndefined();
    expect(counterpartyFromDescription(undefined)).toBeUndefined();
  });
});
