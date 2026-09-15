import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from '../errors';
import type { ExpenseItemFact } from '../repositories';
import { summaryToCsv } from './summary-csv';
import {
  monthSpan, parseSummaryGroupBy, parseSummaryPeriod, parseSummaryStatuses, shiftMonth, summarizeExpenses, summaryTableRows, validateSummaryRange,
  type SummaryOptions,
} from './summary';

const lookups = {
  categoryName: (id: string) => ({ 'transport.taxi': 'タクシー', 'meal.entertainment': '交際費' } as Record<string, string>)[id],
  departmentName: (id: string) => ({ 'dept-sales': '営業部' } as Record<string, string>)[id],
  timeZone: 'Asia/Tokyo',
};

function fact(claimId: string, itemId: string, overrides: Partial<ExpenseItemFact> = {}): ExpenseItemFact {
  return {
    claimId, itemId, status: 'approved', transactionDate: '2026-09-10', amount: 1000, categoryId: 'transport.taxi', corporate: false,
    employeeId: 'emp-taro', departmentId: 'dept-sales', claimantName: 'テスト太郎', approvedAt: '2026-09-20T00:00:00.000Z', ...overrides,
  };
}

const options = (overrides: Partial<SummaryOptions> = {}): SummaryOptions => ({ from: '2026-09', to: '2026-10', groupBy: ['month'], statuses: ['approved', 'settled'], basis: 'transaction', ...overrides });

describe('summarizeExpenses', () => {
  it('境界: 取引日の月で束ね、09-30 と 10-01 は別の月。期間の外は除き、取引日の無い明細は unknown で最後に並ぶ', () => {
    const result = summarizeExpenses([
      fact('c1', 'i1', { transactionDate: '2026-10-01' }), fact('c1', 'i2', { transactionDate: '2026-09-30' }),
      fact('c2', 'i1', { transactionDate: undefined }), fact('c3', 'i1', { transactionDate: '2026-08-31' }),
    ], options(), lookups);
    expect(result.rows.map((row) => [row.month, row.itemCount, row.amount])).toEqual([['2026-09', 1, 1000], ['2026-10', 1, 1000], ['unknown', 1, 1000]]);
    expect(result.rows[0]).toMatchObject({ department: null, departmentId: null, category: null, claimant: null, status: null });
    expect(result.warnings).toEqual(['取引日の無い明細 1 件を月「unknown」に数えました']);
    expect(result.totals).toEqual({ claimCount: 2, itemCount: 3, amount: 3000, reimbursableAmount: 3000, corporateAmount: 0 });
  });

  it('境界: 承認日の基準は業務のタイムゾーンの日付（UTC 15:00 は日本時間の翌日）で、承認日時の無い行は除く', () => {
    const result = summarizeExpenses([
      fact('c1', 'i1', { approvedAt: '2026-09-30T14:59:59.000Z' }), fact('c2', 'i1', { approvedAt: '2026-09-30T15:00:00.000Z' }),
      fact('c3', 'i1', { approvedAt: undefined }), fact('c4', 'i1', { approvedAt: 'not a date' }),
    ], options({ basis: 'approved' }), lookups);
    expect(result.rows.map((row) => [row.month, row.claimCount])).toEqual([['2026-09', 1], ['2026-10', 1]]);
    expect(summarizeExpenses([fact('c1', 'i1', { status: 'settled', settledAt: '2026-10-05T00:00:00.000Z' }), fact('c2', 'i1')], options({ basis: 'settled' }), lookups).rows.map((row) => row.month)).toEqual(['2026-10']);
  });

  it('正常: 部門・費目・申請者・状態で束ねる。名前は現在のマスタから引き、無ければ写しの部門名・id、どちらも無ければ unknown', () => {
    const result = summarizeExpenses([
      fact('c1', 'i1'), fact('c1', 'i2', { categoryId: 'meal.entertainment', amount: 5000 }),
      fact('c2', 'i1', { departmentId: undefined, departmentText: '旧 営業二課', employeeId: undefined, claimantName: 'テスト花子' }),
      fact('c3', 'i1', { departmentId: 'dept-gone', categoryId: 'misc.unknown', employeeId: 'emp-jiro', claimantName: 'テスト次郎', status: 'settled' }),
      fact('c4', 'i1', { departmentId: undefined, departmentText: undefined, categoryId: undefined, employeeId: undefined, claimantName: 'テスト三郎' }),
    ], options({ groupBy: ['department', 'category', 'claimant', 'status'] }), lookups);
    expect(result.rows.map((row) => [row.department, row.departmentId, row.category, row.categoryId, row.claimant, row.employeeId, row.status, row.month])).toEqual([
      ['dept-gone', 'dept-gone', 'misc.unknown', 'misc.unknown', 'テスト次郎', 'emp-jiro', 'settled', null],
      ['営業部', 'dept-sales', 'タクシー', 'transport.taxi', 'テスト太郎', 'emp-taro', 'approved', null],
      ['営業部', 'dept-sales', '交際費', 'meal.entertainment', 'テスト太郎', 'emp-taro', 'approved', null],
      ['旧 営業二課', null, 'タクシー', 'transport.taxi', 'テスト花子', null, 'approved', null],
      ['unknown', null, 'unknown', null, 'テスト三郎', null, 'approved', null],
    ]);
  });

  it('正常: 金額 = 立替分 + 会社払い分。金額の無い・0 円の明細は件数だけ数え、申請の数は異なる申請で数える', () => {
    const result = summarizeExpenses([
      fact('c1', 'i1', { amount: 3000 }), fact('c1', 'i2', { amount: 2000, corporate: true }), fact('c1', 'i3', { amount: undefined }), fact('c2', 'i1', { amount: 0 }),
    ], options(), lookups);
    const [row] = result.rows;
    expect(row).toMatchObject({ claimCount: 2, itemCount: 4, amount: 5000, reimbursableAmount: 3000, corporateAmount: 2000 });
    for (const entry of result.rows) expect(entry.amount).toBe(entry.reimbursableAmount + entry.corporateAmount);
  });

  it('正常: 状態の既定は approved と settled。空の groupBy は month、重複は無視、状態の並びは状態の順', () => {
    const facts = [fact('c1', 'i1', { status: 'checked' }), fact('c2', 'i1', { status: 'settled' }), fact('c3', 'i1', { status: 'approved' })];
    expect(summarizeExpenses(facts, options({ statuses: [] }), lookups).totals.claimCount).toBe(2);
    const byStatus = summarizeExpenses(facts, options({ statuses: ['checked', 'approved', 'settled'], groupBy: ['status', 'status'] }), lookups);
    expect(byStatus.groupBy).toEqual(['status']);
    expect(byStatus.rows.map((row) => row.status)).toEqual(['checked', 'approved', 'settled']);
    expect(summarizeExpenses(facts, options({ groupBy: [] }), lookups).groupBy).toEqual(['month']);
  });

  it('正常: 表の行（ツール・CSV の列名）と CSV（BOM・CRLF・見出し）', () => {
    const result = summarizeExpenses([fact('c1', 'i1')], options({ groupBy: ['month', 'category'] }), lookups);
    expect(summaryTableRows(result)).toEqual([{
      month: '2026-09', department_id: null, department: null, category_id: 'transport.taxi', category: 'タクシー', employee_id: null, claimant: null, status: null,
      claim_count: 1, item_count: 1, amount: 1000, reimbursable_amount: 1000, corporate_amount: 0, basis: 'transaction', period_from: '2026-09', period_to: '2026-10', group_by: 'month,category',
    }]);
    const csv = summaryToCsv(result);
    expect(csv.fileName).toBe('expense-summary-2026-09-2026-10-transaction.csv');
    expect(csv.content.startsWith('﻿month,department_id,department,category_id,category,employee_id,claimant,status,claim_count')).toBe(true);
    expect(csv.content).toContain('\r\n2026-09,,,transport.taxi,タクシー,,,,1,1,1000,1000,0,transaction,2026-09,2026-10,"month,category"\r\n');
  });
});

describe('引数の解釈', () => {
  it('正常: group_by はカンマ区切り（大文字・空白・重複を許す）、空は既定の month,category、不正な値は案内付きで断る', () => {
    expect(parseSummaryGroupBy(' Department , month ,month')).toEqual(['department', 'month']);
    expect(parseSummaryGroupBy(undefined)).toEqual(['month', 'category']);
    expect(parseSummaryGroupBy(' , ')).toEqual(['month', 'category']);
    expect(() => parseSummaryGroupBy('month,payee')).toThrow('group_by must be a comma-separated list of month, department, category, claimant, status');
  });

  it('正常: status は 1 つ・カンマ区切り・all。空は approved,settled。不正な値は断る', () => {
    expect(parseSummaryStatuses('in-approval')).toEqual(['in-approval']);
    expect(parseSummaryStatuses('approved, checked')).toEqual(['approved', 'checked']);
    expect(parseSummaryStatuses('ALL')).toHaveLength(6);
    expect(parseSummaryStatuses(null)).toEqual(['approved', 'settled']);
    expect(parseSummaryStatuses(',')).toEqual(['approved', 'settled']);
    expect(() => parseSummaryStatuses('paid')).toThrow(ExpenseDomainError);
  });

  it('境界: period は年・月・月の範囲。省略は今日の月までの 12 か月。逆順・36 か月超・形の違いは断る', () => {
    expect(parseSummaryPeriod(undefined, '2026-09-15')).toEqual({ from: '2025-10', to: '2026-09' });
    expect(parseSummaryPeriod('2026', '2026-09-15')).toEqual({ from: '2026-01', to: '2026-12' });
    expect(parseSummaryPeriod('2026-09', '2026-09-15')).toEqual({ from: '2026-09', to: '2026-09' });
    expect(parseSummaryPeriod('2026-04 .. 2026-09', '2026-09-15')).toEqual({ from: '2026-04', to: '2026-09' });
    expect(parseSummaryPeriod('2024-01..2026-12', '2026-09-15')).toEqual({ from: '2024-01', to: '2026-12' });
    expect(() => parseSummaryPeriod('2023-12..2026-12', '2026-09-15')).toThrow('at most 36 months');
    expect(() => parseSummaryPeriod('2026-09..2026-04', '2026-09-15')).toThrow('must not be after');
    expect(() => parseSummaryPeriod('2026/09', '2026-09-15')).toThrow('period must be');
    expect(() => parseSummaryPeriod('2026-13', '2026-09-15')).toThrow('period must be');
    expect(() => validateSummaryRange('2026-9', '2026-10')).toThrow('YYYY-MM');
  });

  it('正常: 月の計算は年をまたぐ', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthSpan('2025-11', '2026-02')).toBe(4);
  });
});
