/**
 * ドメイン: 判定結果の型（docs/21 §3.3）。
 *
 * `check.ts`（判定する側）と `claim.ts`（保存する側）の両方が使うので、循環しないよう葉に置く。
 */
import type { ErrorFactory } from '../shared/errors';
import { assertIsoDateTime } from '../shared/time';
import { isReasonCode, type ExpenseReasonCode, type SearchKey, type Severity } from './reason-codes';

export type Verdict = 'pass' | 'needs-review' | 'returned';
export const VERDICTS = ['pass', 'needs-review', 'returned'] as const;

export type ReasonParamValue = string | number | boolean | null;

export interface CheckReason {
  readonly code: ExpenseReasonCode;
  /** 規程の `severityOverrides` を反映済み。 */
  readonly severity: Severity;
  /** 申請単位の理由は undefined。 */
  readonly itemId?: string;
  /** 文言の差し込み値。 */
  readonly params: Readonly<Record<string, ReasonParamValue>>;
  readonly searchKey?: SearchKey;
}

export interface ItemCheck {
  readonly itemId: string;
  readonly verdict: Verdict;
  readonly reasons: readonly CheckReason[];
}

export interface ClaimJudgment {
  readonly verdict: Verdict;
  readonly items: readonly ItemCheck[];
  readonly claimReasons: readonly CheckReason[];
  readonly totals: { readonly amount: number; readonly byCategory: readonly { readonly categoryId: string; readonly amount: number }[] };
  /** 全明細で取引年月日・取引金額・取引先が揃っているか（電帳法の検索要件）。明細が無ければ false。 */
  readonly searchKeysComplete: boolean;
}

/** 申請へ保存する形。古さの検出に使う指紋と時刻を足す。 */
export type StoredClaimJudgment = ClaimJudgment & {
  readonly policyUpdatedAt: string;
  readonly itemsFingerprint: string;
  readonly checkedAt: string;
};

/** 理由の並びから判定（理由なし = 通過、review だけ = 要確認、return が 1 件でもあれば差し戻し）。 */
export function verdictOf(reasons: readonly Pick<CheckReason, 'severity'>[]): Verdict {
  if (reasons.some((reason) => reason.severity === 'return')) return 'returned';
  return reasons.length > 0 ? 'needs-review' : 'pass';
}

/** 判定に含まれる全理由（申請の理由 → 明細順）。 */
export function allReasons(judgment: Pick<ClaimJudgment, 'items' | 'claimReasons'>): readonly CheckReason[] {
  return [...judgment.claimReasons, ...judgment.items.flatMap((item) => item.reasons)];
}

/** 確認済みと理由を突き合わせる鍵（同じ明細の同じコードは 1 件として扱う）。 */
export function reasonKey(code: string, itemId: string | undefined): string {
  return `${itemId ?? ''}\u0000${code}`;
}

function validateReason(value: unknown, label: string, fail: ErrorFactory): CheckReason {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (!isReasonCode(raw['code'])) throw fail(`${label}.code must be a reason code`);
  if (raw['severity'] !== 'review' && raw['severity'] !== 'return') throw fail(`${label}.severity must be review or return`);
  if (raw['itemId'] !== undefined && typeof raw['itemId'] !== 'string') throw fail(`${label}.itemId must be a string`);
  const params = raw['params'];
  if (params === null || typeof params !== 'object' || Array.isArray(params)
    || Object.values(params as Record<string, unknown>).some((entry) => entry !== null && !['string', 'number', 'boolean'].includes(typeof entry))) {
    throw fail(`${label}.params must be an object of primitive values`);
  }
  const searchKey = raw['searchKey'];
  if (searchKey !== undefined && searchKey !== 'date' && searchKey !== 'amount' && searchKey !== 'payee') throw fail(`${label}.searchKey must be date, amount or payee`);
  return {
    code: raw['code'],
    severity: raw['severity'],
    ...(raw['itemId'] === undefined ? {} : { itemId: raw['itemId'] as string }),
    params: { ...(params as Record<string, string | number | boolean | null>) },
    ...(searchKey === undefined ? {} : { searchKey: searchKey as SearchKey }),
  };
}

/** 保存済みの判定の形を検証して複製する（申請の復元で通す）。 */
export function validateStoredJudgment(value: unknown, label: string, fail: ErrorFactory): StoredClaimJudgment {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (!(VERDICTS as readonly unknown[]).includes(raw['verdict'])) throw fail(`${label}.verdict must be one of ${VERDICTS.join(', ')}`);
  if (!Array.isArray(raw['items'])) throw fail(`${label}.items must be an array`);
  if (!Array.isArray(raw['claimReasons'])) throw fail(`${label}.claimReasons must be an array`);
  const items = raw['items'].map((item: unknown, index) => {
    const itemLabel = `${label}.items[${index}]`;
    if (item === null || typeof item !== 'object') throw fail(`${itemLabel} must be an object`);
    const entry = item as Record<string, unknown>;
    if (typeof entry['itemId'] !== 'string') throw fail(`${itemLabel}.itemId must be a string`);
    if (!(VERDICTS as readonly unknown[]).includes(entry['verdict'])) throw fail(`${itemLabel}.verdict must be one of ${VERDICTS.join(', ')}`);
    if (!Array.isArray(entry['reasons'])) throw fail(`${itemLabel}.reasons must be an array`);
    return { itemId: entry['itemId'], verdict: entry['verdict'] as Verdict, reasons: entry['reasons'].map((reason: unknown, position) => validateReason(reason, `${itemLabel}.reasons[${position}]`, fail)) };
  });
  const totals = raw['totals'] as { amount?: unknown; byCategory?: unknown } | undefined;
  if (totals === null || typeof totals !== 'object' || typeof totals.amount !== 'number' || !Array.isArray(totals.byCategory)) throw fail(`${label}.totals must be { amount, byCategory }`);
  const byCategory = totals.byCategory.map((entry: unknown, index) => {
    const item = entry as { categoryId?: unknown; amount?: unknown } | null;
    if (item === null || typeof item !== 'object' || typeof item.categoryId !== 'string' || typeof item.amount !== 'number') throw fail(`${label}.totals.byCategory[${index}] must be { categoryId, amount }`);
    return { categoryId: item.categoryId, amount: item.amount };
  });
  if (typeof raw['searchKeysComplete'] !== 'boolean') throw fail(`${label}.searchKeysComplete must be a boolean`);
  assertIsoDateTime(raw['policyUpdatedAt'], `${label}.policyUpdatedAt`, fail);
  assertIsoDateTime(raw['checkedAt'], `${label}.checkedAt`, fail);
  if (typeof raw['itemsFingerprint'] !== 'string' || raw['itemsFingerprint'] === '') throw fail(`${label}.itemsFingerprint must be a non-empty string`);
  return {
    verdict: raw['verdict'] as Verdict,
    items,
    claimReasons: raw['claimReasons'].map((reason: unknown, index) => validateReason(reason, `${label}.claimReasons[${index}]`, fail)),
    totals: { amount: totals.amount, byCategory },
    searchKeysComplete: raw['searchKeysComplete'],
    policyUpdatedAt: raw['policyUpdatedAt'],
    itemsFingerprint: raw['itemsFingerprint'],
    checkedAt: raw['checkedAt'],
  };
}
