/**
 * ドメイン: 経費の集計（docs/21 §20.3.7。UC6。純関数）。
 *
 * 入力は明細単位の索引行（`ExpenseItemFact`）。画面の表・CSV・エージェントツールが同じ関数を使い、同じ数字を出す。
 * - 基準日: `transaction`（明細の取引日の月。無ければ `unknown`）/ `approved`（承認日時を業務のタイムゾーンの日付にした月）/
 *   `settled`（精算日時の月）。承認日・精算日で日時が無い行は除く。
 * - `groupBy` ⊆ month, department, category, claimant, status（重複は無視・入力順・空は month）。束ねていない列は null。
 * - 部門は `departmentId` があればそれ、無ければ写しの部門名。費目名・部門名は**現在の**規程・組織から引き、無ければ id のまま。
 * - 値: 申請の数（異なる申請）・明細の数・金額（1 円以上の明細の合計）・立替分・会社払い分（金額 = 立替分 + 会社払い分）。
 * - 並び: groupBy の列の昇順（unknown は最後）。
 */
import { businessDateOf } from '../business-date';
import { CLAIM_STATUSES, type ClaimStatus } from '../claim';
import { ExpenseDomainError } from '../errors';
import type { ExpenseItemFact } from '../repositories';

export const SUMMARY_GROUP_KEYS = ['month', 'department', 'category', 'claimant', 'status'] as const;
export type SummaryGroupKey = (typeof SUMMARY_GROUP_KEYS)[number];
export const SUMMARY_BASES = ['transaction', 'approved', 'settled'] as const;
export type SummaryBasis = (typeof SUMMARY_BASES)[number];
export const SUMMARY_DEFAULT_STATUSES: readonly ClaimStatus[] = ['approved', 'settled'];
export const SUMMARY_DEFAULT_GROUP_BY: readonly SummaryGroupKey[] = ['month', 'category'];
/** 画面・CSV の期間の上限（月数）。 */
export const SUMMARY_MAX_MONTHS = 36;
export const SUMMARY_UNKNOWN = 'unknown';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export interface SummaryOptions {
  /** `YYYY-MM`（両端を含む）。 */
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly SummaryGroupKey[];
  readonly statuses: readonly ClaimStatus[];
  readonly basis: SummaryBasis;
}

export interface SummaryLookups {
  readonly categoryName: (id: string) => string | undefined;
  readonly departmentName: (id: string) => string | undefined;
  readonly timeZone: string;
}

export interface ExpenseSummaryRow {
  readonly month: string | null;
  readonly departmentId: string | null;
  readonly department: string | null;
  readonly categoryId: string | null;
  readonly category: string | null;
  readonly employeeId: string | null;
  readonly claimant: string | null;
  readonly status: string | null;
  readonly claimCount: number;
  readonly itemCount: number;
  readonly amount: number;
  readonly reimbursableAmount: number;
  readonly corporateAmount: number;
}

export interface ExpenseSummaryTotals {
  readonly claimCount: number;
  readonly itemCount: number;
  readonly amount: number;
  readonly reimbursableAmount: number;
  readonly corporateAmount: number;
}

export interface ExpenseSummaryResult {
  readonly rows: readonly ExpenseSummaryRow[];
  readonly totals: ExpenseSummaryTotals;
  readonly warnings: readonly string[];
  readonly basis: SummaryBasis;
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly SummaryGroupKey[];
  readonly statuses: readonly ClaimStatus[];
}

export function isSummaryMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

/** from から to までの月数（同じ月は 1）。 */
export function monthSpan(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = to.split('-').map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (value - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** `group_by` の文字列（カンマ区切り）。空・省略は既定。不正な値は `ExpenseDomainError`。 */
export function parseSummaryGroupBy(text: string | null | undefined, fallback: readonly SummaryGroupKey[] = SUMMARY_DEFAULT_GROUP_BY): readonly SummaryGroupKey[] {
  if (text === undefined || text === null || text.trim() === '') return [...fallback];
  const keys: SummaryGroupKey[] = [];
  for (const part of text.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')) {
    if (!(SUMMARY_GROUP_KEYS as readonly string[]).includes(part)) {
      throw new ExpenseDomainError('group_by must be a comma-separated list of month, department, category, claimant, status', undefined, { field: 'groupBy' });
    }
    if (!keys.includes(part as SummaryGroupKey)) keys.push(part as SummaryGroupKey);
  }
  return keys.length === 0 ? [...fallback] : keys;
}

/** 状態の文字列（カンマ区切り・`all`）。空・省略は既定（approved, settled）。 */
export function parseSummaryStatuses(text: string | null | undefined): readonly ClaimStatus[] {
  if (text === undefined || text === null || text.trim() === '') return [...SUMMARY_DEFAULT_STATUSES];
  const parts = text.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '');
  if (parts.includes('all')) return [...CLAIM_STATUSES];
  const statuses: ClaimStatus[] = [];
  for (const part of parts) {
    if (!(CLAIM_STATUSES as readonly string[]).includes(part)) {
      throw new ExpenseDomainError(`status must be one of ${CLAIM_STATUSES.join(', ')}, or all`, undefined, { field: 'status' });
    }
    if (!statuses.includes(part as ClaimStatus)) statuses.push(part as ClaimStatus);
  }
  return statuses.length === 0 ? [...SUMMARY_DEFAULT_STATUSES] : statuses;
}

/**
 * 期間の文字列: 年（2026）・月（2026-09）・月の範囲（2026-04..2026-09）。省略は今日の月までの直近 12 か月。
 * 不正な値・逆順・上限（36 か月）超えは `ExpenseDomainError`。
 */
export function parseSummaryPeriod(text: string | null | undefined, today: string, maxMonths = SUMMARY_MAX_MONTHS): { readonly from: string; readonly to: string } {
  const current = today.slice(0, 7);
  if (text === undefined || text === null || text.trim() === '') return { from: shiftMonth(current, -11), to: current };
  const value = text.trim();
  let range: { from: string; to: string } | undefined;
  if (/^\d{4}$/u.test(value)) range = { from: `${value}-01`, to: `${value}-12` };
  else if (isSummaryMonth(value)) range = { from: value, to: value };
  else {
    const match = /^(\d{4}-\d{2})\s*\.\.\s*(\d{4}-\d{2})$/u.exec(value);
    if (match !== null && isSummaryMonth(match[1]) && isSummaryMonth(match[2])) range = { from: match[1], to: match[2] };
  }
  if (range === undefined) throw new ExpenseDomainError('period must be a year (2026), a month (2026-09), or a range of months (2026-04..2026-09)', undefined, { field: 'period' });
  return validateSummaryRange(range.from, range.to, maxMonths);
}

export function validateSummaryRange(from: string, to: string, maxMonths = SUMMARY_MAX_MONTHS): { readonly from: string; readonly to: string } {
  if (!isSummaryMonth(from) || !isSummaryMonth(to)) throw new ExpenseDomainError('from and to must be months in YYYY-MM', undefined, { field: 'period' });
  if (from > to) throw new ExpenseDomainError('from must not be after to', undefined, { field: 'period' });
  if (monthSpan(from, to) > maxMonths) throw new ExpenseDomainError(`the period must be at most ${maxMonths} months`, undefined, { field: 'period' });
  return { from, to };
}

function monthOf(fact: ExpenseItemFact, basis: SummaryBasis, timeZone: string): string | undefined {
  if (basis === 'transaction') return fact.transactionDate === undefined ? SUMMARY_UNKNOWN : fact.transactionDate.slice(0, 7);
  const at = basis === 'approved' ? fact.approvedAt : fact.settledAt;
  if (at === undefined) return undefined;
  const instant = new Date(at);
  return Number.isNaN(instant.getTime()) ? undefined : businessDateOf(instant, timeZone).slice(0, 7);
}

interface GroupValues {
  month: string | null;
  departmentId: string | null;
  department: string | null;
  categoryId: string | null;
  category: string | null;
  employeeId: string | null;
  claimant: string | null;
  status: string | null;
}

interface Bucket extends GroupValues {
  readonly claimIds: Set<string>;
  itemCount: number;
  amount: number;
  reimbursableAmount: number;
  corporateAmount: number;
}

function compareGroupValue(left: string | null, right: string | null): number {
  const l = left ?? '';
  const r = right ?? '';
  if (l === r) return 0;
  if (l === SUMMARY_UNKNOWN) return 1;
  if (r === SUMMARY_UNKNOWN) return -1;
  return l < r ? -1 : 1;
}

/** 集計する。 */
export function summarizeExpenses(facts: readonly ExpenseItemFact[], options: SummaryOptions, lookups: SummaryLookups): ExpenseSummaryResult {
  const groupBy = options.groupBy.length === 0 ? ['month' as const] : [...new Set(options.groupBy)];
  const statuses = new Set<string>(options.statuses.length === 0 ? SUMMARY_DEFAULT_STATUSES : options.statuses);
  const has = (key: SummaryGroupKey): boolean => groupBy.includes(key);
  const buckets = new Map<string, Bucket>();
  const allClaims = new Set<string>();
  let unknownMonths = 0;
  const totals = { itemCount: 0, amount: 0, reimbursableAmount: 0, corporateAmount: 0 };
  for (const fact of facts) {
    if (!statuses.has(fact.status)) continue;
    const month = monthOf(fact, options.basis, lookups.timeZone);
    if (month === undefined) continue;
    if (month !== SUMMARY_UNKNOWN && (month < options.from || month > options.to)) continue;
    if (month === SUMMARY_UNKNOWN) unknownMonths += 1;
    const departmentName = fact.departmentId !== undefined ? lookups.departmentName(fact.departmentId) ?? fact.departmentText ?? fact.departmentId : fact.departmentText;
    const values: GroupValues = {
      month: has('month') ? month : null,
      departmentId: has('department') ? fact.departmentId ?? null : null,
      department: has('department') ? departmentName ?? SUMMARY_UNKNOWN : null,
      categoryId: has('category') ? fact.categoryId ?? null : null,
      category: has('category') ? (fact.categoryId === undefined ? SUMMARY_UNKNOWN : lookups.categoryName(fact.categoryId) ?? fact.categoryId) : null,
      employeeId: has('claimant') ? fact.employeeId ?? null : null,
      claimant: has('claimant') ? fact.claimantName : null,
      status: has('status') ? fact.status : null,
    };
    const key = JSON.stringify([
      values.month, has('department') ? fact.departmentId ?? `text:${fact.departmentText ?? ''}` : null, values.categoryId, values.category,
      has('claimant') ? fact.employeeId ?? `name:${fact.claimantName}` : null, values.status,
    ]);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { ...values, claimIds: new Set(), itemCount: 0, amount: 0, reimbursableAmount: 0, corporateAmount: 0 };
      buckets.set(key, bucket);
    }
    const amount = fact.amount !== undefined && fact.amount > 0 ? fact.amount : 0;
    bucket.claimIds.add(fact.claimId);
    bucket.itemCount += 1;
    bucket.amount += amount;
    if (fact.corporate) bucket.corporateAmount += amount;
    else bucket.reimbursableAmount += amount;
    allClaims.add(fact.claimId);
    totals.itemCount += 1;
    totals.amount += amount;
    if (fact.corporate) totals.corporateAmount += amount;
    else totals.reimbursableAmount += amount;
  }
  const columnOf: Readonly<Record<SummaryGroupKey, (bucket: Bucket) => readonly (string | null)[]>> = {
    month: (bucket) => [bucket.month],
    department: (bucket) => [bucket.department, bucket.departmentId],
    category: (bucket) => [bucket.category, bucket.categoryId],
    claimant: (bucket) => [bucket.claimant, bucket.employeeId],
    status: (bucket) => [bucket.status === null ? null : String(CLAIM_STATUSES.indexOf(bucket.status as ClaimStatus)).padStart(2, '0')],
  };
  const rows = [...buckets.values()].sort((left, right) => {
    for (const key of groupBy) {
      const leftValues = columnOf[key](left);
      const rightValues = columnOf[key](right);
      for (let index = 0; index < leftValues.length; index += 1) {
        const compared = compareGroupValue(leftValues[index] ?? null, rightValues[index] ?? null);
        if (compared !== 0) return compared;
      }
    }
    return 0;
  }).map(({ claimIds, ...bucket }): ExpenseSummaryRow => ({ ...bucket, claimCount: claimIds.size }));
  const warnings = unknownMonths > 0 ? [`取引日の無い明細 ${unknownMonths} 件を月「unknown」に数えました`] : [];
  return { rows, totals: { claimCount: allClaims.size, ...totals }, warnings, basis: options.basis, from: options.from, to: options.to, groupBy, statuses: [...statuses] as ClaimStatus[] };
}

/** ツール・CSV の 1 行（列名は `expense_summary` の出力列）。 */
export type ExpenseSummaryTableRow = {
  readonly month: string | null; readonly department_id: string | null; readonly department: string | null; readonly category_id: string | null;
  readonly category: string | null; readonly employee_id: string | null; readonly claimant: string | null; readonly status: string | null;
  readonly claim_count: number; readonly item_count: number; readonly amount: number; readonly reimbursable_amount: number; readonly corporate_amount: number;
  readonly basis: string; readonly period_from: string; readonly period_to: string; readonly group_by: string;
};

export const EXPENSE_SUMMARY_COLUMNS = [
  'month', 'department_id', 'department', 'category_id', 'category', 'employee_id', 'claimant', 'status',
  'claim_count', 'item_count', 'amount', 'reimbursable_amount', 'corporate_amount', 'basis', 'period_from', 'period_to', 'group_by',
] as const;

export function summaryTableRows(result: ExpenseSummaryResult): readonly ExpenseSummaryTableRow[] {
  const groupBy = result.groupBy.join(',');
  return result.rows.map((row) => ({
    month: row.month, department_id: row.departmentId, department: row.department, category_id: row.categoryId, category: row.category,
    employee_id: row.employeeId, claimant: row.claimant, status: row.status,
    claim_count: row.claimCount, item_count: row.itemCount, amount: row.amount, reimbursable_amount: row.reimbursableAmount, corporate_amount: row.corporateAmount,
    basis: result.basis, period_from: result.from, period_to: result.to, group_by: groupBy,
  }));
}
