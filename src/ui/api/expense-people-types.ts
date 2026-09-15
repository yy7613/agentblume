/**
 * 人と承認（docs/21 §20.9.2）の DTO。サーバーの応答（domain の型から tenant を除いた形）と同形。
 * 口座番号は応答に含まれない（`accountNumberLast4` だけ）。口座番号を送るのは登録・編集で「変更する」を押したときだけ。
 */
import type {
  ExpenseApprovalFlowDto, ExpenseApprovalPlanDto, ExpenseApprovalSettingsDto, ExpenseBlockingReasonDto, ExpenseClaimantDto, ExpenseClaimStatusDto,
} from './expense-types';

export type ExpenseBankAccountTypeDto = 'ordinary' | 'current' | 'savings' | 'other';

export interface ExpenseMaskedBankAccountDto {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: ExpenseBankAccountTypeDto;
  readonly accountNumberLast4: string;
  readonly holderKana: string;
  readonly changedAt: string;
  readonly changedBy: string;
}

export interface ExpenseCommuterPassDto {
  readonly id: string;
  readonly stations: readonly string[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly note?: string;
}

/** 振込データの点検 1 件（domain の `ExpensePayoutProblem`）。`message` は「原因。次の一手」、`field` は直す欄。 */
export interface ExpensePayoutProblemDto {
  readonly code: string;
  readonly employeeId?: string;
  readonly claimId?: string;
  readonly advanceId?: string;
  readonly field?: string;
  readonly message: string;
  readonly fixTarget: string;
  readonly params?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ExpenseEmployeePayoutReadinessDto {
  /** 止める理由（1 件でもあれば振込データに入れられない）。 */
  readonly problems: readonly ExpensePayoutProblemDto[];
  /** 確認必須の警告（名義カナの書式の変換・直近の口座変更）。 */
  readonly warnings: readonly ExpensePayoutProblemDto[];
  readonly holderKanaConverted?: string;
  readonly holderKanaBytes?: number;
}

export type ExpenseEmployeeHistoryTypeDto = 'created' | 'edited' | 'bank-account-changed' | 'disabled' | 'enabled';

export interface ExpenseEmployeeDto {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly nameKana?: string;
  readonly departmentId?: string;
  readonly managerEmployeeId?: string;
  readonly loginSubjects: readonly string[];
  readonly bankAccount?: ExpenseMaskedBankAccountDto;
  readonly commuterPasses: readonly ExpenseCommuterPassDto[];
  readonly enabled: boolean;
  readonly note?: string;
  readonly history: readonly { readonly type: ExpenseEmployeeHistoryTypeDto; readonly by: string; readonly at: string; readonly note?: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 部門名・上長名（表示用。サーバーが組織と従業員から引く）。 */
  readonly departmentName?: string;
  readonly managerName?: string;
  /** 振込データ（全銀協）に入れられるか（振込元の書式設定で判定）。 */
  readonly payoutReadiness: ExpenseEmployeePayoutReadinessDto;
}

export interface ExpenseBankAccountInputDto {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: ExpenseBankAccountTypeDto;
  /** 平文の口座番号（1〜7 桁）。省略・空は既存の口座番号を保つ。 */
  readonly accountNumber?: string;
  readonly holderKana: string;
}

export interface SaveExpenseEmployeeDto {
  readonly id?: string;
  readonly code?: string;
  readonly name: string;
  readonly nameKana?: string;
  readonly departmentId?: string;
  readonly managerEmployeeId?: string;
  readonly loginSubjects?: readonly string[];
  /** 省略は既存の口座を保つ、null は口座を外す。 */
  readonly bankAccount?: ExpenseBankAccountInputDto | null;
  readonly commuterPasses?: readonly ExpenseCommuterPassDto[];
  readonly enabled?: boolean;
  readonly note?: string;
}

export interface ExpenseEmployeeListFilterDto {
  /** 氏名・カナ・社員番号の部分一致。 */
  readonly query?: string;
  readonly departmentId?: string;
  readonly enabled?: boolean;
  readonly limit?: number;
}

export interface ImportExpenseEmployeesResultDto {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export interface ExpenseCsvFileDto {
  readonly content: string;
  readonly fileName: string;
}

export interface ExpenseDepartmentDto {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly parentId?: string;
  readonly headEmployeeId?: string;
  readonly journalDimensionValueId?: string;
  readonly enabled: boolean;
}

export interface ExpenseApproverGroupDto {
  readonly id: string;
  readonly name: string;
  readonly memberEmployeeIds: readonly string[];
  readonly enabled: boolean;
}

export interface ExpenseOrganizationDto {
  readonly departments: readonly ExpenseDepartmentDto[];
  readonly approverGroups: readonly ExpenseApproverGroupDto[];
  readonly updatedAt: string;
}

export interface ExpenseOrganizationResultDto {
  readonly organization: ExpenseOrganizationDto;
  /** false = まだ保存していない（空の組織）。 */
  readonly saved: boolean;
}

export type ExpenseEmployeeLinkMatchDto = 'exact-code' | 'unique-name' | 'ambiguous' | 'none';

export interface ExpenseEmployeeLinkDto {
  readonly claimId: string;
  readonly claimant: ExpenseClaimantDto;
  readonly status: ExpenseClaimStatusDto;
  readonly match: ExpenseEmployeeLinkMatchDto;
  readonly candidates: readonly { readonly id: string; readonly name: string; readonly code?: string; readonly department?: string }[];
}

export interface ConfirmExpenseEmployeeLinksResultDto {
  readonly linked: number;
  /** チェック済み・差し戻しから下書きへ戻った件数（再チェックが要る）。 */
  readonly movedToDraft: number;
  readonly skipped: readonly { readonly claimId: string; readonly reason: 'already-linked' }[];
}

export interface ExpenseApprovalFlowViewDto {
  /** checked は解決の予定、in-approval / 承認済みは保存済みの流れ、下書き・差し戻しはチェックした後の予定。 */
  readonly plan: ExpenseApprovalPlanDto;
  readonly flow?: ExpenseApprovalFlowDto;
  readonly current?: { readonly index: number; readonly stepId: string; readonly stepName: string; readonly approvers: readonly { readonly employeeId: string; readonly name: string }[] };
  /** 見ている人がいま承認を押せるか（代理はコメントを書けば押せる）。 */
  readonly canAct: boolean;
  /** 押すと代理承認になる（コメント必須）。 */
  readonly proxy: boolean;
  readonly blockers: readonly ExpenseBlockingReasonDto[];
}

export interface ExpenseApprovalRoutePreviewSubjectDto {
  readonly categoryIds: readonly string[];
  readonly totalAmount: number;
  readonly departmentId?: string;
  readonly claimantEmployeeId?: string;
}

export interface ExpenseApprovalRoutePreviewInputDto {
  /** 規程タブの下書きの承認設定（保存していなくてよい）。 */
  readonly approval: ExpenseApprovalSettingsDto;
  /** 下書きの費目 id（経路の条件に使える費目）。 */
  readonly policyCategoryIds: readonly string[];
  readonly subject: ExpenseApprovalRoutePreviewSubjectDto;
}

export interface ExpenseApprovalRoutePreviewDto {
  readonly plan: ExpenseApprovalPlanDto;
  readonly firstStepId?: string;
}

export interface ExpenseMeDto {
  readonly subject: string;
  readonly displayName?: string;
  readonly singleUser: boolean;
  readonly canApprove: boolean;
  readonly employee?: { readonly id: string; readonly name: string; readonly departmentId?: string };
}

export interface ExpensePeopleReadinessDto {
  readonly employees: { readonly configured: boolean; readonly enabledCount: number };
  readonly organization: { readonly saved: boolean; readonly departmentCount: number; readonly approverGroupCount: number };
  readonly payout: { readonly configured: boolean; readonly saved: boolean };
}
