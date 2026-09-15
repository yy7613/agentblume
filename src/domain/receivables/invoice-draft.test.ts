import { describe, expect, it } from 'vitest';
import { createCustomer } from './customer';
import { draftInvoiceFromOrder, type OrderDocumentRead } from './invoice-draft';
import { deserializeBankCsvProfile, deserializeBankTransaction, deserializeCustomer, deserializeInvoice, deserializeMatching, deserializeReceivablesSettings, serializeCustomer, serializeInvoice, serializeReceivablesSettings, withBuiltinProfiles } from './serialization';
import { defaultReceivablesSettings, type ReceivablesSettings } from './settings';
import { createInvoice } from './invoice';
import { ReceivablesDomainError } from './errors';

const AT = '2026-09-14T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const settings: ReceivablesSettings = { ...defaultReceivablesSettings(), issuer: { name: '株式会社サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] } };
const testKogyo = createCustomer({ tenant, id: 'c-test', name: 'テスト工業株式会社', kana: 'テストコウギヨウ', paymentTermDays: 30, createdAt: AT, updatedAt: AT });

const order: OrderDocumentRead = {
  issuerName: 'テスト工業株式会社', recipientName: '株式会社サンプルソフト 御中', registrationNumber: 'T1234567890123',
  transactionDate: '2026-09-20', grandTotal: 47_080,
  totalsByRate: [{ rate: 10, taxableAmount: 40_000, taxAmount: 4_000, amountIncludesTax: false }, { rate: 8, taxableAmount: 3_000, taxAmount: 240, amountIncludesTax: false }],
  lines: [
    { description: '部品A', quantity: 10, unitPrice: 2_000, amount: 20_000, taxRate: 10 },
    { description: '部品B', quantity: 5, unitPrice: 4_000, amount: 20_000, taxRate: 10 },
    { description: '軽食', amount: 3_000, taxRate: 8 },
  ],
  warnings: ['合計欄が不鮮明'],
};

describe('draftInvoiceFromOrder', () => {
  it('正常: 相手の注文書は発行者を取引先にし、マスタと 1 件一致すれば customerId。発行日は空、期日は支払条件から', () => {
    const proposal = draftInvoiceFromOrder(order, settings, [testKogyo]);
    expect(proposal).toMatchObject({ customerName: 'テスト工業株式会社', customerId: 'c-test', documentTotal: 47_080, warnings: ['合計欄が不鮮明'] });
    expect(proposal.content).toEqual({
      customerId: 'c-test', transactionDate: '2026-09-20', dueDate: '2026-10-20', pricing: 'exclusive',
      lines: [
        { description: '部品A', quantity: 10, unitPrice: 2_000, amount: 20_000, taxRate: 10 },
        { description: '部品B', quantity: 5, unitPrice: 4_000, amount: 20_000, taxRate: 10 },
        { description: '軽食', amount: 3_000, taxRate: 8 },
      ],
      declared: { taxByRate: [{ rate: 10, taxAmount: 4_000 }, { rate: 8, taxAmount: 240 }], grandTotal: 47_080 },
    });
    expect(proposal.check.violations.map((issue) => issue.code)).toEqual(['issue-date-missing']);
    expect(proposal.check.totals.grandTotal).toBe(47_240);
    // 印字の合計と計算値の差は警告に出る（補正しない）。
    expect(proposal.check.warnings.map((issue) => issue.code)).toContain('declared-total-mismatch');
  });

  it('正常: 自社の見積書（登録番号か名前が自社）は宛名を取引先名にする。税込の印字なら inclusive', () => {
    const own = draftInvoiceFromOrder({ ...order, issuerName: 'ｻﾝﾌﾟﾙｿﾌﾄ', registrationNumber: 'T9876543210987', recipientName: 'テスト工業', totalsByRate: [{ rate: 10, taxableAmount: 44_000, amountIncludesTax: true }] }, settings, [testKogyo]);
    // 宛名「テスト工業」は正規化するとマスタの「テスト工業株式会社」と同じなので取引先まで決まる。
    expect(own).toMatchObject({ customerName: 'テスト工業', customerId: 'c-test' });
    expect(own.content.pricing).toBe('inclusive');
    const byName = draftInvoiceFromOrder({ ...order, registrationNumber: undefined, issuerName: '株式会社サンプルソフト', recipientName: 'テストコウギヨウ' }, settings, [testKogyo]);
    expect(byName.customerId).toBe('c-test');
  });

  it('境界: 取引先が見つからなければ customerId なし（宛名は読んだ名前で検査）。複数一致は警告', () => {
    const none = draftInvoiceFromOrder({ ...order, issuerName: '未登録商店' }, settings, [testKogyo]);
    expect(none.customerId).toBeUndefined();
    expect(none.check.violations.map((issue) => issue.code)).not.toContain('recipient-missing');
    const twin = createCustomer({ tenant, id: 'c-twin', name: '有限会社テスト工業', createdAt: AT, updatedAt: AT });
    const both = draftInvoiceFromOrder(order, settings, [testKogyo, twin]);
    expect(both.customerId).toBeUndefined();
    expect(both.warnings.at(-1)).toMatch(/several customers/);
  });

  it('境界: 税率が 1 つだけなら明細の税率を補う。合計も税率も読めなければ declared なし・既定の税抜 / 税込', () => {
    const single = draftInvoiceFromOrder({ lines: [{ description: '作業', amount: 1_000 }], totalsByRate: [{ rate: 10, taxableAmount: 1_000, amountIncludesTax: false }], warnings: [] }, settings, []);
    expect(single.content.lines[0]!.taxRate).toBe(10);
    expect(single.content).not.toHaveProperty('declared');
    expect(single).not.toHaveProperty('customerName');
    expect(single.check.violations.map((issue) => issue.code)).toEqual(expect.arrayContaining(['recipient-missing', 'issue-date-missing', 'transaction-date-missing']));
    const blank = draftInvoiceFromOrder({ lines: [{ quantity: 1 }], warnings: [] }, { ...settings, rounding: { mode: 'floor', defaultPricing: 'inclusive' } }, []);
    expect(blank.content).toMatchObject({ pricing: 'inclusive', lines: [{ description: '', quantity: 1 }] });
  });
});

describe('serialization', () => {
  it('正常: 設定・取引先・請求書が往復する（請求書の totals は読み戻しでも再計算）', () => {
    const settingsBack = deserializeReceivablesSettings(JSON.parse(JSON.stringify(serializeReceivablesSettings(settings))));
    expect(settingsBack).toEqual(settings);
    expect(deserializeCustomer(JSON.parse(JSON.stringify(serializeCustomer(testKogyo))))).toEqual(testKogyo);
    const invoice = createInvoice({ tenant, id: 'i', pricing: 'exclusive', lines: [{ description: 'x', amount: 1_000, taxRate: 10 }], roundingMode: 'floor', createdAt: AT, updatedAt: AT });
    const tampered = { ...JSON.parse(JSON.stringify(serializeInvoice(invoice))), totals: { grandTotal: 1 } };
    expect(deserializeInvoice(tampered).totals.grandTotal).toBe(1_100);
  });

  it('例外: 形の崩れた記録は ReceivablesDomainError（黙って null にしない）', () => {
    for (const deserialize of [deserializeReceivablesSettings, deserializeCustomer, deserializeInvoice, deserializeBankCsvProfile, deserializeBankTransaction, deserializeMatching]) {
      expect(() => deserialize({ id: 'broken' })).toThrow(ReceivablesDomainError);
    }
  });

  it('正常: 利用者のプロファイルを組込みより先に並べる', () => {
    expect(withBuiltinProfiles([]).every((profile) => profile.origin === 'builtin')).toBe(true);
  });
});
