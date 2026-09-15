import { describe, expect, it } from 'vitest';
import { ReceivablesDomainError, ReceivablesStateError } from './errors';
import {
  addDays, applyInvoicePayment, createInvoice, daysOverdue, duplicateInvoiceContent, invoiceOutstanding, isOverdue, issueInvoice,
  resolveLineAmount, revertInvoicePayment, updateInvoiceDraft, voidInvoice, withInvoiceJournal, type CreateInvoiceProps,
} from './invoice';
import { defaultReceivablesSettings } from './settings';

const AT = '2026-09-30T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const snapshot = { issuer: defaultReceivablesSettings().issuer, customer: { name: '山田商事', honorific: '御中' }, roundingMode: 'floor' as const, issuedAt: AT };
const draft = (overrides: Partial<CreateInvoiceProps> = {}) => createInvoice({
  tenant, id: 'inv', customerId: 'c1', issueDate: '2026-09-30', transactionDate: '2026-09-30', dueDate: '2026-10-31', pricing: 'exclusive',
  lines: [{ description: '開発', amount: 100_000, taxRate: 10 }], roundingMode: 'floor', createdAt: AT, updatedAt: AT, ...overrides,
});
const issued = () => issueInvoice(draft({ declared: { grandTotal: 1 } }), { number: 'INV-2026-0001', snapshot, at: AT });

describe('createInvoice', () => {
  it('正常: totals は渡された値を使わず明細から再計算する。下書きは記載事項が欠けていても保存できる', () => {
    const invoice = draft({ totals: { grandTotal: 1 } });
    expect(invoice.totals).toEqual({ byRate: [{ rate: 10, taxable: 100_000, tax: 10_000, inclusive: 110_000 }], taxTotal: 10_000, grandTotal: 110_000 });
    const partial = createInvoice({ tenant, id: 'x', pricing: 'inclusive', lines: [{ description: '' }], roundingMode: 'ceil', createdAt: AT, updatedAt: AT });
    expect(partial).toMatchObject({ status: 'draft', paidAmount: 0, journal: {}, totals: { grandTotal: 0 } });
    expect(partial).not.toHaveProperty('customerId');
  });

  it('異常: 形の誤り（日付・税抜 / 税込・税率・金額・期間）は ReceivablesDomainError', () => {
    expect(() => draft({ issueDate: '2026-02-30' })).toThrow(ReceivablesDomainError);
    expect(() => draft({ pricing: 'gross' as never })).toThrow(/pricing/);
    expect(() => draft({ lines: [{ description: 'x', amount: 1.5, taxRate: 10 }] })).toThrow(/amount must be an integer/);
    expect(() => draft({ lines: [{ description: 'x', amount: 1, taxRate: 5 as never }] })).toThrow(/taxRate/);
    expect(() => draft({ lines: [{ description: 'x', amount: 1, taxRate: 0, zeroRateKind: 'free' as never }] })).toThrow(/zeroRateKind/);
    expect(() => draft({ transactionPeriod: { from: '2026-09-30', to: '2026-09-01' } })).toThrow(/from must not be after/);
    expect(() => draft({ roundingMode: 'bankers' as never })).toThrow(/roundingMode/);
    expect(() => draft({ declared: { taxByRate: [{ rate: 3 as never, taxAmount: 1 }] } })).toThrow(/declared.taxByRate/);
  });

  it('異常: 状態と番号・写し・入金額の食い違いは拒否する', () => {
    expect(() => draft({ number: 'INV-1' })).toThrow(/draft invoice must not have a number/);
    expect(() => draft({ paidAmount: 1 })).toThrow(/between 0 and grandTotal|cannot have payments/);
    expect(() => draft({ status: 'issued' })).toThrow(/must have a number/);
    expect(() => draft({ status: 'issued', number: 'INV-1' })).toThrow(/must have a snapshot/);
    expect(() => draft({ status: 'issued', number: 'INV-1', snapshot, customerId: undefined })).toThrow(/issue date and a customer/);
    expect(() => draft({ status: 'paid', number: 'INV-1', snapshot, paidAmount: 10 })).toThrow(/does not match paidAmount/);
    expect(() => draft({ status: 'issued', number: 'INV-1', snapshot: { ...snapshot, roundingMode: 'ceil' } })).toThrow(/snapshot.roundingMode/);
    expect(() => draft({ status: 'void', number: 'INV-1', snapshot })).toThrow(/voided.reason/);
  });
});

describe('状態遷移', () => {
  it('正常: 発行で番号と写しを付け、申告値を消し、丸めモードを凍結する', () => {
    const invoice = issued();
    expect(invoice).toMatchObject({ status: 'issued', number: 'INV-2026-0001', roundingMode: 'floor' });
    expect(invoice).not.toHaveProperty('declared');
    expect(() => issueInvoice(invoice, { number: 'X', snapshot, at: AT })).toThrow(ReceivablesStateError);
  });

  it('正常: 下書きの更新は丸めモードを設定の現在値で再計算する。発行済みは invoice-not-draft', () => {
    const updated = updateInvoiceDraft(draft(), { pricing: 'exclusive', lines: [{ description: 'A', amount: 105, taxRate: 10 }] }, 'ceil', '2026-10-01T00:00:00.000Z');
    expect(updated).toMatchObject({ roundingMode: 'ceil', totals: { taxTotal: 11 }, updatedAt: '2026-10-01T00:00:00.000Z' });
    expect(updated).not.toHaveProperty('customerId');
    try { updateInvoiceDraft(issued(), { pricing: 'exclusive', lines: [] }, 'floor', AT); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ reason: 'invoice-not-draft' }); }
  });

  it('正常: 入金の配分で issued → partially_paid → paid、取消で戻る', () => {
    let invoice = applyInvoicePayment(issued(), 10_000, AT);
    expect(invoice).toMatchObject({ status: 'partially_paid', paidAmount: 10_000 });
    expect(invoiceOutstanding(invoice)).toBe(100_000);
    invoice = applyInvoicePayment(invoice, 100_000, AT);
    expect(invoice).toMatchObject({ status: 'paid' });
    expect(invoiceOutstanding(invoice)).toBe(0);
    invoice = revertInvoicePayment(invoice, 110_000, AT);
    expect(invoice).toMatchObject({ status: 'issued', paidAmount: 0 });
  });

  it('異常: 残高を超える配分・発行前の入金・戻しすぎは拒否する', () => {
    try { applyInvoicePayment(issued(), 110_001, AT); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ reason: 'allocation-exceeds-outstanding', params: { outstanding: 110_000, amount: 110_001 } }); }
    expect(() => applyInvoicePayment(draft(), 1, AT)).toThrow(ReceivablesStateError);
    expect(() => applyInvoicePayment(issued(), 0, AT)).toThrow(ReceivablesDomainError);
    expect(() => revertInvoicePayment(issued(), 1, AT)).toThrow(/not exceeding paidAmount/);
    expect(() => revertInvoicePayment(draft(), 1, AT)).toThrow(/draft invoice/);
  });

  it('正常 / 異常: 取消は入金が無い発行済みだけ（理由必須）。入金ありは invoice-has-payments', () => {
    const voided = voidInvoice(issued(), '宛名の誤り', AT);
    expect(voided).toMatchObject({ status: 'void', voided: { at: AT, reason: '宛名の誤り' } });
    expect(invoiceOutstanding(voided)).toBe(0);
    expect(() => voidInvoice(voided, 'again', AT)).toThrow(ReceivablesStateError);
    expect(() => voidInvoice(issued(), ' ', AT)).toThrow(ReceivablesDomainError);
    try { voidInvoice(applyInvoicePayment(issued(), 1, AT), 'x', AT); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ reason: 'invoice-has-payments' }); }
  });

  it('正常: 仕訳連携の結果を記録する', () => {
    expect(withInvoiceJournal(issued(), { salesEntryId: 'e1', salesEntryKept: true }, AT).journal).toEqual({ salesEntryId: 'e1', salesEntryKept: true });
  });
});

describe('計算値と複製', () => {
  it('境界: 期日超過日数は期日の翌日から 1。未到来・期日なし・入金済みは 0', () => {
    const invoice = issued();
    expect(daysOverdue(invoice, '2026-10-31')).toBe(0);
    expect(daysOverdue(invoice, '2026-11-01')).toBe(1);
    expect(isOverdue(invoice, '2026-11-30')).toBe(true);
    expect(daysOverdue({ ...invoice, dueDate: undefined }, '2027-01-01')).toBe(0);
    expect(daysOverdue(applyInvoicePayment(invoice, 110_000, AT), '2027-01-01')).toBe(0);
    expect(daysOverdue(draft(), '2027-01-01')).toBe(0);
  });

  it('正常: 複製は明細と日付（発行日以外）を引き継ぎ、番号と申告値は引き継がない', () => {
    const content = duplicateInvoiceContent(issueInvoice(draft({ transactionPeriod: { from: '2026-09-01', to: '2026-09-30' }, note: 'メモ' }), { number: 'N', snapshot, at: AT }));
    expect(content).toEqual({ customerId: 'c1', transactionDate: '2026-09-30', transactionPeriod: { from: '2026-09-01', to: '2026-09-30' }, dueDate: '2026-10-31', pricing: 'exclusive', lines: [{ description: '開発', amount: 100_000, taxRate: 10 }], note: 'メモ' });
  });

  it('正常: 金額は直接の値か割り切れる単価 × 数量。addDays は月末をまたぐ', () => {
    expect(resolveLineAmount({ description: 'x', quantity: 2, unitPrice: 50 })).toBe(100);
    expect(resolveLineAmount({ description: 'x', quantity: 2 })).toBeUndefined();
    expect(addDays('2026-09-30', 31)).toBe('2026-10-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
