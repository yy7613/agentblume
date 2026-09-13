import { describe, expect, it } from 'vitest';
import { createChartOfAccounts } from './chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from './default-chart';
import { createJournalEntry } from './entry';
import { entryProps } from './entry.test';
import { exportGenericCsv, GENERIC_CSV_COLUMNS, genericCsvRows, toSlashDate, UTF8_BOM } from './export';

const chart = createChartOfAccounts({ ...DEFAULT_CHART_OF_ACCOUNTS, dimensions: [{ id: 'sub_account', name: '補助科目', values: [{ id: 'sub1', name: '本店', enabled: true }] }, { id: 'department', name: '部門', values: [{ id: 'dep1', name: '営業部', enabled: true }] }] });

describe('exportGenericCsv', () => {
  it('正常: 25 列・BOM・CRLF・YYYY/MM/DD。単純仕訳は 1 行に両側を出す', () => {
    const entry = createJournalEntry(entryProps({ lines: [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', dimensionValues: { sub_account: 'sub1', department: 'dep1' }, taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100, partner: 'Amazon' },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ], item: 'ペン', tags: ['a', 'b'] }));
    const csv = exportGenericCsv([entry], chart);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe(GENERIC_CSV_COLUMNS.join(','));
    expect(GENERIC_CSV_COLUMNS).toHaveLength(25);
    expect(lines[0]?.split(',')).toHaveLength(25);
    expect(lines[1]).toBe('entry-1,1,2026/09/13,消耗品費,本店,営業部,Amazon,JP-IN-10-S,1100,100,現金,,,,JP-NA,1100,,消耗品,qualified,T1234567890123,ペン,a;b,0,doc-1,rule-1');
    expect(lines[1]?.split(',')).toHaveLength(25);
    expect(csv).not.toContain('\n\n');
  });

  it('正常: 複合仕訳は行ごとに片側だけ（弥生形式）、line_no は行番号、未知の補助軸値は id のまま', () => {
    const entry = createJournalEntry(entryProps({ id: 'e2', documentId: undefined, ruleId: undefined, registrationNumber: undefined, lines: [
      { side: 'debit', accountId: 'expense.meetings', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 700, taxAmount: 63, dimensionValues: { department: 'unknown' } },
      { side: 'debit', accountId: 'expense.welfare', accountName: '福利厚生費', taxCode: 'JP-IN-8R-S', amount: 400, taxAmount: 29 },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100, partner: 'x' },
    ], description: 'a,b' }));
    const rows = genericCsvRows(entry, chart);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ entry_id: 'e2', line_no: 1, debit_account: '会議費', debit_department: 'unknown', debit_amount: 700, debit_tax_amount: 63, credit_account: '', credit_amount: '', source_document_id: '', rule_id: '', registration_number: '' });
    expect(rows[2]).toMatchObject({ line_no: 3, debit_account: '', credit_account: '現金', credit_partner: 'x', credit_amount: 1100 });
    const csv = exportGenericCsv([entry], chart);
    expect(csv.split('\r\n')[1]).toContain('"a,b"');
    expect(csv.split('\r\n')).toHaveLength(5);
  });

  it('境界: 仕訳が無ければヘッダ行だけ。toSlashDate', () => {
    expect(exportGenericCsv([], chart)).toBe(`${UTF8_BOM}${GENERIC_CSV_COLUMNS.join(',')}\r\n`);
    expect(toSlashDate('2026-09-13')).toBe('2026/09/13');
  });
});

describe('exportGenericCsv（異常系・例外系）', () => {
  it('異常: 取引先にカンマ・引用符が含まれても列がずれない（引用符で囲んでエスケープする）', () => {
    const entry = createJournalEntry(entryProps({ lines: [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100, partner: 'A,B "C"' },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ] }));
    const csv = exportGenericCsv([entry], chart);
    expect(csv).toContain('"A,B ""C"""');
  });

  it('異常: 仕訳が 0 件ならヘッダー行だけを出す', () => {
    const csv = exportGenericCsv([], chart).replace(UTF8_BOM, '');
    expect(csv.split('\r\n').filter((line) => line !== '')).toHaveLength(1);
    expect(csv.split('\r\n')[0]?.split(',')).toHaveLength(GENERIC_CSV_COLUMNS.length);
  });

  it('例外: 科目マスタに無い補助科目・部門を参照していても throw せず出力できる', () => {
    const entry = createJournalEntry(entryProps({ lines: [
      { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', dimensionValues: { sub_account: 'no-such-value', department: 'no-such-dept' }, taxCode: 'JP-IN-10-S', amount: 1100 },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
    ] }));
    expect(() => exportGenericCsv([entry], chart)).not.toThrow();
    expect(() => genericCsvRows(entry, chart)).not.toThrow();
  });

  it('例外: 日付が想定外の書式でも throw しない', () => {
    expect(() => toSlashDate('2026-9-1')).not.toThrow();
    expect(() => toSlashDate('')).not.toThrow();
  });
});
