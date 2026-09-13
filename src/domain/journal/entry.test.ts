import { describe, expect, it } from 'vitest';
import { confirmEntry, createJournalEntry, entryTotals, markEntryExported, validateJournalEntryDraft, type CreateJournalEntryProps, type JournalEntryLine } from './entry';
import { JournalDomainError } from './errors';

const tenant = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-13T00:00:00.000Z';
const debit: JournalEntryLine = { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100 };
const credit: JournalEntryLine = { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 };

export function entryProps(overrides: Partial<CreateJournalEntryProps> = {}): CreateJournalEntryProps {
  return { tenant, id: 'entry-1', documentId: 'doc-1', ruleId: 'rule-1', date: '2026-09-13', lines: [debit, credit], description: '消耗品', invoiceStatus: 'qualified', registrationNumber: 'T1234567890123', decidedBy: 'rule', createdAt: at, updatedAt: at, ...overrides };
}

describe('createJournalEntry', () => {
  it('正常: 検証して複製する（既定 status draft、trim、空の tags を落とす）', () => {
    const entry = createJournalEntry(entryProps({ description: ' 消耗品 ', item: ' ペン ', tags: ['a', ' ', 'b'] }));
    expect(entry).toEqual({ tenant, id: 'entry-1', documentId: 'doc-1', ruleId: 'rule-1', date: '2026-09-13', lines: [debit, credit], description: '消耗品', invoiceStatus: 'qualified', registrationNumber: 'T1234567890123', item: 'ペン', tags: ['a', 'b'], status: 'draft', decidedBy: 'rule', createdAt: at, updatedAt: at });
  });

  it('正常: id 省略は makeId。複合仕訳（複数行）も貸借が合えばよい', () => {
    const entry = createJournalEntry(entryProps({ id: undefined, lines: [{ ...debit, amount: 700 }, { ...debit, accountId: 'expense.misc', accountName: '雑費', amount: 400, taxAmount: 36 }, credit], confidence: 0.8 }), () => 'gen');
    expect(entry.id).toBe('gen');
    expect(entryTotals(entry.lines)).toEqual({ debit: 1100, credit: 1100 });
    expect(entry.confidence).toBe(0.8);
  });

  it('異常: 貸借不一致・片側だけ・行なし', () => {
    expect(() => createJournalEntry(entryProps({ lines: [debit, { ...credit, amount: 1000 }] }))).toThrow(new JournalDomainError('createJournalEntry: debit total (1100) must equal credit total (1000)'));
    expect(() => createJournalEntry(entryProps({ lines: [debit] }))).toThrow(/must include at least one debit and one credit/u);
    expect(() => createJournalEntry(entryProps({ lines: [] }))).toThrow(/must include at least one debit and one credit/u);
  });

  it('異常: 行の不変条件（金額 0 / 負 / 非整数、税額 > 金額、科目名なし、税区分なし）', () => {
    expect(() => createJournalEntry(entryProps({ lines: [{ ...debit, amount: 0 }, { ...credit, amount: 0 }] }))).toThrow(/lines\[0\]\.amount must be a positive integer/u);
    expect(() => createJournalEntry(entryProps({ lines: [{ ...debit, amount: -1 }, credit] }))).toThrow(/amount must be a positive integer/u);
    expect(() => createJournalEntry(entryProps({ lines: [{ ...debit, amount: 1.5 }, credit] }))).toThrow(/amount must be a positive integer/u);
    expect(() => createJournalEntry(entryProps({ lines: [{ ...debit, taxAmount: 2000 }, credit] }))).toThrow(/taxAmount must be an integer between 0 and amount/u);
    expect(() => createJournalEntry(entryProps({ lines: [{ ...debit, accountName: '' }, credit] }))).toThrow(/accountName must be a non-empty string/u);
    expect(() => createJournalEntry(entryProps({ lines: [{ ...debit, taxCode: '' }, credit] }))).toThrow(/taxCode must be a non-empty string/u);
  });

  it('異常: 日付形式・status / decidedBy / invoiceStatus の列挙・登録番号・confidence', () => {
    expect(() => createJournalEntry(entryProps({ date: '2026/09/13' }))).toThrow(/date must be a date in YYYY-MM-DD/u);
    expect(() => createJournalEntry(entryProps({ status: 'posted' as 'draft' }))).toThrow(/status must be one of/u);
    expect(() => createJournalEntry(entryProps({ decidedBy: 'llm' as 'rule' }))).toThrow(/decidedBy must be one of/u);
    expect(() => createJournalEntry(entryProps({ invoiceStatus: 'yes' as 'none' }))).toThrow(/invoiceStatus must be one of/u);
    expect(() => createJournalEntry(entryProps({ registrationNumber: 'T1' }))).toThrow(/registrationNumber must be T followed by 13 digits/u);
    expect(() => createJournalEntry(entryProps({ confidence: 2 }))).toThrow(/confidence must be between 0 and 1/u);
  });

  it('例外: tenant / id / 時刻', () => {
    expect(() => createJournalEntry(entryProps({ tenant: { tenantId: '', workspaceId: 'w' } }))).toThrow(/tenant\.tenantId must be a non-empty string/u);
    expect(() => createJournalEntry(entryProps({ id: undefined }))).toThrow(/id must be a non-empty string/u);
    expect(() => createJournalEntry(entryProps({ createdAt: 'x' }))).toThrow(/createdAt must be an ISO 8601 date-time string/u);
  });
});

describe('validateJournalEntryDraft', () => {
  it('正常: 草案だけを検証できる（ラベルを差し替えられる）', () => {
    expect(validateJournalEntryDraft({ date: '2026-09-13', lines: [debit, credit], description: 'x', invoiceStatus: 'none' })).toEqual({ date: '2026-09-13', lines: [debit, credit], description: 'x', invoiceStatus: 'none' });
    expect(() => validateJournalEntryDraft({ date: 'x', lines: [], description: '', invoiceStatus: 'none' }, 'proposal.entry')).toThrow(/^proposal\.entry: date must be/u);
  });
});

describe('transitions', () => {
  const later = '2026-09-13T01:00:00.000Z';
  const entry = createJournalEntry(entryProps());

  it('正常: draft → confirmed → exported。confirmed / exported は冪等', () => {
    const confirmed = confirmEntry(entry, later);
    expect(confirmed).toMatchObject({ status: 'confirmed', updatedAt: later });
    expect(confirmEntry(confirmed, later)).toBe(confirmed);
    const exported = markEntryExported(confirmed, later);
    expect(exported.status).toBe('exported');
    expect(markEntryExported(exported, later)).toBe(exported);
    expect(markEntryExported(entry, later).status).toBe('exported');
  });

  it('異常: exported の再確定・不正な時刻', () => {
    expect(() => confirmEntry(markEntryExported(entry, later), later)).toThrow(/exported entry cannot be confirmed again/u);
    expect(() => confirmEntry(entry, 'x')).toThrow(/confirmEntry: at must be an ISO 8601 date-time string/u);
  });
});
