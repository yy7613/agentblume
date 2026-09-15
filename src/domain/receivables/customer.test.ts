import { describe, expect, it } from 'vitest';
import { aliasConflicts, createCustomer, customerMatchKeys, learnPayerAlias, removePayerAlias, type CreateCustomerProps } from './customer';
import { ReceivablesDomainError } from './errors';

const AT = '2026-09-14T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
let counter = 0;
const makeId = () => `id-${(counter += 1)}`;
const make = (overrides: Partial<CreateCustomerProps> = {}) => createCustomer({ tenant, id: 'c1', name: '山田商事株式会社', createdAt: AT, updatedAt: AT, ...overrides }, makeId);

describe('createCustomer', () => {
  it('正常: 既定は敬称「御中」・有効。別名の正規化名はクライアントの値を信じず再計算する', () => {
    const customer = make({ kana: ' ヤマダシヨウジ ', payerAliases: [{ text: 'ｶ)ﾔﾏﾀﾞｼﾖｳｼﾞ', normalized: 'でたらめ', origin: 'manual' }] });
    expect(customer).toMatchObject({ honorific: '御中', enabled: true, kana: 'ヤマダシヨウジ' });
    expect(customer.payerAliases[0]).toMatchObject({ text: 'ｶ)ﾔﾏﾀﾞｼﾖｳｼﾞ', normalized: 'ヤマダシヨウジ', origin: 'manual', createdAt: AT });
    expect(customer.payerAliases[0]!.id).toMatch(/^id-/);
  });

  it('正常: 相手の登録番号は正規化して持つ。空文字の任意項目は持たない', () => {
    expect(make({ registrationNumber: 't-1234567890123', address: ' ', note: '' })).not.toHaveProperty('address');
    expect(make({ registrationNumber: 'T 1234567890123' }).registrationNumber).toBe('T1234567890123');
  });

  it('異常: 名前が空・登録番号の形・支払条件の範囲・敬称・別名の重複は拒否する', () => {
    expect(() => make({ name: ' ' })).toThrow(ReceivablesDomainError);
    expect(() => make({ registrationNumber: 'T123' })).toThrow(/T followed by 13 digits/);
    expect(() => make({ paymentTermDays: 366 })).toThrow(/between 0 and 365/);
    expect(make({ paymentTermDays: 0 }).paymentTermDays).toBe(0);
    expect(() => make({ honorific: '殿' as never })).toThrow(/honorific/);
    expect(() => make({ payerAliases: [{ text: 'ﾔﾏﾀﾞ', origin: 'manual' }, { text: 'やまだ', origin: 'learned' }] })).toThrow(/duplicates another alias/);
    expect(() => make({ payerAliases: [{ text: '(株)', origin: 'manual' }] })).toThrow(/no characters left/);
    expect(() => make({ payerAliases: [{ text: 'x', origin: 'robot' as never }] })).toThrow(/origin/);
    expect(() => make({ createdAt: 'yesterday' })).toThrow(/createdAt/);
  });

  it('境界: 別名は 50 件まで', () => {
    const aliases = Array.from({ length: 50 }, (_, index) => ({ text: `ALIAS${index}`, origin: 'manual' as const }));
    expect(make({ payerAliases: aliases }).payerAliases).toHaveLength(50);
    expect(() => make({ payerAliases: [...aliases, { text: 'ALIAS50', origin: 'manual' }] })).toThrow(/at most 50/);
  });
});

describe('別名の学習と削除', () => {
  it('正常: 確定時に名義を覚える（出所 learned、学習した消込を記録）', () => {
    const learned = learnPayerAlias(make(), { text: 'ﾔﾏﾀﾞ ﾀﾛｳ', aliasId: 'a1', matchingId: 'm1', at: AT });
    expect(learned).toMatchObject({ aliasId: 'a1', created: true });
    expect(learned.customer.payerAliases).toEqual([{ id: 'a1', text: 'ﾔﾏﾀﾞ ﾀﾛｳ', normalized: 'ヤマダタロウ', origin: 'learned', matchingId: 'm1', createdAt: AT, lastMatchedAt: AT }]);
  });

  it('境界: 同じ正規化名が既にあれば二重にせず最終一致日だけ更新する。空の名義は覚えない', () => {
    const customer = make({ payerAliases: [{ id: 'a0', text: 'ヤマダタロウ', origin: 'manual' }] });
    const again = learnPayerAlias(customer, { text: 'ﾔﾏﾀﾞﾀﾛｳ', aliasId: 'new', matchingId: 'm2', at: '2026-10-01T00:00:00.000Z' });
    expect(again).toMatchObject({ aliasId: 'a0', created: false });
    expect(again.customer.payerAliases).toHaveLength(1);
    expect(again.customer.payerAliases[0]!.lastMatchedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(() => learnPayerAlias(customer, { text: '  ', aliasId: 'x', matchingId: 'm', at: AT })).toThrow(/empty/);
  });

  it('正常: 別名を消す（無い id はそのまま返す）', () => {
    const customer = make({ payerAliases: [{ id: 'a0', text: 'ヤマダ', origin: 'manual' }] });
    expect(removePayerAlias(customer, 'a0', AT).payerAliases).toEqual([]);
    expect(removePayerAlias(customer, 'missing', AT)).toBe(customer);
  });

  it('正常: 照合キーはカナと別名。別の取引先と重なる正規化名を衝突として返す', () => {
    const a = make({ id: 'a', kana: 'サンプル', payerAliases: [{ text: 'テスト', origin: 'manual' }] });
    const b = make({ id: 'b', name: '別会社', payerAliases: [{ text: 'ﾃｽﾄ', origin: 'learned' }] });
    expect(customerMatchKeys(a)).toEqual(['サンプル', 'テスト']);
    expect(aliasConflicts(a, [a, b])).toEqual([{ normalized: 'テスト', otherCustomerId: 'b', otherCustomerName: '別会社' }]);
    expect(aliasConflicts(a, [make({ id: 'c', name: '無関係' })])).toEqual([]);
  });
});
