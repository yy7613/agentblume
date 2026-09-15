import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from './errors';
import { createExpenseReceipt, RECEIPT_PAYLOAD_MAX_BYTES, type ExpenseReceipt } from './receipt';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function props(overrides: Record<string, unknown> = {}): ExpenseReceipt {
  return {
    tenant: { tenantId: 't', workspaceId: 'w' },
    id: 'r1',
    claimId: 'c1',
    itemId: 'i1',
    source: { type: 'image', fileName: 'a.png', mime: 'image/png', dataUrl: DATA_URL },
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  } as ExpenseReceipt;
}

const sourceWith = (overrides: Record<string, unknown>): ExpenseReceipt => props({ source: { type: 'image', dataUrl: DATA_URL, ...overrides } });

describe('createExpenseReceipt', () => {
  it('正常: 証憑を複製して返す（未知のキーは落とす）', () => {
    const receipt = createExpenseReceipt(props({ extra: 1, tenant: { tenantId: 't', workspaceId: 'w', other: 1 } }));
    expect(receipt).toEqual(props());
  });

  it('正常: PDF はテキスト層を持てる', () => {
    const receipt = createExpenseReceipt(sourceWith({ type: 'pdf', text: '領収書' }));
    expect(receipt.source).toEqual({ type: 'pdf', dataUrl: DATA_URL, text: '領収書' });
  });

  it.each([
    ['props なし', null, /props are required/u],
    ['tenant なし', props({ tenant: null }), /tenant is required/u],
    ['tenantId 空', props({ tenant: { tenantId: '', workspaceId: 'w' } }), /tenantId/u],
    ['id 空', props({ id: '' }), /id/u],
    ['source なし', props({ source: null }), /source is required/u],
    ['source.type', sourceWith({ type: 'text' }), /source.type must be image or pdf/u],
    ['data URL の形', sourceWith({ dataUrl: 'data:application/pdf;base64,AAAA' }), /source.dataUrl must be/u],
    ['fileName の型', sourceWith({ fileName: 1 }), /source.fileName must be a string/u],
    ['sha256 大文字', props({ sha256: 'A'.repeat(64) }), /sha256 must be 64 lowercase hex/u],
    ['sha256 桁不足', props({ sha256: 'a'.repeat(63) }), /sha256/u],
    ['createdAt', props({ createdAt: '2026-09-14' }), ExpenseDomainError],
  ])('異常: %s は ExpenseDomainError', (_label, value, expected) => {
    expect(() => createExpenseReceipt(value as ExpenseReceipt)).toThrow(ExpenseDomainError);
    expect(() => createExpenseReceipt(value as ExpenseReceipt)).toThrow(expected);
  });

  it('境界: data URL とテキスト層の上限を超えると拒否する', () => {
    const oversizedUrl = `data:image/png;base64,${'A'.repeat(RECEIPT_PAYLOAD_MAX_BYTES)}`;
    expect(() => createExpenseReceipt(sourceWith({ dataUrl: oversizedUrl }))).toThrow(/at most/u);
    expect(() => createExpenseReceipt(sourceWith({ text: 'x'.repeat(RECEIPT_PAYLOAD_MAX_BYTES + 1) }))).toThrow(/source.text must be at most/u);
  });
});
