/**
 * ドメイン: 明細の正規化済み事実（ReceiptFacts。docs/21 §2.4）。
 *
 * 金額は税込整数（円）、日付は `YYYY-MM-DD`。無いものは undefined。**値を推測で埋めない**（仕訳 §6 と同じ）。
 * 判定（`check.ts`）はここだけを見る。
 *
 * 形の合わない登録番号は保存時に 400 にせず、落として警告に残す（`sanitizeReceiptFacts`）。登録番号の桁数誤りは
 * 読取で最も多い失敗で、1 項目の誤りで取込全体を止めると人が直す機会そのものを失うため。
 */
import { isIsoDate, PAYMENT_METHODS, REGISTRATION_NUMBER_PATTERN, TAX_RATES, type PaymentMethod, type TotalsByRate } from '../journal/document';
import { normalizeRegistrationNumber } from '../journal/normalize';
import { ExpenseDomainError } from './errors';

export const DATE_SOURCES = ['read', 'manual', 'issue-copied'] as const;
/** 取引日の出所。`issue-copied` は画面の「発行日を取引日にする」で写したもの（経過措置の根拠を後から追うため残す）。 */
export type DateSource = (typeof DATE_SOURCES)[number];

export interface Attendees {
  /** 参加人数（1 以上）。申請者を含むかは規程の `attendeesIncludeClaimant`。 */
  readonly count?: number;
  /** 参加者の氏名・社名。 */
  readonly names?: readonly string[];
  /** 自社との関係（取引先・社内など）。 */
  readonly relation?: string;
}

export const ROUTE_FARE_TYPES = ['ic', 'ticket'] as const;
/** 運賃の券種（IC / 切符）。 */
export type FareType = (typeof ROUTE_FARE_TYPES)[number];
export const ROUTE_MIN_STATIONS = 2;
export const ROUTE_MAX_STATIONS = 30;
export const ROUTE_STATION_NAME_MAX = 40;
export const ROUTE_MAX_TRIPS = 40;

/** 交通費の区間（docs/21 §20.2.4。UC8）。駅名は入力のまま保存し、比較は C の駅キー（`input/station.ts`）で行う。 */
export interface ReceiptRoute {
  /** [出発, …経由, 到着]（2〜30 駅）。 */
  readonly stations: readonly string[];
  /** 片道の回数（往復は 2）。 */
  readonly trips: number;
  /** 省略時は規程の `transport.defaultFareType`。 */
  readonly fareType?: FareType;
}

export interface ReceiptFacts {
  /** 取引日。期間・提出期限・重複・経過措置の判定はこの値だけを使う。 */
  readonly transactionDate?: string;
  /** 発行日（参考。判定の日付には使わない — 取り違えの実測があるため）。 */
  readonly issueDate?: string;
  /** 支払先（店舗・事業者）。電帳法の検索要件「取引先」。 */
  readonly payeeName?: string;
  /** `T` + 13 桁。 */
  readonly registrationNumber?: string;
  /** 税込の支払額。電帳法の検索要件「取引金額」。 */
  readonly amount?: number;
  readonly totalsByRate?: readonly TotalsByRate[];
  readonly paymentMethod?: PaymentMethod;
  /** 会社払い（法人カード・会社の口座から支払済み）。 */
  readonly corporatePayment?: boolean;
  readonly description?: string;
  readonly purpose?: string;
  readonly attendees?: Attendees;
  /** 日数・泊数。 */
  readonly unitCount?: number;
  /** 事前承認の番号・記録（稟議番号など）。 */
  readonly preApprovalRef?: string;
  readonly dateSource?: DateSource;
  /** 交通費の区間（費目に `route` 設定がある明細。無い明細・既存の明細は省略）。 */
  readonly route?: ReceiptRoute;
}

/** 駅の並び（区間・通勤定期・運賃マスタで共通）を検証して前後空白を除く。 */
export function validateStations(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < ROUTE_MIN_STATIONS || value.length > ROUTE_MAX_STATIONS) {
    throw new ExpenseDomainError(`${label} must have ${ROUTE_MIN_STATIONS} to ${ROUTE_MAX_STATIONS} stations`);
  }
  return value.map((station: unknown, index) => {
    if (typeof station !== 'string' || station.trim() === '' || station.trim().length > ROUTE_STATION_NAME_MAX) {
      throw new ExpenseDomainError(`${label}[${index}] must be 1 to ${ROUTE_STATION_NAME_MAX} characters`);
    }
    return station.trim();
  });
}

function validateRoute(value: unknown, label: string): ReceiptRoute | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ExpenseDomainError(`${label} must be { stations, trips, fareType? }`);
  const raw = value as Record<string, unknown>;
  const trips = raw['trips'] === undefined || raw['trips'] === null ? 1 : raw['trips'];
  if (typeof trips !== 'number' || !Number.isInteger(trips) || trips < 1 || trips > ROUTE_MAX_TRIPS) throw new ExpenseDomainError(`${label}.trips must be an integer between 1 and ${ROUTE_MAX_TRIPS}`);
  const fareType = raw['fareType'];
  if (fareType !== undefined && fareType !== null && !(ROUTE_FARE_TYPES as readonly unknown[]).includes(fareType)) throw new ExpenseDomainError(`${label}.fareType must be one of ${ROUTE_FARE_TYPES.join(', ')}`);
  return {
    stations: validateStations(raw['stations'], `${label}.stations`),
    trips,
    ...(fareType === undefined || fareType === null ? {} : { fareType: fareType as FareType }),
  };
}

/** 文字列項目の長さの上限（DB の肥大と画面の崩れを防ぐ程度の値。規程の数値ではない）。 */
const TEXT_LIMITS = { payeeName: 200, description: 500, purpose: 500, relation: 200, preApprovalRef: 100, attendeeName: 100 } as const;
const MAX_ATTENDEE_NAMES = 50;
const MAX_TOTALS_BY_RATE = 10;

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** 前後空白を除いた文字列。空なら undefined。 */
function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) throw fail(`${label} must be at most ${max} characters`);
  return trimmed;
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isIsoDate(value)) throw fail(`${label} must be a date in YYYY-MM-DD`);
  return value;
}

function optionalInteger(value: unknown, label: string, min?: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw fail(`${label} must be an integer`);
  if (min !== undefined && value < min) throw fail(`${label} must be at least ${min}`);
  return value;
}

/** 事実の不変条件（日付の実在・整数・登録番号の形・人数 ≥ 1）を検証して防御的コピーを返す。 */
export function validateReceiptFacts(value: unknown, label = 'receipt facts'): ReceiptFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;

  const registrationNumber = optionalText(raw['registrationNumber'], `${label}.registrationNumber`, 14);
  if (registrationNumber !== undefined && !REGISTRATION_NUMBER_PATTERN.test(registrationNumber)) throw fail(`${label}.registrationNumber must be T followed by 13 digits`);

  let totalsByRate: readonly TotalsByRate[] | undefined;
  if (raw['totalsByRate'] !== undefined && raw['totalsByRate'] !== null) {
    if (!Array.isArray(raw['totalsByRate'])) throw fail(`${label}.totalsByRate must be an array`);
    if (raw['totalsByRate'].length > MAX_TOTALS_BY_RATE) throw fail(`${label}.totalsByRate must have at most ${MAX_TOTALS_BY_RATE} entries`);
    const entries = raw['totalsByRate'].map((entry: unknown, index) => {
      const entryLabel = `${label}.totalsByRate[${index}]`;
      if (entry === null || typeof entry !== 'object') throw fail(`${entryLabel} must be an object`);
      const item = entry as Record<string, unknown>;
      if (!(TAX_RATES as readonly unknown[]).includes(item['rate'])) throw fail(`${entryLabel}.rate must be one of ${TAX_RATES.join(', ')}`);
      const taxableAmount = optionalInteger(item['taxableAmount'], `${entryLabel}.taxableAmount`);
      if (taxableAmount === undefined) throw fail(`${entryLabel}.taxableAmount must be an integer`);
      if (typeof item['amountIncludesTax'] !== 'boolean') throw fail(`${entryLabel}.amountIncludesTax must be a boolean`);
      return withDefined({
        rate: item['rate'] as TotalsByRate['rate'],
        taxableAmount,
        taxAmount: optionalInteger(item['taxAmount'], `${entryLabel}.taxAmount`),
        amountIncludesTax: item['amountIncludesTax'],
      });
    });
    totalsByRate = entries.length === 0 ? undefined : entries;
  }

  const paymentMethod = raw['paymentMethod'];
  if (paymentMethod !== undefined && paymentMethod !== null && !(PAYMENT_METHODS as readonly unknown[]).includes(paymentMethod)) {
    throw fail(`${label}.paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  const corporatePayment = raw['corporatePayment'];
  if (corporatePayment !== undefined && corporatePayment !== null && typeof corporatePayment !== 'boolean') throw fail(`${label}.corporatePayment must be a boolean`);
  const dateSource = raw['dateSource'];
  if (dateSource !== undefined && dateSource !== null && !(DATE_SOURCES as readonly unknown[]).includes(dateSource)) throw fail(`${label}.dateSource must be one of ${DATE_SOURCES.join(', ')}`);

  let attendees: Attendees | undefined;
  if (raw['attendees'] !== undefined && raw['attendees'] !== null) {
    if (typeof raw['attendees'] !== 'object' || Array.isArray(raw['attendees'])) throw fail(`${label}.attendees must be an object`);
    const source = raw['attendees'] as Record<string, unknown>;
    let names: readonly string[] | undefined;
    if (source['names'] !== undefined && source['names'] !== null) {
      if (!Array.isArray(source['names']) || source['names'].some((name) => typeof name !== 'string')) throw fail(`${label}.attendees.names must be an array of strings`);
      if (source['names'].length > MAX_ATTENDEE_NAMES) throw fail(`${label}.attendees.names must have at most ${MAX_ATTENDEE_NAMES} entries`);
      const trimmed = (source['names'] as string[]).map((name, index) => optionalText(name, `${label}.attendees.names[${index}]`, TEXT_LIMITS.attendeeName)).filter((name): name is string => name !== undefined);
      names = trimmed.length === 0 ? undefined : trimmed;
    }
    const built = withDefined({
      count: optionalInteger(source['count'], `${label}.attendees.count`, 1),
      names,
      relation: optionalText(source['relation'], `${label}.attendees.relation`, TEXT_LIMITS.relation),
    });
    attendees = Object.keys(built).length === 0 ? undefined : built;
  }

  return withDefined({
    transactionDate: optionalDate(raw['transactionDate'], `${label}.transactionDate`),
    issueDate: optionalDate(raw['issueDate'], `${label}.issueDate`),
    payeeName: optionalText(raw['payeeName'], `${label}.payeeName`, TEXT_LIMITS.payeeName),
    registrationNumber,
    amount: optionalInteger(raw['amount'], `${label}.amount`),
    totalsByRate,
    paymentMethod: paymentMethod === null ? undefined : paymentMethod as PaymentMethod | undefined,
    corporatePayment: corporatePayment === null ? undefined : corporatePayment as boolean | undefined,
    description: optionalText(raw['description'], `${label}.description`, TEXT_LIMITS.description),
    purpose: optionalText(raw['purpose'], `${label}.purpose`, TEXT_LIMITS.purpose),
    attendees,
    unitCount: optionalInteger(raw['unitCount'], `${label}.unitCount`, 1),
    preApprovalRef: optionalText(raw['preApprovalRef'], `${label}.preApprovalRef`, TEXT_LIMITS.preApprovalRef),
    dateSource: dateSource === null ? undefined : dateSource as DateSource | undefined,
    // 末尾に置く（無い明細の既存のキーの並びを変えない。§20.2.13 のバイト同一）。
    route: validateRoute(raw['route'], `${label}.route`),
  });
}

export interface SanitizedReceiptFacts {
  readonly facts: ReceiptFacts;
  /** 値を落とした理由（日本語）。明細の `extraction.warnings` に積む。 */
  readonly warnings: readonly string[];
  /** 形の合わない登録番号の生の文字列（`registration-number-missing` の文言に出す）。 */
  readonly rejectedRegistrationNumber?: string;
}

/** 文字列に含まれる数字の桁数（登録番号の桁数誤りを文言で見せる）。 */
export function digitCount(text: string): number {
  return (text.normalize('NFKC').match(/\d/gu) ?? []).length;
}

/**
 * 入力（手入力・CSV・読取）の事実を保存できる形にする。登録番号は仕訳の正規化を通し、形が合わなければ
 * **落として警告に残す**（400 にしない）。それ以外の形の不正は `validateReceiptFacts` が 400 で断る。
 */
export function sanitizeReceiptFacts(value: unknown, label = 'receipt facts'): SanitizedReceiptFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const raw = { ...(value as Record<string, unknown>) };
  const warnings: string[] = [];
  let rejectedRegistrationNumber: string | undefined;
  const registration = raw['registrationNumber'];
  if (typeof registration === 'string' && registration.trim() !== '') {
    const normalized = normalizeRegistrationNumber(registration);
    if (normalized === undefined) {
      rejectedRegistrationNumber = registration.trim();
      warnings.push(`登録番号「${rejectedRegistrationNumber}」は T + 数字 13 桁の形ではない（数字 ${digitCount(rejectedRegistrationNumber)} 桁）ため採用していません。領収書を見て入力し直してください。`);
      delete raw['registrationNumber'];
    } else {
      raw['registrationNumber'] = normalized;
    }
  }
  const facts = validateReceiptFacts(raw, label);
  return { facts, warnings, ...(rejectedRegistrationNumber === undefined ? {} : { rejectedRegistrationNumber }) };
}

/** 判定に使える金額（1 以上の整数）。0 円以下・欠落は undefined（`amount-missing`）。 */
export function usableAmount(facts: ReceiptFacts): number | undefined {
  return facts.amount !== undefined && facts.amount > 0 ? facts.amount : undefined;
}
