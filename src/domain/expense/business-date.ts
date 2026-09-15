/**
 * ドメイン: 業務のタイムゾーンでの日付（純関数）。
 *
 * 判定の「今日」を `Date#toISOString()` の UTC 日付で取ると、日本時間 0〜9 時に当日のレシートが
 * `date-in-future` になる（docs/21 §3.3）。時刻は呼び出し側（application）が注入し、ここは暦の計算だけを持つ。
 */

/** 経費の業務日付を決めるタイムゾーンの既定。 */
export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Tokyo';

/** 時刻をそのタイムゾーンの暦日（`YYYY-MM-DD`）にする。 */
export function businessDateOf(instant: Date, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** `from` から `to` までの日数（同じ日は 0、`to` が前なら負）。どちらも実在する `YYYY-MM-DD` を前提にする。 */
export function daysBetween(from: string, to: string): number {
  const toUtc = (value: string): number => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}
