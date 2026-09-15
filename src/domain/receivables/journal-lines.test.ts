import { describe, expect, it } from 'vitest';
import { createInvoice } from './invoice';
import { receiptJournalEntry, salesEntryDateOf, salesJournalEntry, taxIncludedFloor } from './journal-lines';
import { defaultReceivablesSettings } from './settings';

const AT = '2026-09-30T00:00:00.000Z';
const settings = defaultReceivablesSettings();
const snapshot = { issuer: settings.issuer, customer: { name: '山田商事', honorific: '御中' }, roundingMode: 'floor' as const, issuedAt: AT };

function issued(lines: Parameters<typeof createInvoice>[0]['lines'], overrides: Partial<Parameters<typeof createInvoice>[0]> = {}) {
  return createInvoice({
    tenant: { tenantId: 't', workspaceId: 'w' }, id: 'inv-1', number: 'INV-2026-0001', status: 'issued', customerId: 'c1',
    issueDate: '2026-09-30', transactionDate: '2026-09-25', pricing: 'exclusive', lines, roundingMode: 'floor', snapshot, createdAt: AT, updatedAt: AT, ...overrides,
  });
}
const sum = (lines: readonly { side: string; amount: number }[], side: string) => lines.filter((line) => line.side === side).reduce((total, line) => total + line.amount, 0);

describe('salesJournalEntry（発行 → 売上）', () => {
  it('正常: 売掛金 = 請求額、売上は税率ごと（税額つき）。対象額 0 の税率は行を作らない。貸借が一致する', () => {
    const invoice = issued([
      { description: '開発', amount: 100_000, taxRate: 10 },
      { description: '弁当', amount: 1_000, taxRate: 8 },
      { description: '立替', amount: 500, taxRate: 0, zeroRateKind: 'non-taxable' },
      { description: '値引', amount: 0, taxRate: 10 },
    ]);
    const entry = salesJournalEntry(invoice, settings, '山田商事');
    expect(entry).toEqual({
      date: '2026-09-25',
      description: 'INV-2026-0001 山田商事',
      lines: [
        { side: 'debit', accountId: 'asset.receivables', taxCode: 'JP-NA', amount: 111_580, partner: '山田商事' },
        { side: 'credit', accountId: 'revenue.sales', taxCode: 'JP-OUT-10-S', amount: 110_000, taxAmount: 10_000, partner: '山田商事' },
        { side: 'credit', accountId: 'revenue.sales', taxCode: 'JP-OUT-8R-S', amount: 1_080, taxAmount: 80, partner: '山田商事' },
        { side: 'credit', accountId: 'revenue.sales', taxCode: 'JP-OUT-EXEMPT', amount: 500, partner: '山田商事' },
      ],
      tags: ['receivables', 'receivables:invoice:inv-1'],
    });
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('境界: 値引で税率の合計が 0 になった税率の行は作らない', () => {
    const entry = salesJournalEntry(issued([{ description: '本体', amount: 1_000, taxRate: 8 }, { description: '値引', amount: -1_000, taxRate: 8 }, { description: '作業', amount: 1_000, taxRate: 10 }]), settings, 'x');
    expect(entry.lines.filter((line) => line.side === 'credit').map((line) => line.taxCode)).toEqual(['JP-OUT-10-S']);
  });

  it('正常: 日付は設定で取引日（期間なら末日）か発行日', () => {
    const period = issued([{ description: '保守', amount: 1_000, taxRate: 10 }], { transactionDate: undefined, transactionPeriod: { from: '2026-09-01', to: '2026-09-28' } });
    expect(salesEntryDateOf(period, settings)).toBe('2026-09-28');
    expect(salesEntryDateOf(period, { journal: { ...settings.journal, salesEntryDate: 'issue-date' } })).toBe('2026-09-30');
    expect(salesEntryDateOf({ transactionDate: '2026-09-01' }, { journal: { ...settings.journal, salesEntryDate: 'issue-date' } })).toBe('2026-09-01');
    expect(salesEntryDateOf({ issueDate: '2026-09-02' }, settings)).toBe('2026-09-02');
  });
});

describe('receiptJournalEntry（消込の確定 → 入金）', () => {
  const base = { transaction: { date: '2026-10-05', amount: 54_560 }, invoiceNumbers: new Map([['a', 'INV-0003'], ['b', 'INV-0004']]), customerName: 'テスト工業', settings };

  it('正常: 手数料差額は支払手数料（税込からの切り捨て）。合算は請求ごとに売掛金 1 行', () => {
    const entry = receiptJournalEntry({ ...base, matching: { id: 'm1', allocations: [{ invoiceId: 'a', amount: 33_000 }, { invoiceId: 'b', amount: 22_000 }], feeAmount: 440 }, feeTaxRate: 10 });
    expect(entry).toEqual({
      date: '2026-10-05',
      description: '入金 テスト工業 INV-0003 INV-0004',
      lines: [
        { side: 'debit', accountId: 'asset.ordinary_deposit', taxCode: 'JP-NA', amount: 54_560 },
        { side: 'debit', accountId: 'expense.fees', taxCode: 'JP-IN-10-S', amount: 440, taxAmount: 40 },
        { side: 'credit', accountId: 'asset.receivables', taxCode: 'JP-NA', amount: 33_000, partner: 'テスト工業' },
        { side: 'credit', accountId: 'asset.receivables', taxCode: 'JP-NA', amount: 22_000, partner: 'テスト工業' },
      ],
      tags: ['receivables', 'receivables:matching:m1'],
    });
    expect(sum(entry.lines, 'debit')).toBe(sum(entry.lines, 'credit'));
  });

  it('境界: 手数料 0 なら手数料の行を作らない。税率が分からなければ税額を付けない。番号が無ければ id を摘要に使う', () => {
    const partial = receiptJournalEntry({ ...base, transaction: { date: '2026-10-05', amount: 30_000 }, matching: { id: 'm2', allocations: [{ invoiceId: 'zzz', amount: 30_000 }], feeAmount: 0 } });
    expect(partial.lines.map((line) => line.accountId)).toEqual(['asset.ordinary_deposit', 'asset.receivables']);
    expect(partial.description).toBe('入金 テスト工業 zzz');
    const noRate = receiptJournalEntry({ ...base, transaction: { date: '2026-10-05', amount: 9_560 }, matching: { id: 'm3', allocations: [{ invoiceId: 'a', amount: 10_000 }], feeAmount: 440 } });
    expect(noRate.lines[1]).toEqual({ side: 'debit', accountId: 'expense.fees', taxCode: 'JP-IN-10-S', amount: 440 });
  });

  it('正常: taxIncludedFloor は税込額に含まれる税（0% は 0）', () => {
    expect(taxIncludedFloor(440, 10)).toBe(40);
    expect(taxIncludedFloor(1_080, 8)).toBe(80);
    expect(taxIncludedFloor(100, 0)).toBe(0);
  });
});
