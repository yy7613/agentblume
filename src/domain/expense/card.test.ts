import { describe, expect, it } from 'vitest';
import {
  cardDedupeKey, createExpenseCardImport, createExpenseCardSettings, createExpenseCardTransaction, emptyExpenseCardSettings,
  type ExpenseCardImport, type ExpenseCardTransaction,
} from './card';

const AT = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const mapping = { columns: { usedOn: '利用日', merchant: '利用先', amount: '金額' }, amountSign: 'charge-positive' as const, skipLinesBefore: 0 };

const importRecord = (overrides: Partial<ExpenseCardImport> = {}): ExpenseCardImport => createExpenseCardImport({
  tenant, id: 'imp-1', fileName: 'card.csv', fileSha256: 'a'.repeat(64), mapping, rowCount: 3, importedCount: 1, duplicateCount: 1, skippedRows: [{ row: 3, reason: '金額が空' }],
  periodFrom: '2026-09-01', periodTo: '2026-09-30', by: 'keiri', createdAt: AT, ...overrides,
});

const transaction = (overrides: Partial<ExpenseCardTransaction> = {}): ExpenseCardTransaction => createExpenseCardTransaction({
  tenant, id: 'tx-1', importId: 'imp-1', cardId: 'card-1', usedOn: '2026-09-10', merchantRaw: 'サンプルマート', merchantKey: 'サンプルマート', amount: 1200,
  row: { 金額: '1200' }, dedupeKey: cardDedupeKey('card-1', '2026-09-10', 1200, 'サンプルマート', 0), status: 'unmatched', createdAt: AT, updatedAt: AT, ...overrides,
});

describe('createExpenseCardSettings', () => {
  it('正常: カードとプロファイル（列マッピング）を持ち、空の任意項目は書かない', () => {
    const settings = createExpenseCardSettings({
      cards: [{ id: 'card-1', label: '法人カード', issuerName: '', last4: '1234', enabled: true }],
      profiles: [{ id: 'generic', name: '汎用', headerSignature: ['利用日', '利用先', '金額'], columns: { ...mapping.columns, memo: '' }, amountSign: 'charge-negative', skipLinesBefore: 2 }],
      updatedAt: AT,
    });
    expect(settings.cards[0]).toEqual({ id: 'card-1', label: '法人カード', last4: '1234', enabled: true });
    expect(settings.profiles[0]).toMatchObject({ amountSign: 'charge-negative', skipLinesBefore: 2, columns: mapping.columns });
    expect(emptyExpenseCardSettings()).toMatchObject({ cards: [], profiles: [] });
  });

  it('異常: 下 4 桁・id の一意・プロファイルの見出しと列・符号・読み飛ばし行数', () => {
    const card = { id: 'card-1', label: 'x', last4: '1234', enabled: true };
    expect(() => createExpenseCardSettings({ cards: [{ ...card, last4: '12345' }], updatedAt: AT })).toThrow(/last4/u);
    expect(() => createExpenseCardSettings({ cards: [card, card], updatedAt: AT })).toThrow(/card ids must be unique/u);
    expect(() => createExpenseCardSettings({ cards: [{ ...card, id: 'Card' }], updatedAt: AT })).toThrow(/id must match/u);
    expect(() => createExpenseCardSettings({ cards: [{ ...card, enabled: 'y' }] as never, updatedAt: AT })).toThrow(/enabled/u);
    const profile = { id: 'p', name: 'p', headerSignature: ['a'], columns: mapping.columns, amountSign: 'charge-positive', skipLinesBefore: 0 };
    expect(() => createExpenseCardSettings({ profiles: [{ ...profile, headerSignature: [] }] as never, updatedAt: AT })).toThrow(/headerSignature/u);
    expect(() => createExpenseCardSettings({ profiles: [{ ...profile, columns: { usedOn: 'a', merchant: 'b' } }] as never, updatedAt: AT })).toThrow(/columns.amount/u);
    expect(() => createExpenseCardSettings({ profiles: [{ ...profile, amountSign: 'plus' }] as never, updatedAt: AT })).toThrow(/amountSign/u);
    expect(() => createExpenseCardSettings({ profiles: [{ ...profile, skipLinesBefore: 21 }] as never, updatedAt: AT })).toThrow(/skipLinesBefore/u);
    expect(() => createExpenseCardSettings({ profiles: [profile, profile] as never, updatedAt: AT })).toThrow(/profile ids must be unique/u);
    expect(() => createExpenseCardSettings({ profiles: [{ ...profile, id: 'P' }] as never, updatedAt: AT })).toThrow(/id must match/u);
    expect(() => createExpenseCardSettings(null as never)).toThrow(/props are required/u);
  });
});

describe('createExpenseCardImport', () => {
  it('正常: 取込の写し（列マッピング・件数・期間）を保つ', () => {
    expect(importRecord({ profileId: 'generic', cardId: 'card-1' })).toMatchObject({ profileId: 'generic', cardId: 'card-1', mapping, skippedRows: [{ row: 3, reason: '金額が空' }] });
  });

  it('異常: SHA-256 の形・期間の前後・件数の整合', () => {
    expect(() => importRecord({ fileSha256: 'A'.repeat(64) })).toThrow(/fileSha256/u);
    expect(() => importRecord({ periodFrom: '2026-10-01' })).toThrow(/periodFrom must not be after/u);
    expect(() => importRecord({ importedCount: 3 })).toThrow(/must not exceed rowCount/u);
    expect(() => importRecord({ rowCount: -1 })).toThrow(/non-negative/u);
    expect(() => importRecord({ skippedRows: 'x' as never })).toThrow(/skippedRows must be an array/u);
    expect(() => importRecord({ fileName: '' })).toThrow(/fileName/u);
    expect(() => createExpenseCardImport(null as never)).toThrow(/props are required/u);
  });
});

describe('createExpenseCardTransaction', () => {
  it('正常: 未照合・照合済み・対象外の記録を状態と対応させて持つ', () => {
    expect(transaction().status).toBe('unmatched');
    const matched = transaction({ status: 'matched', match: { claimId: 'c1', itemId: 'i1', kind: 'reimbursement-item', strength: 'weak', dateDiffDays: 1, amountDiff: 0, manual: false, at: AT } });
    expect(matched.match).toMatchObject({ kind: 'reimbursement-item', strength: 'weak' });
    expect(transaction({ status: 'excluded', exclusion: { reason: '私的利用の返金済み', by: 'keiri', at: AT }, postedOn: '2026-09-12', memo: '' }).exclusion?.reason).toBe('私的利用の返金済み');
    expect(transaction({ amount: -500 }).amount).toBe(-500);
    expect(cardDedupeKey('c', '2026-09-10', 1200, '', 1)).toBe('c|2026-09-10|1200||1');
  });

  it('異常: 状態と記録の食い違い・金額 0・照合の形', () => {
    expect(() => transaction({ status: 'matched' })).toThrow(/matched transaction must have a match/u);
    expect(() => transaction({ match: { claimId: 'c1', itemId: 'i1', kind: 'corporate-item', strength: 'strong', dateDiffDays: 0, amountDiff: 0, manual: true, at: AT } })).toThrow(/only a matched one/u);
    expect(() => transaction({ status: 'excluded' })).toThrow(/excluded transaction must have an exclusion/u);
    expect(() => transaction({ amount: 0 })).toThrow(/non-zero/u);
    expect(() => transaction({ status: 'matched', match: { claimId: 'c1', itemId: 'i1', kind: 'other', strength: 'strong', dateDiffDays: 0, amountDiff: 0, manual: true, at: AT } as never })).toThrow(/match.kind/u);
    expect(() => transaction({ status: 'matched', match: { claimId: 'c1', itemId: 'i1', kind: 'corporate-item', strength: 'maybe', dateDiffDays: 0, amountDiff: 0, manual: true, at: AT } as never })).toThrow(/match.strength/u);
    expect(() => transaction({ status: 'matched', match: { claimId: 'c1', itemId: 'i1', kind: 'corporate-item', strength: 'strong', dateDiffDays: 0.5, amountDiff: 0, manual: true, at: AT } })).toThrow(/integers/u);
    expect(() => transaction({ status: 'matched', match: { claimId: 'c1', itemId: 'i1', kind: 'corporate-item', strength: 'strong', dateDiffDays: 0, amountDiff: 0, manual: 'no', at: AT } as never })).toThrow(/manual/u);
    expect(() => transaction({ row: { 金額: 1 } as never })).toThrow(/object of strings/u);
    expect(() => transaction({ status: 'unknown' as never })).toThrow(/status must be one of/u);
    expect(() => transaction({ merchantRaw: 'x'.repeat(201) })).toThrow(/merchantRaw/u);
    expect(() => transaction({ merchantKey: 1 as never })).toThrow(/merchantKey/u);
    expect(() => transaction({ usedOn: '2026/09/10' })).toThrow(/YYYY-MM-DD/u);
    expect(() => createExpenseCardTransaction(null as never)).toThrow(/props are required/u);
  });
});
