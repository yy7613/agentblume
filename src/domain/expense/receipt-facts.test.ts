import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from './errors';
import { digitCount, sanitizeReceiptFacts, usableAmount, validateReceiptFacts } from './receipt-facts';

describe('validateReceiptFacts', () => {
  it('正常: 全項目を持つ事実を前後空白を除いて複製する', () => {
    const facts = validateReceiptFacts({
      transactionDate: '2026-09-10', issueDate: '2026-09-11', payeeName: ' 甲商店 ', registrationNumber: 'T1234567890123', amount: 1100,
      totalsByRate: [{ rate: 10, taxableAmount: 1100, taxAmount: 100, amountIncludesTax: true }], paymentMethod: 'cash', corporatePayment: false,
      description: ' 説明 ', purpose: '訪問', attendees: { count: 2, names: [' 乙 ', ' '], relation: '取引先' }, unitCount: 1, preApprovalRef: 'R-1', dateSource: 'issue-copied',
    });
    expect(facts).toEqual({
      transactionDate: '2026-09-10', issueDate: '2026-09-11', payeeName: '甲商店', registrationNumber: 'T1234567890123', amount: 1100,
      totalsByRate: [{ rate: 10, taxableAmount: 1100, taxAmount: 100, amountIncludesTax: true }], paymentMethod: 'cash', corporatePayment: false,
      description: '説明', purpose: '訪問', attendees: { count: 2, names: ['乙'], relation: '取引先' }, unitCount: 1, preApprovalRef: 'R-1', dateSource: 'issue-copied',
    });
  });

  it('境界: null・空文字・空配列・空の参加者は無いものとして落とす', () => {
    expect(validateReceiptFacts({ payeeName: '  ', amount: null, totalsByRate: [], attendees: { names: [' '] }, paymentMethod: null, corporatePayment: null, dateSource: null })).toEqual({});
  });

  it('境界: 0 円・負の金額は形としては通す（判定で amount-missing にする）', () => {
    expect(validateReceiptFacts({ amount: 0 }).amount).toBe(0);
  });

  it.each([
    ['object でない', [], /must be an object/u],
    ['実在しない日付', { transactionDate: '2026-02-30' }, /transactionDate must be a date/u],
    ['登録番号の形', { registrationNumber: 'T123' }, /T followed by 13 digits/u],
    ['登録番号の型', { registrationNumber: 123 }, /registrationNumber must be a string/u],
    ['小数の金額', { amount: 1.5 }, /amount must be an integer/u],
    ['人数 0', { attendees: { count: 0 } }, /attendees.count must be at least 1/u],
    ['日数 0', { unitCount: 0 }, /unitCount must be at least 1/u],
    ['支払方法', { paymentMethod: 'paypay' }, /paymentMethod must be one of/u],
    ['会社払い', { corporatePayment: 'yes' }, /corporatePayment must be a boolean/u],
    ['日付の出所', { dateSource: 'guess' }, /dateSource must be one of/u],
    ['支払先の長さ', { payeeName: 'x'.repeat(201) }, /payeeName must be at most 200/u],
    ['参加者の形', { attendees: [] }, /attendees must be an object/u],
    ['参加者名の型', { attendees: { names: [1] } }, /names must be an array of strings/u],
    ['参加者名の件数', { attendees: { names: Array.from({ length: 51 }, () => 'a') } }, /at most 50 entries/u],
    ['税率別の型', { totalsByRate: {} }, /totalsByRate must be an array/u],
    ['税率別の件数', { totalsByRate: Array.from({ length: 11 }, () => ({ rate: 10, taxableAmount: 1, amountIncludesTax: true })) }, /at most 10 entries/u],
    ['税率別の要素', { totalsByRate: [null] }, /totalsByRate\[0\] must be an object/u],
    ['税率', { totalsByRate: [{ rate: 5, taxableAmount: 1, amountIncludesTax: true }] }, /rate must be one of/u],
    ['課税対象額なし', { totalsByRate: [{ rate: 10, amountIncludesTax: true }] }, /taxableAmount must be an integer/u],
    ['税込フラグ', { totalsByRate: [{ rate: 10, taxableAmount: 1 }] }, /amountIncludesTax must be a boolean/u],
  ])('異常: %s は ExpenseDomainError', (_label, value, message) => {
    expect(() => validateReceiptFacts(value)).toThrow(ExpenseDomainError);
    expect(() => validateReceiptFacts(value)).toThrow(message);
  });

  it('正常: ラベルをエラー文言に使う', () => {
    expect(() => validateReceiptFacts({ amount: 'x' }, 'items[0].facts')).toThrow(/items\[0\]\.facts\.amount/u);
  });
});

describe('sanitizeReceiptFacts', () => {
  it('正常: 登録番号を正規化する（全角・ハイフン・小文字 t）', () => {
    const result = sanitizeReceiptFacts({ registrationNumber: 'ｔ1234-5678-90123', amount: 100 });
    expect(result).toEqual({ facts: { registrationNumber: 'T1234567890123', amount: 100 }, warnings: [] });
  });

  it('異常: 形の合わない登録番号は落として警告と生の文字列を残す（400 にしない）', () => {
    // 桁数誤りは読取で最も多い失敗で、取込全体を止めると人が直す機会を失う
    const result = sanitizeReceiptFacts({ registrationNumber: ' T123456789012 ', amount: 100 });
    expect(result.facts).toEqual({ amount: 100 });
    expect(result.rejectedRegistrationNumber).toBe('T123456789012');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('数字 12 桁');
  });

  it('境界: 空の登録番号は警告しない', () => {
    expect(sanitizeReceiptFacts({ registrationNumber: '  ' })).toEqual({ facts: {}, warnings: [] });
  });

  it('異常: 登録番号以外の不正は検証が 400 で断る', () => {
    expect(() => sanitizeReceiptFacts({ registrationNumber: 'T1', amount: 'x' })).toThrow(ExpenseDomainError);
    expect(() => sanitizeReceiptFacts(null)).toThrow(/must be an object/u);
  });

  it('正常: 元の入力を変更しない', () => {
    const input = { registrationNumber: 'bad' };
    sanitizeReceiptFacts(input);
    expect(input).toEqual({ registrationNumber: 'bad' });
  });
});

describe('digitCount / usableAmount', () => {
  it('正常: 全角数字も数える', () => {
    expect(digitCount('T１２3')).toBe(3);
    expect(digitCount('なし')).toBe(0);
  });

  it('境界: 1 円以上だけ使える金額', () => {
    expect(usableAmount({ amount: 1 })).toBe(1);
    expect(usableAmount({ amount: 0 })).toBeUndefined();
    expect(usableAmount({ amount: -10 })).toBeUndefined();
    expect(usableAmount({})).toBeUndefined();
  });
});
