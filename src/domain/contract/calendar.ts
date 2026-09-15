/**
 * ドメイン: 契約の期限計算が使う暦の演算（docs/23 §5.1）。
 *
 * 日付は `YYYY-MM-DD` 文字列、計算は `{ y, m, d }` の整数で行い、`Date` とタイムゾーンを経由しない。
 * `Date` を使うとサーバーの TZ で 1 日ずれる事故が起きうるが、期限台帳は 1 日ずれると意味が無い。
 * 「今日」は application が引数で渡す（ここでは時計を読まない）。
 */

export interface YearMonthDay {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 暦の上で存在する `YYYY-MM-DD` か（2/30 や 13 月を落とす）。 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** 呼び出し側が `isIsoDate` を確かめてから使う（不正なら例外で気づかせる）。 */
export function parseIsoDate(value: string): YearMonthDay {
  if (!isIsoDate(value)) throw new RangeError(`not a calendar date: ${value}`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function formatIsoDate(date: YearMonthDay): string {
  return `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

/** グレゴリオ暦の通日（0001-03-01 起点の連番。差だけに使う）。 */
function dayNumber({ y, m, d }: YearMonthDay): number {
  const year = m <= 2 ? y - 1 : y;
  const month = m <= 2 ? m + 12 : m;
  return 365 * year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + Math.floor((153 * (month - 3) + 2) / 5) + d;
}

/** `to - from` の暦日数（to が前なら負）。 */
export function daysBetween(from: string, to: string): number {
  return dayNumber(parseIsoDate(to)) - dayNumber(parseIsoDate(from));
}

export function addDays(date: string, days: number): string {
  let { y, m, d } = parseIsoDate(date);
  let remaining = days;
  // 月単位で進める（最大でも数千日なので十分速い）。
  while (remaining > 0) {
    const left = daysInMonth(y, m) - d;
    if (remaining <= left) { d += remaining; remaining = 0; } else { remaining -= left + 1; d = 1; m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  while (remaining < 0) {
    if (-remaining < d) { d += remaining; remaining = 0; } else { remaining += d; m -= 1; if (m < 1) { m = 12; y -= 1; } d = daysInMonth(y, m); }
  }
  return formatIsoDate({ y, m, d });
}

/** 年月だけを months 進める（日は触らない）。 */
export function shiftMonth(y: number, m: number, months: number): { readonly y: number; readonly m: number } {
  const index = y * 12 + (m - 1) + months;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

export function lastDayOfMonth(y: number, m: number): string {
  return formatIsoDate({ y, m, d: daysInMonth(y, m) });
}

export function isLastDayOfMonth(date: string): boolean {
  const { y, m, d } = parseIsoDate(date);
  return d === daysInMonth(y, m);
}

/** `YYYY-MM-DD` の比較（辞書順が暦順と一致する）。 */
export function compareIsoDates(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
