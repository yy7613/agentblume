/**
 * 口座番号の封緘・開封（§20.17-1 の決定）のテスト。
 *
 * 守りたいのは「封緘値に平文が残らない」「hint が 7 桁に揃えた末尾 4 桁」「口座番号を送らない編集は既存の封緘値を保つ」。
 * 本物の暗号（`AesGcmSecretCipher.ephemeral`）と、フィクスチャの可逆な偽の暗号の両方で確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { AesGcmSecretCipher } from '../../adapters/security/aes-gcm-secret-cipher';
import { bankAccountFixture, fixtureAccountCipher, fixtureSealAccountNumber, V9_AT } from '../../adapters/storage/expense-v9.fixtures';
import { ExpenseDomainError } from '../../domain/expense/errors';
import { SecretCipherError, type SecretCipherPort } from '../model-settings/secret-cipher';
import { bankAccountFromInput, openAccountNumber, sealAccountNumber, type BankAccountInput } from './bank-account-secrets';

const input: BankAccountInput = { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: '1234567', holderKana: 'テスト タロウ' };

/** 封緘の呼び出しを数える（省略時に暗号を回していないことを確かめる）。 */
function spyingCipher(base: SecretCipherPort = fixtureAccountCipher): SecretCipherPort & { seal: ReturnType<typeof vi.fn> } {
  return { seal: vi.fn((plaintext: string) => base.seal(plaintext)), open: (sealed) => base.open(sealed) };
}

describe('sealAccountNumber / openAccountNumber', () => {
  it('正常: 本物の暗号で封緘すると平文が封緘値のどこにも残らず、hint は末尾 4 桁。開封で 7 桁に戻る', async () => {
    const cipher = AesGcmSecretCipher.ephemeral();
    const sealed = await sealAccountNumber(cipher, '1234567');
    expect(sealed.hint).toBe('4567');
    expect(JSON.stringify({ ...sealed, hint: undefined })).not.toContain('1234567');
    expect(sealed.data).not.toContain('1234567');
    expect(await openAccountNumber(cipher, sealed)).toBe('1234567');
  });

  it('境界: 7 桁未満は前ゼロ埋めしてから封緘する（hint も 7 桁の末尾 4 桁）', async () => {
    const sealed = await sealAccountNumber(fixtureAccountCipher, '123');
    expect(sealed.hint).toBe('0123');
    expect(await openAccountNumber(fixtureAccountCipher, sealed)).toBe('0000123');
    expect((await sealAccountNumber(fixtureAccountCipher, '1')).hint).toBe('0001');
  });

  it('異常: ハイフン・8 桁・空は封緘する前に 400（accountNumber の欄）で断り、暗号を回さない', async () => {
    const cipher = spyingCipher();
    for (const bad of ['123-4567', '12345678', '', '１２３']) {
      const error = await sealAccountNumber(cipher, bad).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExpenseDomainError);
      expect((error as ExpenseDomainError).details).toEqual({ field: 'accountNumber' });
    }
    expect(cipher.seal).not.toHaveBeenCalled();
  });

  it('異常: 暗号が 4 桁の hint を持たない封緘値を返したら保存させない', async () => {
    const broken: SecretCipherPort = { seal: async (plaintext) => ({ ...await fixtureAccountCipher.seal(plaintext), hint: 'abcd' }), open: fixtureAccountCipher.open };
    await expect(sealAccountNumber(broken, '1234567')).rejects.toThrow(/sealed account number/u);
  });

  it('例外: 別の鍵の封緘値の開封は SecretCipherError をそのまま伝える', async () => {
    const other = await sealAccountNumber(AesGcmSecretCipher.ephemeral(), '1234567');
    await expect(openAccountNumber(fixtureAccountCipher, other)).rejects.toThrow(SecretCipherError);
    await expect(openAccountNumber(AesGcmSecretCipher.ephemeral(), other)).rejects.toThrow();
  });
});

describe('bankAccountFromInput', () => {
  it('正常: 新しい口座は口座番号を封緘し、変更の日時と操作者を付ける', async () => {
    const account = await bankAccountFromInput(fixtureAccountCipher, input, undefined, 'keiri@example.com', V9_AT);
    expect(account).toEqual({ bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: fixtureSealAccountNumber('1234567'), holderKana: 'テスト タロウ', changedAt: V9_AT, changedBy: 'keiri@example.com' });
  });

  it.each([
    ['省略', undefined],
    ['空文字', ''],
  ])('境界: 口座番号が%sなら既存の封緘値をそのまま使い、暗号を回さない', async (_label, accountNumber) => {
    const existing = bankAccountFixture('0000001', 'テスト タロウ');
    const cipher = spyingCipher();
    const { accountNumber: _omitted, ...rest } = input;
    const account = await bankAccountFromInput(cipher, { ...rest, ...(accountNumber === undefined ? {} : { accountNumber }), holderKana: 'テスト タロウ', branchCode: '998' }, existing, 'keiri@example.com', '2026-09-16T00:00:00.000Z');
    expect(account.accountNumber).toEqual(existing.accountNumber);
    expect(account).toMatchObject({ branchCode: '998', changedAt: '2026-09-16T00:00:00.000Z' });
    expect(cipher.seal).not.toHaveBeenCalled();
  });

  it('正常: 既存の口座があっても口座番号を送れば封緘し直す', async () => {
    const existing = bankAccountFixture('0000001', 'テスト タロウ');
    const account = await bankAccountFromInput(fixtureAccountCipher, { ...input, accountNumber: '7654321' }, existing, 'keiri@example.com', V9_AT);
    expect(account.accountNumber.hint).toBe('4321');
    expect(await openAccountNumber(fixtureAccountCipher, account.accountNumber)).toBe('7654321');
  });

  it('異常: 既存の口座が無いのに口座番号が無ければ 400（accountNumber の欄）', async () => {
    const { accountNumber: _omitted, ...rest } = input;
    await expect(bankAccountFromInput(fixtureAccountCipher, rest, undefined, 'keiri@example.com', V9_AT)).rejects.toMatchObject({ details: { field: 'accountNumber' } });
    await expect(bankAccountFromInput(fixtureAccountCipher, { ...rest, accountNumber: '' }, undefined, 'keiri@example.com', V9_AT)).rejects.toBeInstanceOf(ExpenseDomainError);
  });

  it('異常: 口座の他の欄の不正（銀行コードの桁・名義カナ）は domain の検証で 400', async () => {
    await expect(bankAccountFromInput(fixtureAccountCipher, { ...input, bankCode: '999' }, undefined, 'k', V9_AT)).rejects.toMatchObject({ details: { field: 'bankCode' } });
    await expect(bankAccountFromInput(fixtureAccountCipher, { ...input, holderKana: '' }, undefined, 'k', V9_AT)).rejects.toMatchObject({ details: { field: 'holderKana' } });
  });
});
