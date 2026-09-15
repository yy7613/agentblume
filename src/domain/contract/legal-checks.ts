/**
 * ドメイン: 支払期日・支払手段の照合（docs/23 §4.3）。**設定値との比較であり法的判断ではない。**
 *
 * 取適法（令和 8 年 1 月 1 日施行）とフリーランス法はいずれも「給付を受領した日から**起算して** 60 日以内」で、
 * 公正取引委員会のテキストは受領日を算入する（6/1 受領 → 7/31 払いを「61 日目」と数える）。
 * そこで最長日数は「受領日を 1 日目とした支払日の日数」で数える（例: 月末締め翌々月末払い = 7/1 受領 → 9/30 払い = 92 日目）。
 * 締め日があれば「締め期間の初日に受領 → 締め日で締め → payMonthOffset か月後の payDay」を最悪ケースとして暦で数え、
 * 月の長さで変わるので各月の締め期間初日を受領日にした 12 通りの最大を採る。
 *
 * 月単位の締切制度は「受領後 2 か月以内」として運用される（大の月も小の月も 1 か月）。
 * `allowMonthEndNextMonthEnd` はこの運用を月末締め翌月末払いに当てはめ、暦の上で 62 日目になる月があっても超過にしない設定。
 * 日数・禁止手段・この許容はすべて利用者が編集できる設定値（改正時は画面から更新する）。
 */
import { addDays, daysBetween, daysInMonth, formatIsoDate, lastDayOfMonth, shiftMonth } from './calendar';
import type { PaymentMethod, PaymentTermsValue } from './clause-value';

export interface LegalSourceLink {
  readonly label: string;
  readonly url: string;
}

export interface LegalSettings {
  /** 取適法の観点で照合する支払期日の最長日数（受領日を 1 日目とする）。 */
  readonly paymentMaxDays: number;
  /** フリーランス法の支払期日の最長日数。 */
  readonly freelancePaymentMaxDays: number;
  /** フリーランス法で再委託のとき（元委託の支払期日から）の最長日数。MVP では表示だけに使う。 */
  readonly freelanceRedelegationMaxDays: number;
  readonly prohibitedPaymentMethods: readonly PaymentMethod[];
  readonly allowMonthEndNextMonthEnd: boolean;
  /** 期限台帳で「期限が近い」とする日数。 */
  readonly dueSoonDays: number;
  /** 初期値の出典（画面に出す）。 */
  readonly sources: readonly LegalSourceLink[];
}

/** 12 通りの受領月を並べる基準年（うるう年でない年。最大は 2 月を含まない期間で出るので年に依らない）。 */
const REFERENCE_YEAR = 2026;

export type PaymentMaxDaysResult =
  | { readonly kind: 'computed'; readonly maxDays: number; readonly receivedOn: string; readonly paidOn: string; readonly monthEndAllowance: boolean }
  | { readonly kind: 'fixed'; readonly maxDays: number }
  | { readonly kind: 'indeterminate'; readonly missing: string };

/** 支払条件 → 最長日数（受領日を 1 日目とした日数）。 */
export function paymentMaxDays(terms: PaymentTermsValue): PaymentMaxDaysResult {
  if (terms.daysAfterBasis !== undefined) return { kind: 'fixed', maxDays: terms.daysAfterBasis + 1 };
  if (terms.payDay === undefined) return { kind: 'indeterminate', missing: 'payDay' };
  if (terms.payMonthOffset === undefined) return { kind: 'indeterminate', missing: 'payMonthOffset' };
  // 締め日の記載が無い「受領月の翌月末払い」は月末締めと同じ数え方になる。
  const closing = terms.closingDay === undefined || terms.closingDay === 'none' ? 'month_end' : terms.closingDay;
  const payDay = terms.payDay;
  let worst: { maxDays: number; receivedOn: string; paidOn: string } | undefined;
  for (let month = 1; month <= 12; month += 1) {
    const closingDate = closing === 'month_end' ? lastDayOfMonth(REFERENCE_YEAR, month) : formatIsoDate({ y: REFERENCE_YEAR, m: month, d: Math.min(closing, daysInMonth(REFERENCE_YEAR, month)) });
    const previous = shiftMonth(REFERENCE_YEAR, month, -1);
    const receivedOn = closing === 'month_end'
      ? formatIsoDate({ y: REFERENCE_YEAR, m: month, d: 1 })
      : addDays(formatIsoDate({ y: previous.y, m: previous.m, d: Math.min(closing, daysInMonth(previous.y, previous.m)) }), 1);
    const payMonth = shiftMonth(REFERENCE_YEAR, month, terms.payMonthOffset);
    const paidOn = payDay === 'month_end' ? lastDayOfMonth(payMonth.y, payMonth.m) : formatIsoDate({ y: payMonth.y, m: payMonth.m, d: Math.min(payDay, daysInMonth(payMonth.y, payMonth.m)) });
    // 締めより前に払う組み合わせ（当月締め当月 10 日払い等）は条件の読み違いの徴候。補正せず計算不能にする。
    if (daysBetween(closingDate, paidOn) < 0) return { kind: 'indeterminate', missing: 'payDay' };
    const days = daysBetween(receivedOn, paidOn) + 1;
    if (worst === undefined || days > worst.maxDays) worst = { maxDays: days, receivedOn, paidOn };
  }
  /* v8 ignore next -- 12 か月を必ず回るので worst は必ず埋まる。 */
  if (worst === undefined) return { kind: 'indeterminate', missing: 'payDay' };
  // 締め日・支払日の「31 日」は暦の上で末日と同じ（短い月は末日に丸める）ので、許容の判定でも末日として扱う。
  const monthEnd = (day: number | 'month_end') => day === 'month_end' || day === 31;
  const monthEndAllowance = monthEnd(closing) && terms.payMonthOffset === 1 && monthEnd(payDay);
  return { kind: 'computed', ...worst, monthEndAllowance };
}

export interface CounterpartyProfile {
  readonly toriteki: 'yes' | 'no' | 'unknown';
  readonly freelance: 'yes' | 'no' | 'unknown';
}

export type LegalOutcome =
  | { readonly outcome: 'pass'; readonly detail: Readonly<Record<string, string | number | boolean | null>> }
  | { readonly outcome: 'not-applicable' }
  | { readonly outcome: 'fail' | 'unresolved'; readonly reason: 'payment-over-limit' | 'payment-terms-indeterminate' | 'counterparty-profile-missing' | 'prohibited-payment-method' | 'field-missing'; readonly detail: Readonly<Record<string, string | number | boolean | null>> };

/** 相手方の申告から照合する上限日数。どちらも yes でなければ undefined。 */
export function applicablePaymentLimit(profile: CounterpartyProfile, legal: LegalSettings): number | undefined {
  const limits = [
    ...(profile.toriteki === 'yes' ? [legal.paymentMaxDays] : []),
    ...(profile.freelance === 'yes' ? [legal.freelancePaymentMaxDays] : []),
  ];
  return limits.length === 0 ? undefined : Math.min(...limits);
}

function worstCaseText(result: PaymentMaxDaysResult): string | null {
  return result.kind === 'computed' ? `${result.receivedOn} 受領 → ${result.paidOn} 支払（${result.maxDays} 日目）` : null;
}

/** 最長日数が上限内か（月末締め翌月末払いの許容を含む）。 */
export function withinPaymentLimit(result: PaymentMaxDaysResult, limit: number, legal: LegalSettings): boolean {
  if (result.kind === 'indeterminate') return false;
  if (result.maxDays <= limit) return true;
  // 「受領後 2 か月以内」の運用: 大の月を含んでも 1 か月は 1 か月として数える。
  return result.kind === 'computed' && result.monthEndAllowance && legal.allowMonthEndNextMonthEnd && limit >= 60;
}

/** `legal: payment-max-days`。立場の確認（client か）は呼び出し側で済ませる。 */
export function checkPaymentMaxDays(terms: PaymentTermsValue, profile: CounterpartyProfile, legal: LegalSettings): LegalOutcome {
  const result = paymentMaxDays(terms);
  const limit = applicablePaymentLimit(profile, legal);
  if (limit === undefined) {
    if (profile.toriteki === 'no' && profile.freelance === 'no') return { outcome: 'not-applicable' };
    return { outcome: 'unresolved', reason: 'counterparty-profile-missing', detail: { maxDays: result.kind === 'indeterminate' ? null : result.maxDays, worstCase: worstCaseText(result) } };
  }
  if (result.kind === 'indeterminate') return { outcome: 'unresolved', reason: 'payment-terms-indeterminate', detail: { missing: result.missing, limit } };
  const detail = { maxDays: result.maxDays, limit, worstCase: worstCaseText(result), monthEndAllowance: result.kind === 'computed' && result.monthEndAllowance && legal.allowMonthEndNextMonthEnd };
  return withinPaymentLimit(result, limit, legal) ? { outcome: 'pass', detail } : { outcome: 'fail', reason: 'payment-over-limit', detail };
}

/** `legal: prohibited-payment-method`（取適法の相手方だけに当てる）。 */
export function checkProhibitedPaymentMethod(terms: PaymentTermsValue, profile: CounterpartyProfile, legal: LegalSettings): LegalOutcome {
  if (profile.toriteki === 'no') return { outcome: 'not-applicable' };
  if (profile.toriteki === 'unknown') return { outcome: 'unresolved', reason: 'counterparty-profile-missing', detail: { method: terms.method ?? null } };
  if (terms.method === undefined) return { outcome: 'unresolved', reason: 'field-missing', detail: { field: 'payment.method' } };
  return legal.prohibitedPaymentMethods.includes(terms.method)
    ? { outcome: 'fail', reason: 'prohibited-payment-method', detail: { method: terms.method } }
    : { outcome: 'pass', detail: { method: terms.method } };
}
