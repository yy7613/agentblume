/**
 * ドメイン: 判定の理由コードと重大度（docs/23 §4.5。完全な列挙）。
 *
 * 文言は UI 側（`src/ui/contract/contract-reasons.ts`）が持つ。ここはコードと重大度だけ:
 * - `onFail`: 基準に設定された negotiate / reject を使う。
 * - `unresolved`: 人の判断が要る（トピック判定を unresolved にする）。
 * - `warning`: overall を accept のままにしない。
 * - `info`: 判定に影響しない。
 */

export const REASON_CODES = [
  'clause-missing',
  'quote-not-found',
  'conflicting-clauses',
  'extraction-failed',
  'value-unparsed',
  'field-missing',
  'role-not-set',
  'unknown-topic',
  'criterion-failed',
  'llm-criterion-failed',
  'llm-unclear',
  'llm-evidence-missing',
  'llm-unavailable',
  'payment-over-limit',
  'payment-terms-indeterminate',
  'payment-basis-acceptance',
  'prohibited-payment-method',
  'counterparty-profile-missing',
  'deadline-mismatch',
  'notice-deadline-passed',
  'stamp-duty-candidate',
  'stamp-duty-amount-unknown',
  'review-stale',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type ReasonSeverity = 'onFail' | 'unresolved' | 'warning' | 'info';

export const REASON_SEVERITY: Readonly<Record<ReasonCode, ReasonSeverity>> = {
  'clause-missing': 'onFail',
  'quote-not-found': 'unresolved',
  'conflicting-clauses': 'unresolved',
  'extraction-failed': 'unresolved',
  'value-unparsed': 'unresolved',
  'field-missing': 'unresolved',
  'role-not-set': 'unresolved',
  'unknown-topic': 'unresolved',
  'criterion-failed': 'onFail',
  'llm-criterion-failed': 'onFail',
  'llm-unclear': 'unresolved',
  'llm-evidence-missing': 'unresolved',
  'llm-unavailable': 'unresolved',
  'payment-over-limit': 'onFail',
  'payment-terms-indeterminate': 'unresolved',
  'payment-basis-acceptance': 'warning',
  'prohibited-payment-method': 'onFail',
  'counterparty-profile-missing': 'unresolved',
  'deadline-mismatch': 'warning',
  'notice-deadline-passed': 'warning',
  'stamp-duty-candidate': 'info',
  'stamp-duty-amount-unknown': 'info',
  'review-stale': 'warning',
};

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

/** 理由の詳細（UI の文言に埋める値）。セルに入る単純な値だけを持つ。 */
export type ReasonDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface Reason {
  readonly code: ReasonCode;
  /** 基準に由来する理由ならその id（UI が「基準を開く」に使う）。 */
  readonly criterionId?: string;
  readonly topicId?: string;
  readonly detail?: ReasonDetail;
}
