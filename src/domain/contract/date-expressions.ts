/**
 * ドメイン: 本文の日付・期間表現を走査する（docs/23 §5.3 の突き合わせの材料）。
 *
 * 和暦（令和・平成・昭和、元年）と「三箇月」「3ヶ月」「３か月」「９０日」「1年間」を正規化する。
 * 仕訳 BC にも和暦の解析があるが、BC 間の依存を作らないため契約用の実装を持つ（docs/23 §9.4 C7 は後回し）。
 */
import { formatIsoDate, isIsoDate } from './calendar';

export interface DateExpression {
  readonly iso: string;
  readonly raw: string;
}

export interface DurationExpression {
  readonly amount: number;
  readonly unit: 'day' | 'month' | 'year' | 'week';
  /** 月へ直した値（year は 12 倍）。day / week は undefined。 */
  readonly months?: number;
  /** 日へ直した値（week は 7 倍）。month / year は undefined。 */
  readonly days?: number;
  readonly raw: string;
}

const KANJI_DIGITS: Readonly<Record<string, number>> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

/** 漢数字（十・百・千まで）または算用数字 → 整数。読めなければ undefined。 */
export function parseJapaneseNumber(value: string): number | undefined {
  const text = value.normalize('NFKC').trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '' || ![...text].every((char) => char in KANJI_DIGITS || char in KANJI_UNITS)) return undefined;
  let total = 0;
  let digit: number | undefined;
  for (const char of text) {
    if (char in KANJI_DIGITS) {
      // 「二〇二六」のような位取り表記も受ける。
      digit = digit === undefined ? KANJI_DIGITS[char]! : digit * 10 + KANJI_DIGITS[char]!;
    } else {
      total += (digit ?? 1) * KANJI_UNITS[char]!;
      digit = undefined;
    }
  }
  return total + (digit ?? 0);
}

const ERA_BASE: Readonly<Record<string, number>> = { 令和: 2018, R: 2018, 平成: 1988, H: 1988, 昭和: 1925, S: 1925 };

const NUMBER = '[0-9一二三四五六七八九十〇零百千]+';
const DATE_PATTERN = new RegExp(`(令和|平成|昭和|R|H|S)?\\s*(元|${NUMBER})\\s*年\\s*(${NUMBER})\\s*月\\s*(${NUMBER})\\s*日|(\\d{4})[/.\\-](\\d{1,2})[/.\\-](\\d{1,2})`, 'gu');
const DURATION_PATTERN = new RegExp(`(${NUMBER})\\s*(か月|ヶ月|ケ月|カ月|ヵ月|箇月|ヶ月間|か月間|箇月間|月間|年間|年|日間|日|週間)`, 'gu');

/** 本文の日付表現（和暦は西暦へ換算。暦に無い日付は落とす）。 */
export function scanDates(text: string): readonly DateExpression[] {
  const normalized = text.normalize('NFKC');
  const found: DateExpression[] = [];
  for (const match of normalized.matchAll(DATE_PATTERN)) {
    let y: number | undefined; let m: number | undefined; let d: number | undefined;
    if (match[5] !== undefined) {
      y = Number(match[5]); m = Number(match[6]); d = Number(match[7]);
    } else {
      const era = match[1];
      const yearText = match[2]!;
      const yearNumber = yearText === '元' ? 1 : parseJapaneseNumber(yearText);
      y = yearNumber === undefined ? undefined : era === undefined ? yearNumber : ERA_BASE[era]! + yearNumber;
      m = parseJapaneseNumber(match[3]!);
      d = parseJapaneseNumber(match[4]!);
    }
    if (y === undefined || m === undefined || d === undefined) continue;
    const iso = formatIsoDate({ y, m, d });
    if (isIsoDate(iso)) found.push({ iso, raw: match[0] });
  }
  return found;
}

/** 本文の期間表現。日付の「年」「日」と取り違えないよう、日付の部分を先に消してから探す。 */
export function scanDurations(text: string): readonly DurationExpression[] {
  const normalized = text.normalize('NFKC').replace(DATE_PATTERN, ' ');
  const found: DurationExpression[] = [];
  for (const match of normalized.matchAll(DURATION_PATTERN)) {
    const amount = parseJapaneseNumber(match[1]!);
    if (amount === undefined) continue;
    const unitText = match[2]!;
    const raw = match[0];
    if (unitText.startsWith('年')) found.push({ amount, unit: 'year', months: amount * 12, raw });
    else if (unitText.startsWith('日')) found.push({ amount, unit: 'day', days: amount, raw });
    else if (unitText.startsWith('週')) found.push({ amount, unit: 'week', days: amount * 7, raw });
    else found.push({ amount, unit: 'month', months: amount, raw });
  }
  return found;
}
