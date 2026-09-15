/**
 * ドメイン: 規程チェックの理由コードとカタログ（docs/21 §4 / §20.4 / ADR-0040 §1 / ADR-0043 §2）。
 *
 * **理由コードの集合はコードに持ち、重さと数値はデータに持つ**。どんな違反を検出できるかは実装が約束する契約で、
 * 会社ごとに変わるのは「その違反をどれくらい重く見るか」（規程の `severityOverrides`）と閾値だから。
 * 利用者向けの文言は画面（`ui/expense/expense-model.ts`）と申請者・ツール向け（`application/expense/reason-messages.ts`）にあり、
 * どちらも全コードを網羅することをテストで固定する。
 *
 * 並びは評価順（§20.3.2）。画面は根本の原因から見せるので、判定結果の理由もこの順に並ぶ。
 * 実用化の 16 コードは既存 27 コードの相対順を変えずに挿入した（系統の contributor が出す。`check-contributors.ts`）。
 * 系統ごとに動的に登録しないのは、網羅テストと `severityOverrides` の検証を登録順に依存させないため（ADR-0043 代替案）。
 */

export const REASON_CODES = [
  // 0. 申請の前提（A / B の contributor が 7 件目までを出す）
  'policy-unreviewed',
  'claimant-unlinked', 'claimant-employee-disabled',
  'advance-employee-mismatch', 'advance-not-paid', 'advance-already-settled',
  'approval-route-unresolved',
  'claim-empty',
  // 1. 費目
  'category-missing', 'category-unknown',
  // 2. 必須項目
  'amount-missing', 'date-missing', 'payee-missing', 'purpose-missing',
  // 3. 証憑・読取（C）
  'receipt-missing', 'receipt-extraction-warning', 'receipt-amount-mismatch',
  'date-substituted-by-issue-date', 'receipt-reads-disagree', 'read-values-unconfirmed',
  // 4. 日付
  'date-in-future', 'date-outside-period', 'submission-late',
  // 5. 支払方法・インボイス
  'payment-not-reimbursable', 'registration-number-missing',
  // 5a. 交通費（C）
  'route-missing', 'commuter-pass-overlap', 'commuter-pass-partial-overlap', 'fare-exceeds-table', 'fare-route-unknown',
  // 6. 規程の上限
  'per-item-limit-exceeded', 'attendees-missing', 'per-person-limit-exceeded', 'attendee-details-missing', 'unit-count-missing', 'per-unit-limit-exceeded',
  // 7. 事前承認
  'pre-approval-missing',
  // 8. 重複・カード（B）
  'duplicate-in-claim', 'duplicate-across-claims', 'duplicate-receipt-image',
  'card-charge-claimed', 'corporate-payment-unmatched',
  // 9. 申請の集計
  'per-claim-limit-exceeded',
] as const;
export type ExpenseReasonCode = (typeof REASON_CODES)[number];

/** MVP（§4）の 27 コード。実用化の差分と区別するテスト・文書の基準。 */
export const MVP_REASON_CODES = [
  'policy-unreviewed', 'claim-empty',
  'category-missing', 'category-unknown',
  'amount-missing', 'date-missing', 'payee-missing', 'purpose-missing',
  'receipt-missing', 'receipt-extraction-warning', 'receipt-amount-mismatch',
  'date-in-future', 'date-outside-period', 'submission-late',
  'payment-not-reimbursable', 'registration-number-missing',
  'per-item-limit-exceeded', 'attendees-missing', 'per-person-limit-exceeded', 'attendee-details-missing', 'unit-count-missing', 'per-unit-limit-exceeded',
  'pre-approval-missing',
  'duplicate-in-claim', 'duplicate-across-claims', 'duplicate-receipt-image',
  'per-claim-limit-exceeded',
] as const satisfies readonly ExpenseReasonCode[];

/** 系統ごとに出してよいコード（§20.4。contributor の `codes` はこれと一致させる）。 */
export const PEOPLE_REASON_CODES = ['claimant-unlinked', 'claimant-employee-disabled', 'approval-route-unresolved'] as const satisfies readonly ExpenseReasonCode[];
export const MONEY_REASON_CODES = ['advance-employee-mismatch', 'advance-not-paid', 'advance-already-settled', 'card-charge-claimed', 'corporate-payment-unmatched'] as const satisfies readonly ExpenseReasonCode[];
export const INPUT_REASON_CODES = [
  'date-substituted-by-issue-date', 'receipt-reads-disagree', 'read-values-unconfirmed',
  'route-missing', 'commuter-pass-overlap', 'commuter-pass-partial-overlap', 'fare-exceeds-table', 'fare-route-unknown',
] as const satisfies readonly ExpenseReasonCode[];

export type Severity = 'review' | 'return';
/** 規程で選べる重さ。`off` はその理由を出さない。 */
export type SeverityOverride = Severity | 'off';
export const SEVERITY_OVERRIDES = ['review', 'return', 'off'] as const;

/** 電帳法の検索要件のどれに当たるか。 */
export type SearchKey = 'date' | 'amount' | 'payee';

/** 直し方のボタンが開く場所（docs/21 §4 / §20.4 の導線先）。 */
export type ExpenseFixTarget =
  | 'item' | 'item-category' | 'receipt' | 'policy-category' | 'policy-rules' | 'policy-pre-approval' | 'policy-save' | 'other-claim'
  | 'claim-claimant' | 'claim-advance' | 'item-route' | 'employee' | 'employee-commuter' | 'organization' | 'policy-approval'
  | 'advance' | 'card-transaction' | 'card-transactions' | 'fare-table';

export const EXPENSE_FIX_TARGETS = [
  'item', 'item-category', 'receipt', 'policy-category', 'policy-rules', 'policy-pre-approval', 'policy-save', 'other-claim',
  'claim-claimant', 'claim-advance', 'item-route', 'employee', 'employee-commuter', 'organization', 'policy-approval',
  'advance', 'card-transaction', 'card-transactions', 'fare-table',
] as const satisfies readonly ExpenseFixTarget[];

export interface ReasonCatalogEntry {
  /** 明細の理由か申請の理由か。 */
  readonly target: 'item' | 'claim';
  readonly defaultSeverity: Severity;
  /** 規程で選べる値（空 = 変更不可）。 */
  readonly adjustable: readonly SeverityOverride[];
  readonly searchKey?: SearchKey;
  readonly fixTargets: readonly ExpenseFixTarget[];
  /** 差し戻し文言の既定形に含めるか（経理側の問題は含めない）。 */
  readonly applicantFacing: boolean;
}

const RR: readonly SeverityOverride[] = ['review', 'return'];
const ORR: readonly SeverityOverride[] = ['off', 'review', 'return'];
const FIXED: readonly SeverityOverride[] = [];

export const REASON_CATALOG: Readonly<Record<ExpenseReasonCode, ReasonCatalogEntry>> = {
  'policy-unreviewed': { target: 'claim', defaultSeverity: 'review', adjustable: ['review', 'off'], fixTargets: ['policy-save'], applicantFacing: false },
  'claimant-unlinked': { target: 'claim', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['claim-claimant', 'employee'], applicantFacing: false },
  'claimant-employee-disabled': { target: 'claim', defaultSeverity: 'review', adjustable: RR, fixTargets: ['employee', 'claim-claimant'], applicantFacing: false },
  'advance-employee-mismatch': { target: 'claim', defaultSeverity: 'return', adjustable: FIXED, fixTargets: ['claim-advance', 'advance'], applicantFacing: false },
  'advance-not-paid': { target: 'claim', defaultSeverity: 'review', adjustable: RR, fixTargets: ['advance', 'claim-advance'], applicantFacing: false },
  'advance-already-settled': { target: 'claim', defaultSeverity: 'return', adjustable: FIXED, fixTargets: ['claim-advance'], applicantFacing: false },
  'approval-route-unresolved': { target: 'claim', defaultSeverity: 'review', adjustable: FIXED, fixTargets: ['employee', 'organization', 'policy-approval'], applicantFacing: false },
  'claim-empty': { target: 'claim', defaultSeverity: 'return', adjustable: FIXED, fixTargets: ['item'], applicantFacing: true },
  'category-missing': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item-category', 'policy-category'], applicantFacing: true },
  'category-unknown': { target: 'item', defaultSeverity: 'return', adjustable: FIXED, fixTargets: ['item-category', 'policy-category'], applicantFacing: false },
  'amount-missing': { target: 'item', defaultSeverity: 'return', adjustable: FIXED, searchKey: 'amount', fixTargets: ['item', 'receipt'], applicantFacing: true },
  'date-missing': { target: 'item', defaultSeverity: 'return', adjustable: FIXED, searchKey: 'date', fixTargets: ['item', 'receipt'], applicantFacing: true },
  'payee-missing': { target: 'item', defaultSeverity: 'review', adjustable: RR, searchKey: 'payee', fixTargets: ['item', 'receipt'], applicantFacing: true },
  'purpose-missing': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item'], applicantFacing: true },
  'receipt-missing': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item', 'policy-category'], applicantFacing: true },
  'receipt-extraction-warning': { target: 'item', defaultSeverity: 'review', adjustable: FIXED, fixTargets: ['receipt'], applicantFacing: false },
  'receipt-amount-mismatch': { target: 'item', defaultSeverity: 'review', adjustable: RR, fixTargets: ['receipt'], applicantFacing: true },
  'date-substituted-by-issue-date': { target: 'item', defaultSeverity: 'review', adjustable: FIXED, fixTargets: ['receipt', 'item'], applicantFacing: false },
  'receipt-reads-disagree': { target: 'item', defaultSeverity: 'review', adjustable: RR, fixTargets: ['receipt'], applicantFacing: false },
  'read-values-unconfirmed': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item', 'receipt'], applicantFacing: false },
  'date-in-future': { target: 'item', defaultSeverity: 'return', adjustable: FIXED, fixTargets: ['item'], applicantFacing: true },
  'date-outside-period': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item'], applicantFacing: true },
  'submission-late': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['policy-rules'], applicantFacing: true },
  'payment-not-reimbursable': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item', 'policy-rules'], applicantFacing: true },
  'registration-number-missing': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item', 'receipt', 'policy-category'], applicantFacing: true },
  'route-missing': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item-route'], applicantFacing: true },
  'commuter-pass-overlap': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item-route', 'employee-commuter'], applicantFacing: true },
  'commuter-pass-partial-overlap': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item', 'employee-commuter', 'fare-table'], applicantFacing: true },
  'fare-exceeds-table': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item-route', 'fare-table'], applicantFacing: true },
  'fare-route-unknown': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['fare-table'], applicantFacing: false },
  'per-item-limit-exceeded': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['policy-category'], applicantFacing: true },
  'attendees-missing': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item'], applicantFacing: true },
  'per-person-limit-exceeded': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item', 'item-category', 'policy-category'], applicantFacing: true },
  'attendee-details-missing': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['item'], applicantFacing: true },
  'unit-count-missing': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item'], applicantFacing: true },
  'per-unit-limit-exceeded': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item', 'policy-category'], applicantFacing: true },
  'pre-approval-missing': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item', 'policy-pre-approval'], applicantFacing: true },
  'duplicate-in-claim': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['item'], applicantFacing: true },
  'duplicate-across-claims': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['other-claim'], applicantFacing: true },
  'duplicate-receipt-image': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['other-claim', 'receipt'], applicantFacing: true },
  'card-charge-claimed': { target: 'item', defaultSeverity: 'return', adjustable: RR, fixTargets: ['card-transaction', 'item'], applicantFacing: true },
  'corporate-payment-unmatched': { target: 'item', defaultSeverity: 'review', adjustable: ORR, fixTargets: ['card-transactions', 'item'], applicantFacing: true },
  'per-claim-limit-exceeded': { target: 'claim', defaultSeverity: 'return', adjustable: RR, fixTargets: ['policy-category'], applicantFacing: true },
};

export function isReasonCode(value: unknown): value is ExpenseReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

/** 評価順の位置（安定ソートの鍵）。未知のコードは末尾。 */
export function reasonOrder(code: string): number {
  const index = (REASON_CODES as readonly string[]).indexOf(code);
  return index < 0 ? REASON_CODES.length : index;
}

/** 規程の上書きを反映した重さ。`off` なら undefined（理由を出さない）。変更不可のコードは上書きを無視する。 */
export function severityFor(code: ExpenseReasonCode, overrides: Readonly<Partial<Record<string, SeverityOverride>>>): Severity | undefined {
  const entry = REASON_CATALOG[code];
  const override = overrides[code];
  if (override === undefined || !entry.adjustable.includes(override)) return entry.defaultSeverity;
  return override === 'off' ? undefined : override;
}
