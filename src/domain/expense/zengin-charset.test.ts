import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from './errors';
import { checkZenginName, encodeZenginText, toZenginText, zenginByteLength, ZENGIN_HOLDER_NAME_MAX_BYTES } from './zengin-charset';

describe('toZenginText（§20.6.3 の書式の変換）', () => {
  it('正常: 全角カナは半角カナにし、濁点・半濁点は別の 1 文字に分ける（書式の変換としては数えない）', () => {
    expect(toZenginText('テストタロウ')).toEqual({ text: 'ﾃｽﾄﾀﾛｳ', converted: false, invalid: [] });
    const voiced = toZenginText('ガパヴ');
    expect(voiced.text).toBe('ｶﾞﾊﾟｳﾞ');
    expect(zenginByteLength(voiced.text)).toBe(6);
  });

  it('正常: ひらがな・全角英数・全角スペース・全角括弧・ピリオド・ハイフンは幅の変換だけ', () => {
    expect(toZenginText('かぶしきがいしゃ')).toMatchObject({ text: 'ｶﾌﾞｼｷｶﾞｲｼｬ'.replace('ｬ', 'ﾔ'), converted: true });
    expect(toZenginText('ＡＢＣ１２３　（．－）')).toEqual({ text: 'ABC123 (.-)', converted: false, invalid: [] });
    expect(toZenginText('テスト゛')).toMatchObject({ text: 'ﾃｽﾄﾞ', converted: false });
  });

  it('正常: 小書き → 並字・長音 → ハイフン・英小文字 → 大文字は、人が確かめる書式の変換として converted にする', () => {
    expect(toZenginText('キャッシュ')).toEqual({ text: 'ｷﾔﾂｼﾕ', converted: true, invalid: [] });
    expect(toZenginText('ルーム')).toEqual({ text: 'ﾙ-ﾑ', converted: true, invalid: [] });
    expect(toZenginText('abc')).toEqual({ text: 'ABC', converted: true, invalid: [] });
    expect(toZenginText('ａｂ')).toEqual({ text: 'AB', converted: true, invalid: [] });
    expect(toZenginText('ｧｯ')).toEqual({ text: 'ｱﾂ', converted: true, invalid: [] });
  });

  it('境界: ヲ（ｦ）は strict では ｵ に寄せて converted、extended ではそのまま', () => {
    expect(toZenginText('ヲ', 'strict')).toEqual({ text: 'ｵ', converted: true, invalid: [] });
    expect(toZenginText('ヲ', 'extended')).toEqual({ text: 'ｦ', converted: false, invalid: [] });
  });

  it('境界: 記号 / , ¥ ｢ ｣ は extended だけで通り、strict では変換しないで位置を返す', () => {
    expect(toZenginText('Ａ／Ｂ，￥「」', 'extended')).toEqual({ text: 'A/B,¥｢｣', converted: false, invalid: [] });
    expect(toZenginText('A/B', 'strict').invalid).toEqual([{ char: '/', index: 1 }]);
  });

  it('異常: 中点・漢字は判断が要るので変換せず、文字と位置（コードポイント単位）を返す', () => {
    const result = toZenginText('テスト・太郎');
    expect(result.invalid).toEqual([{ char: '・', index: 3 }, { char: '太', index: 4 }, { char: '郎', index: 5 }]);
    expect(result.text).toBe('ﾃｽﾄ・太郎');
  });
});

describe('checkZenginName（名義 30 バイト）', () => {
  it('境界: 変換後 30 バイトは通り、31 バイトは tooLong（濁点を含む境界）', () => {
    const thirty = `${'ｱ'.repeat(28)}ｶﾞ`;
    expect(checkZenginName(thirty, ZENGIN_HOLDER_NAME_MAX_BYTES)).toMatchObject({ bytes: 30, tooLong: false });
    expect(checkZenginName(`${'ア'.repeat(29)}ガ`, ZENGIN_HOLDER_NAME_MAX_BYTES)).toMatchObject({ bytes: 31, tooLong: true, maxBytes: 30 });
  });

  it('境界: 依頼人名は 40 バイト、前後の空白は数えない', () => {
    expect(checkZenginName(`  ${'ｱ'.repeat(40)} `, 40)).toMatchObject({ bytes: 40, tooLong: false });
    expect(checkZenginName('ｱ'.repeat(41), 40).tooLong).toBe(true);
  });
});

describe('encodeZenginText（JIS X 0201 のバイト列）', () => {
  it('正常: ASCII はそのまま、半角カナは 0xA1〜0xDF、¥ は 0x5C', () => {
    expect([...encodeZenginText('A1 ｱﾟ¥')]).toEqual([0x41, 0x31, 0x20, 0xb1, 0xdf, 0x5c]);
    expect([...encodeZenginText('｡')]).toEqual([0xa1]);
  });

  it('例外: 変換していない文字（全角・バックスラッシュ）は実装の誤りとして投げる', () => {
    expect(() => encodeZenginText('ア')).toThrow(ExpenseDomainError);
    expect(() => encodeZenginText('\\')).toThrow(/cannot be written/u);
  });
});
