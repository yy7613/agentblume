/**
 * ドメイン: 契約の期限計算（docs/23 §5.2。純関数）。
 *
 * LLM に日付を計算させると月末・うるう年で誤り、同じ契約でも実行ごとに期限が揺れる（ADR-0042 §6）。
 * ここは暦の規則だけで決め、境界は表形式のテストで固定する。
 *
 * - R1 満了日: 始期 S から N か月。応当日が存在すれば**その前日**、存在しなければ**その月の末日**（民法 143 条の考え方）。
 * - R5 「満了の N か月前まで」: E から N か月戻した**同日**。無ければその月の末日。**E が月末なら戻した月の末日**。
 * - R6 「満了の N 日前まで」: E − N 暦日。営業日は計算しない（呼び出し側が value-unparsed にする）。
 * - R8 現在期: 今日 T に対し `termEnd >= T` となる最初の期（最大 100 期で打ち切り）。
 * - R10 表示状態: overdue / due-soon / upcoming は今日から派生し、保存しない。
 */
import { addDays, compareIsoDates, daysBetween, daysInMonth, formatIsoDate, isLastDayOfMonth, lastDayOfMonth, parseIsoDate, shiftMonth } from './calendar';

/** R1。months が 1 未満なら計算しない（「0 か月の契約」は読み違いの徴候なので日付を作らない）。 */
export function computeTermEndDate(startDate: string, months: number): string | undefined {
  if (!Number.isInteger(months) || months < 1) return undefined;
  const start = parseIsoDate(startDate);
  const target = shiftMonth(start.y, start.m, months);
  if (start.d > daysInMonth(target.y, target.m)) return lastDayOfMonth(target.y, target.m);
  return addDays(formatIsoDate({ y: target.y, m: target.m, d: start.d }), -1);
}

/** R5。months = 0 は満了日そのもの。 */
export function noticeDeadlineByMonths(endDate: string, months: number): string {
  const end = parseIsoDate(endDate);
  const target = shiftMonth(end.y, end.m, -months);
  if (isLastDayOfMonth(endDate)) return lastDayOfMonth(target.y, target.m);
  return formatIsoDate({ y: target.y, m: target.m, d: Math.min(end.d, daysInMonth(target.y, target.m)) });
}

/** R6。 */
export function noticeDeadlineByDays(endDate: string, days: number): string {
  return addDays(endDate, -days);
}

/** 満了日から期間の月数を逆算する（R1 で一致する整数月があるときだけ）。 */
export function monthsBetweenTerm(startDate: string, endDate: string): number | undefined {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const approx = (end.y - start.y) * 12 + (end.m - start.m);
  for (const candidate of [approx, approx + 1]) {
    if (candidate >= 1 && computeTermEndDate(startDate, candidate) === endDate) return candidate;
  }
  return undefined;
}

export interface TermInput {
  /** 始期。締結日始まり（R3）なら締結日を渡す。 */
  readonly startDate?: string;
  /** 明記の満了日（R2。あればこれを採る）。 */
  readonly endDate?: string;
  readonly durationMonths?: number;
  readonly renews: boolean;
  /** 更新期間（`sameAsInitial` の解決は呼び出し側）。 */
  readonly renewalMonths?: number;
}

export interface TermPeriod {
  /** 1 始まり。 */
  readonly index: number;
  readonly start?: string;
  readonly end: string;
}

export interface TermSchedule {
  readonly current: TermPeriod;
  /** 現在期より前の期（期限の履歴を superseded にするため）。 */
  readonly past: readonly TermPeriod[];
  /** 100 期で打ち切った。 */
  readonly truncated: boolean;
}

export const MAX_TERMS = 100;

/** 期の並びと現在期（R1〜R4・R8）。初回の満了日が決まらなければ undefined。 */
export function buildTermSchedule(input: TermInput, today: string): TermSchedule | undefined {
  const firstEnd = input.endDate ?? (input.startDate !== undefined && input.durationMonths !== undefined ? computeTermEndDate(input.startDate, input.durationMonths) : undefined);
  if (firstEnd === undefined) return undefined;
  let current: TermPeriod = { index: 1, ...(input.startDate === undefined ? {} : { start: input.startDate }), end: firstEnd };
  const past: TermPeriod[] = [];
  if (!input.renews || input.renewalMonths === undefined) return { current, past, truncated: false };
  while (compareIsoDates(current.end, today) < 0) {
    if (current.index >= MAX_TERMS) return { current, past, truncated: true };
    past.push(current);
    const start = addDays(current.end, 1);
    const end = computeTermEndDate(start, input.renewalMonths);
    /* v8 ignore next -- renewalMonths >= 1 は呼び出し側で保証済み。念のため無限ループを避ける。 */
    if (end === undefined) return { current, past, truncated: false };
    current = { index: current.index + 1, start, end };
  }
  return { current, past, truncated: false };
}

export type DeadlineDisplayState = 'overdue' | 'due-soon' | 'upcoming';

/** R10。期限当日は due-soon、翌日から overdue。 */
export function deadlineDisplayState(dueDate: string, today: string, dueSoonDays: number): DeadlineDisplayState {
  const left = daysBetween(today, dueDate);
  if (left < 0) return 'overdue';
  return left <= dueSoonDays ? 'due-soon' : 'upcoming';
}
