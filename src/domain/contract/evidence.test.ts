import { describe, expect, it } from 'vitest';
import { createQuoteLocator, normalizeForMatch, quoteAppearsIn } from './evidence';

describe('evidence: normalizeForMatch', () => {
  it.each([
    ['ＡＢＣ　１２３', 'ABC123'],
    ['甲は\n乙に 対し', '甲は乙に対し'],
    ['㈱サンプル', '(株)サンプル'],
    ['ｶﾞ', 'ガ'],
    ['   ', ''],
  ])('正常: 「%s」→「%s」（NFKC・空白と改行を除く）', (value, expected) => {
    expect(normalizeForMatch(value)).toBe(expected);
  });
});

describe('evidence: createQuoteLocator', () => {
  it('正常: 完全一致なら原文の位置を返す', () => {
    const body = '第1条　甲は乙に対し業務を委託する。';
    const locate = createQuoteLocator(body);
    const hit = locate('甲は乙に対し業務を委託する。');
    expect(hit).toEqual({ start: 4, end: body.length });
    expect(body.slice(hit!.start, hit!.end)).toBe('甲は乙に対し業務を委託する。');
  });

  it('正常: 全角・半角の違い（NFKC）を吸収する', () => {
    expect(createQuoteLocator('前文 ＡＢＣ１２３ 以上')('ABC123')).toEqual({ start: 3, end: 9 });
  });

  it('正常: 空白差・改行位置の違いを吸収し、原文の範囲は改行を含む', () => {
    const body = '甲は、乙に対し、\n本業務を委託し、\n乙はこれを受託する。';
    const hit = createQuoteLocator(body)('甲は、乙に対し、本業務を 委託し、乙はこれを受託する。');
    expect(hit).toEqual({ start: 0, end: body.length });
  });

  it('正常: NFKC で文字数が変わる字（㈱）でも原文位置へ戻す', () => {
    const body = 'x㈱サンプル商事y';
    expect(createQuoteLocator(body)('(株)サンプル商事')).toEqual({ start: 1, end: 8 });
  });

  it('境界: 末尾がサロゲートペアの字なら end は 2 コード単位先', () => {
    const body = 'あ野𠮷い';
    const hit = createQuoteLocator(body)('野𠮷');
    expect(hit).toEqual({ start: 1, end: 4 });
    expect(body.slice(hit!.start, hit!.end)).toBe('野𠮷');
  });

  it('正常: 半角カナの濁点（ｶﾞ）と全角の「ガ」を同じ字として照合し、原文の範囲は濁点まで含む', () => {
    const body = 'ｻﾝﾌﾟﾙｶﾞ支払う';
    expect(createQuoteLocator(body)('サンプルガ')).toEqual({ start: 0, end: 7 });
    expect(createQuoteLocator('サンプルガ支払う')('ｻﾝﾌﾟﾙｶﾞ')).toEqual({ start: 0, end: 5 });
  });

  it('境界: 引用より前にサロゲートペアがあっても位置がずれない', () => {
    const body = '𠮷野家の甲は乙に支払う。';
    const hit = createQuoteLocator(body)('甲は乙に支払う。');
    expect(body.slice(hit!.start, hit!.end)).toBe('甲は乙に支払う。');
    expect(createQuoteLocator(body)('乙', { start: 6, end: body.length })).toEqual({ start: 7, end: 8 });
  });

  it.each([
    ['言い換え', '甲は乙へ業務を頼む。'],
    ['省略記号', '甲は…委託する。'],
    ['空の引用', '  \n '],
  ])('異常: %s は見つからない（undefined）', (_label, quote) => {
    expect(createQuoteLocator('甲は乙に対し業務を委託する。')(quote)).toBeUndefined();
  });

  it('正常: within の範囲を優先する（同じ文言が複数の条にある）', () => {
    const body = '第1条 秘密を守る。\n第2条 秘密を守る。';
    const locate = createQuoteLocator(body);
    const second = body.lastIndexOf('秘密');
    expect(locate('秘密を守る。')).toEqual({ start: 4, end: 10 });
    expect(locate('秘密を守る。', { start: 11, end: body.length })).toEqual({ start: second, end: body.length });
  });

  it('境界: within の範囲に無ければ本文全体から探す', () => {
    const body = '第1条 秘密を守る。\n第2条 支払う。';
    expect(createQuoteLocator(body)('秘密を守る。', { start: 11, end: body.length })).toEqual({ start: 4, end: 10 });
  });

  it('境界: within が本文の末尾より後ろでも落ちない', () => {
    const body = '秘密を守る。';
    expect(createQuoteLocator(body)('秘密', { start: 100, end: 200 })).toEqual({ start: 0, end: 2 });
  });
});

describe('evidence: quoteAppearsIn', () => {
  it.each([
    ['甲は乙に対し、委託料を支払う。', '委託料を 支払う', true],
    ['甲は乙に対し、委託料を支払う。', '報酬を支払う', false],
    ['甲は乙に対し、委託料を支払う。', ' ', false],
  ])('正常/異常: 「%s」に「%s」→ %s', (text, quote, expected) => {
    expect(quoteAppearsIn(text, quote)).toBe(expected);
  });
});
