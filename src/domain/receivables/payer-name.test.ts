import { describe, expect, it } from 'vitest';
import { normalizePayerName, payerNameFromDescription, ZENGIN_CORPORATE_ABBREVIATIONS } from './payer-name';

const fromDescription = (text: string) => normalizePayerName(payerNameFromDescription(text));

describe('payerNameFromDescription（摘要からの切り出し）', () => {
  it('正常: 種別語と 6 桁以上の依頼人コードを除く', () => {
    expect(payerNameFromDescription('ﾌﾘｺﾐ 1234567890 ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ')).toBe('カ)ヤマダショウジ');
    expect(payerNameFromDescription('振込１ テスト')).toBe('テスト');
    expect(payerNameFromDescription('IB 振込 サンプル')).toBe('サンプル');
  });

  it('境界: 6 桁は除き、5 桁は名前の一部として残す。種別語は先頭だけ落とす', () => {
    expect(payerNameFromDescription('ﾌﾘｺﾐ 123456 ﾃｽﾄ')).toBe('テスト');
    expect(payerNameFromDescription('ﾌﾘｺﾐ 12345 ﾃｽﾄ')).toBe('12345 テスト');
    expect(payerNameFromDescription('ﾃｽﾄ ﾌﾘｺﾐ')).toBe('テスト フリコミ');
  });

  it('例外: 空・非文字列は空文字', () => {
    expect(payerNameFromDescription('')).toBe('');
    expect(payerNameFromDescription(undefined)).toBe('');
    expect(payerNameFromDescription(null)).toBe('');
  });
});

describe('normalizePayerName（照合用の正規化）', () => {
  it('正常: 半角カナ → 全角（濁点を合成）・小書き → 並字・法人略語の除去', () => {
    expect(fromDescription('ﾌﾘｺﾐ 1234567890 ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ')).toBe('ヤマダシヨウジ');
    expect(fromDescription('ﾌﾘｺﾐ ﾃｽﾄｺｳｷﾞﾖｳ')).toBe('テストコウギヨウ');
    expect(normalizePayerName('ｻﾝﾌﾟﾙｼｮｳｼﾞ')).toBe(normalizePayerName('サンプルシヨウジ'));
  });

  it.each(ZENGIN_CORPORATE_ABBREVIATIONS)('正常: 略語 %s) を前置・後置・中置の 3 形で落とす', (abbreviation) => {
    expect(normalizePayerName(`${abbreviation})テスト`)).toBe('テスト');
    expect(normalizePayerName(`テスト(${abbreviation}`)).toBe('テスト');
    expect(normalizePayerName(`テスト(${abbreviation})シヨウジ`)).toBe('テストシヨウジ');
  });

  it('境界: 括弧の無い「カ」で終わる名前は削らない。小書きの略語（シャ)）も並字化してから落とす', () => {
    expect(normalizePayerName('ﾔﾏﾀﾞｶ')).toBe('ヤマダカ');
    expect(normalizePayerName('ｼｬ)ﾃｽﾄ')).toBe('テスト');
    expect(normalizePayerName('ﾄｸﾋ)ｻﾝﾌﾟﾙ')).toBe('サンプル');
  });

  it('正常: ひらがな → カタカナ、長音とハイフンの揺れを 1 種に、空白・中黒・括弧・スラッシュを除く、ラテン文字は大文字', () => {
    expect(normalizePayerName('やまだ たろう')).toBe('ヤマダタロウ');
    expect(normalizePayerName('ABC-def')).toBe(normalizePayerName('ＡＢＣ－ＤＥＦ'));
    expect(normalizePayerName('ABC-def')).toBe('ABCーDEF');
    expect(normalizePayerName('サンプル・デザイン／東京（本店）')).toBe('サンプルデザイン東京本店');
  });

  it('正常: 仕訳の法人略号（株式会社・(株)）も落ちる。漢字をカナへは推測しない', () => {
    expect(normalizePayerName('株式会社サンプル商事')).toBe('サンプル商事');
    expect(normalizePayerName('山田商事(株)')).toBe('山田商事');
  });

  it('例外: 空・非文字列は空文字', () => {
    expect(normalizePayerName('')).toBe('');
    expect(normalizePayerName(undefined)).toBe('');
    expect(normalizePayerName('   ')).toBe('');
  });
});
