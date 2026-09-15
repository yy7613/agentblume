/**
 * ドメイン: 条項の値の型（valueKind）と正規化（docs/23 §2.3）。
 *
 * LLM は 1 回の呼び出しで複数トピックを読むので、応答は valueKind に依らない**平坦な nullable フィールド**で受ける
 * （strict な JSON Schema の `oneOf` はローカルモデルで崩れやすい）。ここで valueKind ごとの型へ寄せ、
 * 範囲外・列挙外のフィールドは**落として警告を残す**。値は補正しない（推測で埋めない）。
 *
 * コードに持つのは「値の型」と「基準から参照できるパス」だけで、条項の種類そのもの（トピック）はデータ。
 */
import { isIsoDate } from './calendar';

export const VALUE_KINDS = ['term', 'auto_renewal', 'notice', 'payment_terms', 'liability_cap', 'permission', 'ip_ownership', 'jurisdiction', 'text'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export const PAYMENT_BASES = ['delivery', 'acceptance', 'invoice', 'unknown'] as const;
export type PaymentBasis = (typeof PAYMENT_BASES)[number];
export const PAYMENT_METHODS = ['bank_transfer', 'promissory_note', 'electronic_record', 'factoring', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const CAP_KINDS = ['none', 'fixed_amount', 'fees_paid', 'fees_months', 'unspecified'] as const;
export type CapKind = (typeof CAP_KINDS)[number];
export const PERMISSION_POLICIES = ['free', 'prior_consent', 'notify', 'prohibited'] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];
/** 甲乙で受ける（どちらが自社かはモデルに推測させず、文書の `ourParty` で写す）。 */
export const IP_OWNERS = ['A', 'B', 'shared', 'unspecified'] as const;
export type IpOwner = (typeof IP_OWNERS)[number];
export const IP_TRANSFER_ON = ['delivery', 'payment', 'creation'] as const;
export type IpTransferOn = (typeof IP_TRANSFER_ON)[number];

export interface TermValue { readonly kind: 'term'; readonly startDate?: string; readonly endDate?: string; readonly durationMonths?: number; readonly startsOnSigning: boolean }
export interface AutoRenewalValue { readonly kind: 'auto_renewal'; readonly renews: boolean; readonly renewalMonths?: number; readonly sameAsInitial: boolean }
export interface NoticeValue { readonly kind: 'notice'; readonly amount: number; readonly unit: 'day' | 'month'; readonly anchor: 'expiry' | 'renewal'; readonly businessDays: boolean }
/** 締め日・支払月・支払日は読めなければ持たない（最長日数は計算不能 = `payment-terms-indeterminate`）。 */
export interface PaymentTermsValue {
  readonly kind: 'payment_terms';
  readonly basis: PaymentBasis;
  readonly closingDay?: number | 'month_end' | 'none';
  readonly payMonthOffset?: number;
  readonly payDay?: number | 'month_end';
  readonly daysAfterBasis?: number;
  readonly method?: PaymentMethod;
}
export interface LiabilityCapValue { readonly kind: 'liability_cap'; readonly capKind: CapKind; readonly amount?: number; readonly months?: number; readonly excludesWillfulOrGross?: boolean }
export interface PermissionValue { readonly kind: 'permission'; readonly policy: PermissionPolicy }
export interface IpOwnershipValue { readonly kind: 'ip_ownership'; readonly owner: IpOwner; readonly transferOn?: IpTransferOn; readonly moralRightsNotExercised?: boolean }
export interface JurisdictionValue { readonly kind: 'jurisdiction'; readonly court?: string; readonly exclusive?: boolean }
export interface TextValue { readonly kind: 'text'; readonly summary: string }

export type ClauseValue = TermValue | AutoRenewalValue | NoticeValue | PaymentTermsValue | LiabilityCapValue | PermissionValue | IpOwnershipValue | JurisdictionValue | TextValue;

/** LLM が返す平坦な値のキー（docs/23 §3.4 の RESPONSE_SCHEMA と同じ並び）。 */
export const FLAT_VALUE_KEYS = [
  'term_start', 'term_end', 'term_months', 'starts_on_signing',
  'renews', 'renewal_months', 'renewal_same_as_initial',
  'notice_amount', 'notice_unit', 'notice_anchor', 'notice_business_days',
  'pay_basis', 'pay_closing_day', 'pay_month_offset', 'pay_day', 'pay_days_after_basis', 'pay_method',
  'cap_kind', 'cap_amount', 'cap_months', 'cap_excludes_willful_or_gross',
  'permission_policy', 'ip_owner_party', 'ip_transfer_on', 'ip_moral_rights_not_exercised',
  'court', 'court_exclusive', 'text_summary',
] as const;
export type FlatValue = Readonly<Partial<Record<(typeof FLAT_VALUE_KEYS)[number], unknown>>>;

export interface NormalizedValue {
  readonly value?: ClauseValue;
  /** 落としたフィールドの説明（空なら全部通った）。 */
  readonly dropped: readonly string[];
}

function oneOf<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw) ? raw as T : undefined;
}
function int(raw: unknown, min: number, max: number): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : undefined;
}
function bool(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}
function str(raw: unknown, max = 300): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' || trimmed.length > max ? undefined : trimmed;
}
function day(raw: unknown): number | 'month_end' | undefined {
  return raw === 'month_end' ? 'month_end' : int(raw, 1, 31);
}

/**
 * 平坦な値 → valueKind の型。null / 未指定のフィールドは「書かれていない」なので黙って省き、
 * **値はあるのに型・範囲に合わない**ものだけを `dropped` に積む（`value-unparsed` の材料）。
 * 必須のフィールド（例: 通知の数と単位）が揃わなければ値そのものを作らない。
 */
export function normalizeFlatValue(valueKind: ValueKind, flat: FlatValue): NormalizedValue {
  const dropped: string[] = [];
  const read = <T>(key: keyof FlatValue, parse: (raw: unknown) => T | undefined): T | undefined => {
    const raw = flat[key];
    if (raw === null || raw === undefined) return undefined;
    const parsed = parse(raw);
    if (parsed === undefined) dropped.push(`${String(key)}=${JSON.stringify(raw)}`);
    return parsed;
  };
  switch (valueKind) {
    case 'term': {
      const startDate = read('term_start', (raw) => isIsoDate(raw) ? raw : undefined);
      const endDate = read('term_end', (raw) => isIsoDate(raw) ? raw : undefined);
      const durationMonths = read('term_months', (raw) => int(raw, 1, 1200));
      const startsOnSigning = read('starts_on_signing', bool) ?? false;
      if (startDate === undefined && endDate === undefined && durationMonths === undefined && !startsOnSigning) return { dropped };
      return { value: { kind: 'term', ...(startDate === undefined ? {} : { startDate }), ...(endDate === undefined ? {} : { endDate }), ...(durationMonths === undefined ? {} : { durationMonths }), startsOnSigning }, dropped };
    }
    case 'auto_renewal': {
      const renews = read('renews', bool);
      const renewalMonths = read('renewal_months', (raw) => int(raw, 1, 1200));
      const sameAsInitial = read('renewal_same_as_initial', bool) ?? false;
      if (renews === undefined) return { dropped };
      return { value: { kind: 'auto_renewal', renews, ...(renewalMonths === undefined ? {} : { renewalMonths }), sameAsInitial }, dropped };
    }
    case 'notice': {
      const amount = read('notice_amount', (raw) => int(raw, 0, 3650));
      const unit = read('notice_unit', (raw) => oneOf(['day', 'month'] as const, raw));
      const anchor = read('notice_anchor', (raw) => oneOf(['expiry', 'renewal'] as const, raw)) ?? 'expiry';
      const businessDays = read('notice_business_days', bool) ?? false;
      if (amount === undefined || unit === undefined) return { dropped };
      return { value: { kind: 'notice', amount, unit, anchor, businessDays }, dropped };
    }
    case 'payment_terms': {
      const basis = read('pay_basis', (raw) => oneOf(PAYMENT_BASES, raw)) ?? 'unknown';
      const closingDay = read('pay_closing_day', (raw) => raw === 'none' ? 'none' as const : day(raw));
      const payMonthOffset = read('pay_month_offset', (raw) => int(raw, 0, 12));
      const payDay = read('pay_day', day);
      const daysAfterBasis = read('pay_days_after_basis', (raw) => int(raw, 0, 3650));
      const method = read('pay_method', (raw) => oneOf(PAYMENT_METHODS, raw));
      if (closingDay === undefined && payMonthOffset === undefined && payDay === undefined && daysAfterBasis === undefined && method === undefined && basis === 'unknown') return { dropped };
      return {
        value: {
          kind: 'payment_terms', basis,
          ...(closingDay === undefined ? {} : { closingDay }), ...(payMonthOffset === undefined ? {} : { payMonthOffset }),
          ...(payDay === undefined ? {} : { payDay }), ...(daysAfterBasis === undefined ? {} : { daysAfterBasis }), ...(method === undefined ? {} : { method }),
        },
        dropped,
      };
    }
    case 'liability_cap': {
      const capKind = read('cap_kind', (raw) => oneOf(CAP_KINDS, raw));
      const amount = read('cap_amount', (raw) => int(raw, 0, Number.MAX_SAFE_INTEGER));
      const months = read('cap_months', (raw) => int(raw, 1, 1200));
      const excludesWillfulOrGross = read('cap_excludes_willful_or_gross', bool);
      if (capKind === undefined) return { dropped };
      return { value: { kind: 'liability_cap', capKind, ...(amount === undefined ? {} : { amount }), ...(months === undefined ? {} : { months }), ...(excludesWillfulOrGross === undefined ? {} : { excludesWillfulOrGross }) }, dropped };
    }
    case 'permission': {
      const policy = read('permission_policy', (raw) => oneOf(PERMISSION_POLICIES, raw));
      return policy === undefined ? { dropped } : { value: { kind: 'permission', policy }, dropped };
    }
    case 'ip_ownership': {
      const owner = read('ip_owner_party', (raw) => oneOf(IP_OWNERS, raw));
      const transferOn = read('ip_transfer_on', (raw) => oneOf(IP_TRANSFER_ON, raw));
      const moralRightsNotExercised = read('ip_moral_rights_not_exercised', bool);
      if (owner === undefined) return { dropped };
      return { value: { kind: 'ip_ownership', owner, ...(transferOn === undefined ? {} : { transferOn }), ...(moralRightsNotExercised === undefined ? {} : { moralRightsNotExercised }) }, dropped };
    }
    case 'jurisdiction': {
      const court = read('court', (raw) => str(raw, 200));
      const exclusive = read('court_exclusive', bool);
      if (court === undefined && exclusive === undefined) return { dropped };
      return { value: { kind: 'jurisdiction', ...(court === undefined ? {} : { court }), ...(exclusive === undefined ? {} : { exclusive }) }, dropped };
    }
    case 'text': {
      const summary = read('text_summary', (raw) => str(raw, 1000));
      return summary === undefined ? { dropped } : { value: { kind: 'text', summary }, dropped };
    }
  }
}

/**
 * 値の形の検証（人が画面で入力した値・保存済みの値にも同じ規則を課す）。
 * 正しければ undefined、崩れていれば理由を返す。
 */
export function clauseValueProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'value must be an object';
  const v = value as Record<string, unknown>;
  const optional = (key: string, check: (raw: unknown) => boolean): boolean => v[key] === undefined || check(v[key]);
  const isInt = (min: number, max: number) => (raw: unknown) => int(raw, min, max) !== undefined;
  const isDay = (raw: unknown) => day(raw) !== undefined;
  const ok = ((): boolean => {
    switch (v['kind']) {
      case 'term': return optional('startDate', isIsoDate) && optional('endDate', isIsoDate) && optional('durationMonths', isInt(1, 1200)) && typeof v['startsOnSigning'] === 'boolean';
      case 'auto_renewal': return typeof v['renews'] === 'boolean' && optional('renewalMonths', isInt(1, 1200)) && typeof v['sameAsInitial'] === 'boolean';
      case 'notice': return int(v['amount'], 0, 3650) !== undefined && oneOf(['day', 'month'], v['unit']) !== undefined && oneOf(['expiry', 'renewal'], v['anchor']) !== undefined && typeof v['businessDays'] === 'boolean';
      case 'payment_terms': return oneOf(PAYMENT_BASES, v['basis']) !== undefined && optional('closingDay', (raw) => raw === 'none' || isDay(raw)) && optional('payMonthOffset', isInt(0, 12)) && optional('payDay', isDay) && optional('daysAfterBasis', isInt(0, 3650)) && optional('method', (raw) => oneOf(PAYMENT_METHODS, raw) !== undefined);
      case 'liability_cap': return oneOf(CAP_KINDS, v['capKind']) !== undefined && optional('amount', isInt(0, Number.MAX_SAFE_INTEGER)) && optional('months', isInt(1, 1200)) && optional('excludesWillfulOrGross', (raw) => typeof raw === 'boolean');
      case 'permission': return oneOf(PERMISSION_POLICIES, v['policy']) !== undefined;
      case 'ip_ownership': return oneOf(IP_OWNERS, v['owner']) !== undefined && optional('transferOn', (raw) => oneOf(IP_TRANSFER_ON, raw) !== undefined) && optional('moralRightsNotExercised', (raw) => typeof raw === 'boolean');
      case 'jurisdiction': return optional('court', (raw) => str(raw, 200) !== undefined) && optional('exclusive', (raw) => typeof raw === 'boolean');
      case 'text': return str(v['summary'], 1000) !== undefined;
      default: return false;
    }
  })();
  return ok ? undefined : `value does not match its kind: ${JSON.stringify(value)}`;
}

/**
 * 基準（`condition`）から参照できるパス。保存時に「そのトピックの valueKind に無いパス」を 400 にするための表。
 * `present` はすべての valueKind で使える。
 */
export const FIELD_PATHS: Readonly<Record<ValueKind, readonly string[]>> = {
  term: ['term.months', 'term.startDate', 'term.endDate', 'term.startsOnSigning'],
  auto_renewal: ['renewal.renews', 'renewal.months'],
  notice: ['notice.days', 'notice.amount', 'notice.unit', 'notice.businessDays'],
  payment_terms: ['payment.maxDays', 'payment.method', 'payment.basis'],
  liability_cap: ['cap.kind', 'cap.amount', 'cap.months', 'cap.excludesWillfulOrGross', 'cap.present'],
  permission: ['permission.policy'],
  ip_ownership: ['ip.owner', 'ip.transferOn', 'ip.moralRightsNotExercised'],
  jurisdiction: ['jurisdiction.court', 'jurisdiction.exclusive'],
  text: [],
};

export function isFieldPathFor(valueKind: ValueKind, path: string): boolean {
  return path === 'present' || FIELD_PATHS[valueKind].includes(path);
}
