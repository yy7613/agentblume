import { describe, expect, it } from 'vitest';
import {
  accountNumberLast4, bankAccountChanged, createBankAccount, maskBankAccount, normalizeAccountNumber, validateBankCode, validateBranchCode,
  validateHolderKana, validateSealedAccountNumber, yuchoToZengin, type BankAccount,
} from './bank-account';
import { ExpenseDomainError } from './errors';

const AT = '2026-09-15T00:00:00.000Z';
/** 封緘値の形だけを満たす値（domain は暗号を知らない）。 */
const sealed = (plain: string) => ({ v: 1 as const, alg: 'aes-256-gcm' as const, iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plain).toString('base64'), hint: plain.slice(-4) });

function account(overrides: Record<string, unknown> = {}): BankAccount {
  return createBankAccount({ bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: sealed('0000001'), holderKana: 'テスト タロウ', changedAt: AT, changedBy: 'keiri', ...overrides });
}

describe('口座番号の形', () => {
  it('正常: 1〜7 桁は 7 桁に前ゼロ埋め', () => {
    expect(normalizeAccountNumber('1')).toBe('0000001');
    expect(normalizeAccountNumber('1234567')).toBe('1234567');
  });

  it('異常: 8 桁・数字以外・ハイフン入りは 400（黙って外さない）', () => {
    for (const value of ['12345678', '12a', '123-456', '', 1234]) {
      expect(() => normalizeAccountNumber(value)).toThrow(ExpenseDomainError);
    }
    try { normalizeAccountNumber('x'); } catch (error) { expect((error as ExpenseDomainError).details).toEqual({ field: 'accountNumber' }); }
  });

  it('境界: 銀行コードは 4 桁・支店コードは 3 桁ちょうど', () => {
    expect(validateBankCode('0001')).toBe('0001');
    expect(() => validateBankCode('001')).toThrow(/4 digits/u);
    expect(validateBranchCode('001')).toBe('001');
    expect(() => validateBranchCode('0001')).toThrow(/3 digits/u);
  });

  it('異常: 封緘値の形でない・hint が 4 桁の数字でないものは断る', () => {
    expect(validateSealedAccountNumber(sealed('0000123')).hint).toBe('0123');
    expect(() => validateSealedAccountNumber('0000123')).toThrow(/sealed/u);
    expect(() => validateSealedAccountNumber({ ...sealed('0000123'), hint: '' })).toThrow(ExpenseDomainError);
  });
});

describe('名義カナ', () => {
  it('正常: 変換して 30 バイト以内なら入力のまま保存する', () => {
    expect(validateHolderKana(' テスト タロウ ')).toBe('テスト タロウ');
  });

  it('異常: 30 バイト超・使えない文字は、変換後の形と位置を details に付けて断る', () => {
    try {
      validateHolderKana('ア'.repeat(31));
      expect.unreachable();
    } catch (error) {
      expect((error as ExpenseDomainError).details).toMatchObject({ field: 'holderKana', converted: { bytes: 31 } });
    }
    try {
      validateHolderKana('テスト・タロウ');
      expect.unreachable();
    } catch (error) {
      expect((error as ExpenseDomainError).details?.converted?.invalid).toEqual([{ char: '・', index: 3 }]);
      expect((error as ExpenseDomainError).message).toContain('"・" at 4');
    }
    expect(() => validateHolderKana('')).toThrow(/1 to 60/u);
  });
});

describe('createBankAccount / maskBankAccount', () => {
  it('正常: 口座を組み立て、応答用の形は口座番号の封緘値を外して末尾 4 桁だけにする', () => {
    const value = account({ bankNameKana: 'サンプルギンコウ', branchNameKana: '' });
    expect(value).toMatchObject({ bankCode: '9999', bankNameKana: 'サンプルギンコウ', holderKana: 'テスト タロウ' });
    expect(value).not.toHaveProperty('branchNameKana');
    expect(accountNumberLast4(value)).toBe('0001');
    const masked = maskBankAccount(value);
    expect(masked).not.toHaveProperty('accountNumber');
    expect(masked.accountNumberLast4).toBe('0001');
  });

  it('異常: 預金種目・変更者・銀行名の長さ', () => {
    expect(() => account({ accountType: 'foreign' })).toThrow(/accountType/u);
    expect(() => account({ changedBy: '' })).toThrow(ExpenseDomainError);
    expect(() => account({ bankNameKana: 'ア'.repeat(16) })).toThrow(/15 bytes/u);
    expect(() => account({ branchNameKana: 12 })).toThrow(/must be a string/u);
    expect(() => createBankAccount(null)).toThrow(/must be an object/u);
  });

  it('正常: 口座の変更の検出（履歴 bank-account-changed の根拠）', () => {
    const before = account();
    expect(bankAccountChanged(before, account())).toBe(false);
    expect(bankAccountChanged(before, account({ accountNumber: sealed('0000002') }))).toBe(true);
    expect(bankAccountChanged(before, account({ holderKana: 'テスト ハナコ' }))).toBe(true);
    expect(bankAccountChanged(undefined, before)).toBe(true);
    expect(bankAccountChanged(undefined, undefined)).toBe(false);
  });
});

describe('yuchoToZengin（ゆうちょの記号番号）', () => {
  it('正常: 記号が 1 始まりは 支店 = 2〜3 桁目 + 8・口座番号 = 番号の末尾の 1 を除く・普通', () => {
    expect(yuchoToZengin('12340', '12345671')).toEqual({ bankCode: '9900', branchCode: '238', accountType: 'ordinary', accountNumber: '1234567' });
  });

  it('正常: 記号が 0 始まりは 支店 = 2〜3 桁目 + 9・口座番号 = 番号の前ゼロ埋め・当座（全角数字も受ける）', () => {
    expect(yuchoToZengin('０１２３４', '56789')).toEqual({ bankCode: '9900', branchCode: '129', accountType: 'current', accountNumber: '0056789' });
  });

  it('異常: 記号の桁不足・番号の桁不足や末尾・始まりの数字', () => {
    expect(() => yuchoToZengin('1234', '12345671')).toThrow(/5 digits/u);
    expect(() => yuchoToZengin('12340', '1234567')).toThrow(/8 digits ending with 1/u);
    expect(() => yuchoToZengin('12340', '12345670')).toThrow(/ending with 1/u);
    expect(() => yuchoToZengin('01234', '12345678')).toThrow(/1 to 7 digits/u);
    expect(() => yuchoToZengin('21234', '1')).toThrow(/start with 1 or 0/u);
  });
});
