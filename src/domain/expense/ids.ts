/**
 * ドメイン: 経費精算（expense）BC の識別子（ADR-0034 の Flavor パターン）。
 *
 * 素の string から代入できるが、互いの取り違え（申請 id を明細 id として渡す等）はコンパイル時に検出される。
 * 実行時表現は素の文字列のまま。
 */
import type { Flavor } from '../shared/brand';

/** 申請（ExpenseClaim）の識別子。 */
export type ExpenseClaimId = Flavor<string, 'ExpenseClaimId'>;
/** 明細（ExpenseItem）の識別子。申請の中で一意。 */
export type ExpenseItemId = Flavor<string, 'ExpenseItemId'>;
/** 証憑本体（ExpenseReceipt）の識別子。 */
export type ExpenseReceiptId = Flavor<string, 'ExpenseReceiptId'>;
/** 規程の費目（ExpenseCategory）の識別子。 */
export type ExpenseCategoryId = Flavor<string, 'ExpenseCategoryId'>;
/** 事前承認条件（PreApprovalRule）の識別子。 */
export type PreApprovalRuleId = Flavor<string, 'PreApprovalRuleId'>;

/* 実用化（docs/21 §20.2.1） ---------------------------------------------------- */

/** 従業員（ExpenseEmployee）の識別子。 */
export type ExpenseEmployeeId = Flavor<string, 'ExpenseEmployeeId'>;
/** 組織の部門の識別子。 */
export type ExpenseDepartmentId = Flavor<string, 'ExpenseDepartmentId'>;
/** 組織の承認グループの識別子。 */
export type ExpenseApproverGroupId = Flavor<string, 'ExpenseApproverGroupId'>;
/** 規程の承認経路の識別子。 */
export type ExpenseApprovalRouteId = Flavor<string, 'ExpenseApprovalRouteId'>;
/** 仮払（ExpenseAdvance）の識別子。 */
export type ExpenseAdvanceId = Flavor<string, 'ExpenseAdvanceId'>;
/** 法人カードの識別子。 */
export type ExpenseCardId = Flavor<string, 'ExpenseCardId'>;
/** カード明細の取込 1 回の識別子。 */
export type ExpenseCardImportId = Flavor<string, 'ExpenseCardImportId'>;
/** カード利用 1 行の識別子。 */
export type ExpenseCardTransactionId = Flavor<string, 'ExpenseCardTransactionId'>;
/** 振込バッチ（振込データ 1 本）の識別子。 */
export type ExpensePayoutBatchId = Flavor<string, 'ExpensePayoutBatchId'>;
/** 運賃マスタの経路の識別子。 */
export type ExpenseFareRouteId = Flavor<string, 'ExpenseFareRouteId'>;
/** 規程のヒアリング 1 回の識別子。 */
export type ExpensePolicyHearingId = Flavor<string, 'ExpensePolicyHearingId'>;
