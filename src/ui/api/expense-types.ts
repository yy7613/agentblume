/**
 * ui/api層: 経費精算（docs/21-expense.md §10 / §20.9）の DTO。
 *
 * サーバーの domain 型と同形（テナントスコープ `tenant` を除く）。UI は backend の内部レイヤを import しないので、
 * 列挙はここに書き写し、テスト（`expense-model.test.ts`）が domain の正準値と突き合わせて食い違いを検出する。
 * 系統（人と承認 / お金の流れ / 入力と規程）の新しいルートの DTO は `expense-<people|money|input>-types.ts` に置き、
 * ここは既存ルートの応答に足した項目だけを持つ（§20.9.1）。
 */

export const EXPENSE_REASON_CODES = [
  // 0. 申請の前提
  'policy-unreviewed',
  'claimant-unlinked', 'claimant-employee-disabled',
  'advance-employee-mismatch', 'advance-not-paid', 'advance-already-settled',
  'approval-route-unresolved',
  'claim-empty',
  // 1. 費目
  'category-missing', 'category-unknown',
  // 2. 必須項目
  'amount-missing', 'date-missing', 'payee-missing', 'purpose-missing',
  // 3. 証憑・読取
  'receipt-missing', 'receipt-extraction-warning', 'receipt-amount-mismatch',
  'date-substituted-by-issue-date', 'receipt-reads-disagree', 'read-values-unconfirmed',
  // 4. 日付
  'date-in-future', 'date-outside-period', 'submission-late',
  // 5. 支払方法・インボイス
  'payment-not-reimbursable', 'registration-number-missing',
  // 5a. 交通費
  'route-missing', 'commuter-pass-overlap', 'commuter-pass-partial-overlap', 'fare-exceeds-table', 'fare-route-unknown',
  // 6. 規程の上限
  'per-item-limit-exceeded', 'attendees-missing', 'per-person-limit-exceeded', 'attendee-details-missing', 'unit-count-missing', 'per-unit-limit-exceeded',
  // 7. 事前承認
  'pre-approval-missing',
  // 8. 重複・カード
  'duplicate-in-claim', 'duplicate-across-claims', 'duplicate-receipt-image',
  'card-charge-claimed', 'corporate-payment-unmatched',
  // 9. 申請の集計
  'per-claim-limit-exceeded',
] as const;
export type ExpenseReasonCodeDto = (typeof EXPENSE_REASON_CODES)[number];

export type ExpenseSeverityDto = 'review' | 'return';
export type ExpenseSeverityOverrideDto = ExpenseSeverityDto | 'off';
export type ExpenseVerdictDto = 'pass' | 'needs-review' | 'returned';
export const EXPENSE_CLAIM_STATUSES = ['draft', 'checked', 'in-approval', 'returned', 'approved', 'settled'] as const;
export type ExpenseClaimStatusDto = (typeof EXPENSE_CLAIM_STATUSES)[number];
export type ExpenseTaxRateDto = 10 | 8 | 0;
export type ExpensePaymentMethodDto = 'cash' | 'credit_card' | 'bank_transfer' | 'qr' | 'e_money' | 'direct_debit' | 'unknown';
export type ExpenseFixTargetDto =
  | 'item' | 'item-category' | 'receipt' | 'policy-category' | 'policy-rules' | 'policy-pre-approval' | 'policy-save' | 'other-claim'
  | 'claim-claimant' | 'claim-advance' | 'item-route' | 'employee' | 'employee-commuter' | 'organization' | 'policy-approval'
  | 'advance' | 'card-transaction' | 'card-transactions' | 'fare-table';
export type ExpenseFareTypeDto = 'ic' | 'ticket';

/* 規程 --------------------------------------------------------------------- */

export interface ExpenseRequirementDto { readonly required: boolean; readonly exemptBelow?: number }

/** 費目の交通費の検査（§20.2.2）。省略 = 区間の記入も照合もしない。 */
export interface ExpenseCategoryRouteDto { readonly required: boolean; readonly commuterPass: boolean; readonly fareTable: boolean }

export interface ExpenseCategoryDto {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
  readonly aliases: readonly string[];
  readonly accountId?: string;
  readonly defaultTaxRate: ExpenseTaxRateDto;
  readonly taxCodeByRate: { readonly '10'?: string; readonly '8'?: string; readonly '0'?: string };
  readonly receipt: ExpenseRequirementDto;
  readonly invoice: ExpenseRequirementDto;
  readonly requires: { readonly purpose: boolean; readonly attendees: boolean; readonly attendeeDetails: boolean };
  readonly limits: {
    readonly perItem?: number;
    readonly perClaim?: number;
    readonly perPerson?: number;
    readonly perPersonBasis: 'tax-included' | 'tax-excluded';
    readonly perUnit?: { readonly label: string; readonly amount: number };
  };
  readonly note?: string;
  readonly route?: ExpenseCategoryRouteDto;
}

export interface ExpensePreApprovalRuleDto {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly categoryIds: readonly string[];
  readonly minAmount?: number;
  readonly minPerPerson?: number;
  readonly note?: string;
}

export interface ExpenseClaimRulesDto {
  readonly submissionDeadlineDays?: number;
  readonly nonReimbursablePaymentMethods: readonly ExpensePaymentMethodDto[];
  readonly attendeesIncludeClaimant: boolean;
  readonly forbidSelfApproval: boolean;
}

export interface ExpenseJournalSettingsDto {
  readonly creditAccountId: string;
  readonly creditTaxCode: string;
  readonly partnerFrom: 'claimant' | 'payee';
  readonly descriptionTemplate: string;
  /** 仕訳の補助軸 id（部門）。 */
  readonly departmentDimensionId?: string;
}

/* 承認経路（domain/expense/approval.ts と同形） */

export type ExpenseApproverKindDto = 'claimant-manager' | 'department-head' | 'employee' | 'group' | 'any-approver';

export type ExpenseApproverSpecDto =
  | { readonly kind: 'claimant-manager' }
  | { readonly kind: 'department-head'; readonly departmentId?: string }
  | { readonly kind: 'employee'; readonly employeeId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'any-approver' };

export interface ExpenseApprovalStepDefDto { readonly id: string; readonly name: string; readonly approver: ExpenseApproverSpecDto; readonly skipWhenSameAsPrevious: boolean }

export interface ExpenseApprovalRouteDto {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly when: { readonly categoryIds: readonly string[]; readonly minClaimAmount?: number; readonly departmentIds: readonly string[] };
  readonly steps: readonly ExpenseApprovalStepDefDto[];
}

export interface ExpenseApprovalSettingsDto {
  readonly routes: readonly ExpenseApprovalRouteDto[];
  readonly defaultSteps: readonly ExpenseApprovalStepDefDto[];
  readonly forbidClaimantApproval: boolean;
  readonly requireDistinctApprovers: boolean;
  readonly proxyGroupId?: string;
}

export interface ExpenseTransportSettingsDto { readonly commuterPassDeduction: boolean; readonly fareToleranceYen: number; readonly defaultFareType: ExpenseFareTypeDto }

export interface ExpenseCardPolicySettingsDto {
  readonly acceptCorporatePaymentItems: boolean;
  readonly dateToleranceDays: number;
  readonly amountToleranceYen: number;
  readonly weakMatchMinAmount: number;
  readonly creditAccountId: string;
  readonly creditTaxCode: string;
}

export interface ExpenseAdvancePolicySettingsDto { readonly advanceAccountId: string; readonly paymentAccountId: string; readonly refundAccountId: string; readonly settleWithinDays?: number }

export interface SaveExpensePolicyDto {
  readonly categories: readonly ExpenseCategoryDto[];
  readonly claimRules: ExpenseClaimRulesDto;
  readonly preApprovalRules: readonly ExpensePreApprovalRuleDto[];
  readonly severityOverrides: Readonly<Partial<Record<ExpenseReasonCodeDto, ExpenseSeverityOverrideDto>>>;
  readonly journal: ExpenseJournalSettingsDto;
  /*
   * 実用化の節（§20.2.2）。サーバーの応答には常にあるが、保存本文で省略するとサーバーは既定値で補う（= 系統の設定が消える）。
   * 型を任意にしているのは、省略の意味（既定値に戻る）を画面が意識して `policyBody` で必ず引き継ぐため。
   */
  readonly approval?: ExpenseApprovalSettingsDto;
  readonly transport?: ExpenseTransportSettingsDto;
  readonly card?: ExpenseCardPolicySettingsDto;
  readonly advance?: ExpenseAdvancePolicySettingsDto;
}

export interface ExpensePolicyDto extends SaveExpensePolicyDto {
  readonly updatedAt: string;
}

export interface ExpensePolicyResultDto {
  readonly policy: ExpensePolicyDto;
  /** 利用者が保存したものか（false = 初期テンプレートのまま）。 */
  readonly saved: boolean;
}

/* 判定 --------------------------------------------------------------------- */

export type ExpenseParamValueDto = string | number | boolean | null;

export interface ExpenseCheckReasonDto {
  readonly code: ExpenseReasonCodeDto;
  readonly severity: ExpenseSeverityDto;
  readonly itemId?: string;
  readonly params: Readonly<Record<string, ExpenseParamValueDto>>;
  readonly searchKey?: 'date' | 'amount' | 'payee';
}

export interface ExpenseItemCheckDto {
  readonly itemId: string;
  readonly verdict: ExpenseVerdictDto;
  readonly reasons: readonly ExpenseCheckReasonDto[];
}

export interface ExpenseJudgmentDto {
  readonly verdict: ExpenseVerdictDto;
  readonly items: readonly ExpenseItemCheckDto[];
  readonly claimReasons: readonly ExpenseCheckReasonDto[];
  readonly totals: { readonly amount: number; readonly byCategory: readonly { readonly categoryId: string; readonly amount: number }[] };
  readonly searchKeysComplete: boolean;
  readonly policyUpdatedAt: string;
  readonly itemsFingerprint: string;
  readonly checkedAt: string;
}

/* 申請 --------------------------------------------------------------------- */

export interface ExpenseTotalsByRateDto { readonly rate: ExpenseTaxRateDto; readonly taxableAmount: number; readonly taxAmount?: number; readonly amountIncludesTax: boolean }

/** 明細の区間（§20.2.4）。駅は乗った順（2〜30 駅）。 */
export interface ExpenseReceiptRouteDto { readonly stations: readonly string[]; readonly trips: number; readonly fareType?: ExpenseFareTypeDto }

export interface ExpenseReceiptFactsDto {
  readonly transactionDate?: string;
  readonly issueDate?: string;
  readonly payeeName?: string;
  readonly registrationNumber?: string;
  readonly amount?: number;
  readonly totalsByRate?: readonly ExpenseTotalsByRateDto[];
  readonly paymentMethod?: ExpensePaymentMethodDto;
  readonly corporatePayment?: boolean;
  readonly description?: string;
  readonly purpose?: string;
  readonly attendees?: { readonly count?: number; readonly names?: readonly string[]; readonly relation?: string };
  readonly unitCount?: number;
  readonly preApprovalRef?: string;
  readonly dateSource?: 'read' | 'manual' | 'issue-copied';
  readonly route?: ExpenseReceiptRouteDto;
}

export interface ExpenseItemSourceDto { readonly type: 'image' | 'pdf' | 'manual' | 'csv-row'; readonly fileName?: string; readonly row?: Readonly<Record<string, string>> }

export type ExpenseExtractionFlagDto =
  | 'transaction-date-substituted' | 'registration-number-rejected' | 'payee-from-report' | 'reads-disagree'
  | 'attendees-read' | 'purpose-read' | 'route-read' | 'payee-read' | 'detail-read-failed';

/** 経費専用の追加読取の記録（domain/expense/detail-read.ts の `ExpenseDetailRecord`）。 */
export interface ExpenseDetailRecordDto {
  readonly promptVersion: string;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly readAt: string;
  readonly raw: {
    readonly registrationNumberText: string | null;
    readonly payeeNameText: string | null;
    readonly transactionDateText: string | null;
    readonly issueDateText: string | null;
    readonly attendees: { readonly countText: string | null; readonly names: readonly string[] };
    readonly purposeClues: readonly string[];
    readonly route: { readonly from: string | null; readonly to: string | null; readonly via: readonly string[]; readonly fareType: ExpenseFareTypeDto | null };
    readonly notes: readonly string[];
  };
  readonly disagreements: readonly { readonly field: 'registrationNumber' | 'transactionDate' | 'issueDate' | 'payeeName'; readonly journalValue: string | null; readonly detailValue: string | null }[];
}

export interface ExpenseItemExtractionDto {
  readonly method: 'llm' | 'manual' | 'csv';
  readonly model?: { readonly provider: string; readonly model: string };
  readonly confidence?: number;
  readonly warnings: readonly string[];
  readonly documentKind?: string;
  readonly rejectedRegistrationNumber?: string;
  /** 構造化した読取の印。人がその欄を直して保存したら、画面が対応する印を外して送る。 */
  readonly flags?: readonly ExpenseExtractionFlagDto[];
  readonly detail?: ExpenseDetailRecordDto;
}

export interface ExpenseItemDto {
  readonly id: string;
  readonly categoryId?: string;
  readonly categoryText?: string;
  readonly facts: ExpenseReceiptFactsDto;
  readonly receiptId?: string;
  readonly hasReceipt: boolean;
  readonly source: ExpenseItemSourceDto;
  readonly extraction: ExpenseItemExtractionDto;
  readonly addedOn?: string;
}

export interface ExpenseClaimantDto {
  readonly name: string;
  readonly employeeCode?: string;
  readonly department?: string;
  /** 従業員マスタの紐付け。保存本文で指定するとサーバーが氏名・社員番号・部門の写しを埋める。 */
  readonly employeeId?: string;
  readonly departmentId?: string;
}
export interface ExpensePeriodDto { readonly from: string; readonly to: string }

/** 遷移を妨げる理由（理由コードか、`judgment-missing` / `judgment-stale` / `self-approval` / §20.5.1 の承認の擬似コード）。 */
export interface ExpenseBlockingReasonDto {
  readonly code: string;
  readonly itemId?: string;
  /** 擬似コードの文言の差し込み値（stepName / approvers / subject / previousStep など）。 */
  readonly params?: Readonly<Record<string, ExpenseParamValueDto>>;
}

export interface ExpenseApprovalApproverDto { readonly employeeId: string; readonly name: string }

/** 承認計画（domain の `ApprovalPlan`。checked なら解決の予定、in-approval なら保存済みの流れから作る）。 */
export interface ExpenseApprovalPlanDto {
  readonly routeId?: string;
  readonly routeName: string;
  readonly steps: readonly { readonly stepId: string; readonly name: string; readonly approverKind: ExpenseApproverKindDto; readonly approvers: readonly ExpenseApprovalApproverDto[]; readonly skipped: boolean }[];
  readonly unresolved: readonly { readonly stepId: string; readonly stepName: string; readonly cause: string; readonly params: Readonly<Record<string, string | null>> }[];
}

/** 承認の記録（domain の `ApprovalFlow`）。 */
export interface ExpenseApprovalFlowDto {
  readonly routeId?: string;
  readonly routeName: string;
  readonly resolvedAt: string;
  readonly policyUpdatedAt: string;
  readonly steps: readonly {
    readonly stepId: string;
    readonly name: string;
    readonly approverKind: ExpenseApproverKindDto;
    readonly approvers: readonly ExpenseApprovalApproverDto[];
    readonly status: 'pending' | 'approved' | 'skipped';
    readonly decision?: { readonly by: string; readonly employeeId?: string; readonly displayName?: string; readonly at: string; readonly comment?: string; readonly proxy: boolean };
  }[];
  readonly currentIndex: number;
}

export interface ExpenseClaimDto {
  readonly id: string;
  readonly claimant: ExpenseClaimantDto;
  readonly period: ExpensePeriodDto;
  readonly title?: string;
  readonly advanceId?: string;
  readonly items: readonly ExpenseItemDto[];
  readonly status: ExpenseClaimStatusDto;
  readonly judgment?: ExpenseJudgmentDto;
  readonly acknowledgements: readonly { readonly itemId?: string; readonly code: ExpenseReasonCodeDto; readonly note: string; readonly by: string; readonly at: string }[];
  readonly returnNote?: { readonly message: string; readonly reasons: readonly { readonly code: ExpenseReasonCodeDto; readonly itemId?: string; readonly severity: ExpenseSeverityDto }[]; readonly by: string; readonly at: string };
  readonly approval?: { readonly by: string; readonly displayName?: string; readonly at: string; readonly comment?: string };
  readonly approvalFlow?: ExpenseApprovalFlowDto;
  readonly settlement?: { readonly settledAt: string; readonly by: string; readonly exportFileName?: string };
  readonly payout?: { readonly batchId: string; readonly exportedAt: string };
  readonly journalLink?: { readonly entries: readonly { readonly itemId: string; readonly entryId: string }[]; readonly complete: boolean; readonly draftedAt: string; readonly by: string; readonly warnings: readonly string[] };
  readonly history: readonly { readonly type: string; readonly by?: string; readonly at: string; readonly note?: string; readonly proxy?: boolean }[];
  readonly submittedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly totalAmount: number;
  /** 立替として支払う額（会社払いを申請に含める規程なら、会社払いの明細を除く）。 */
  readonly reimbursableAmount: number;
  /** 規程か明細が判定の後に変わった。 */
  readonly stale: boolean;
  /** 見ている人が承認するとしたら妨げになる理由（checked と in-approval で出る。他は空）。 */
  readonly approvalBlockers: readonly ExpenseBlockingReasonDto[];
  readonly approvalPlan?: ExpenseApprovalPlanDto;
}

export interface ExpenseClaimSummaryDto {
  readonly id: string;
  readonly claimant: ExpenseClaimantDto;
  readonly period: ExpensePeriodDto;
  readonly title?: string;
  readonly status: ExpenseClaimStatusDto;
  readonly verdict?: ExpenseVerdictDto;
  readonly stale: boolean;
  readonly itemCount: number;
  readonly totalAmount: number;
  /** 会社払いの明細の合計（規程のフラグに依らない）。 */
  readonly corporatePaymentAmount: number;
  readonly reasonCounts: { readonly return: number; readonly review: number; readonly acknowledged: number };
  readonly journalLinked: 'none' | 'partial' | 'complete';
  readonly topReasons: readonly string[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly settledAt?: string;
  readonly submittedBy: string;
  readonly advanceId?: string;
  readonly payoutBatchId?: string;
  /** 承認中の現在の段（in-approval のときだけ）。 */
  readonly currentStep?: { readonly stepId: string; readonly name: string; readonly approvers: readonly ExpenseApprovalApproverDto[] };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExpenseClaimListFilterDto {
  readonly status?: ExpenseClaimStatusDto;
  readonly verdict?: ExpenseVerdictDto;
  readonly claimant?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly employeeId?: string;
  readonly departmentId?: string;
  readonly advanceId?: string;
  /** 現在の段の承認者に自分の従業員が入っている申請だけ（単一ユーザーは全件）。 */
  readonly awaiting?: 'me';
  /** 申請者が従業員マスタに紐付いていない申請だけ。 */
  readonly unlinked?: boolean;
}

export interface SaveExpenseClaimDto { readonly claimant: ExpenseClaimantDto; readonly period: ExpensePeriodDto; readonly title?: string }

export interface SaveExpenseItemDto {
  readonly itemId?: string;
  readonly categoryId?: string;
  readonly categoryText?: string;
  readonly facts: ExpenseReceiptFactsDto;
  readonly source: ExpenseItemSourceDto;
  readonly extraction?: Partial<ExpenseItemExtractionDto>;
  readonly receipt?: { readonly dataUrl: string; readonly fileName?: string; readonly mime?: string; readonly text?: string };
}

export interface ExpenseReceiptDto { readonly dataUrl: string; readonly fileName?: string; readonly text?: string }

/* 取込 --------------------------------------------------------------------- */

export interface ImportExpenseCsvDto { readonly content: string; readonly period: ExpensePeriodDto; readonly claimId?: string; readonly fileName?: string }

export interface ImportExpenseCsvResultDto {
  readonly claims: readonly { readonly id: string; readonly claimant: ExpenseClaimantDto; readonly itemCount: number; readonly importedCount: number; readonly created: boolean }[];
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly string[];
  readonly columnMatches: readonly { readonly header: string; readonly field: string | null }[];
}

export interface ExpenseItemDraftDto {
  readonly categoryId?: string;
  readonly categoryText?: string;
  readonly facts: ExpenseReceiptFactsDto;
  readonly source: { readonly type: 'image' | 'pdf'; readonly fileName?: string };
  readonly extraction: ExpenseItemExtractionDto;
}

export interface ExtractExpenseReceiptDto {
  readonly images: readonly string[];
  readonly text?: string;
  readonly fileName?: string;
  /** 経費専用の追加読取もする（§20.7.1）。使えないサーバーでは無視されず 409 になるので、可否を見てから付ける。 */
  readonly detail?: boolean;
}

export interface ExtractExpenseReceiptResultDto {
  readonly drafts: readonly ExpenseItemDraftDto[];
  readonly claimantHint?: string;
  readonly warnings: readonly string[];
}

/* チェック・出力 ------------------------------------------------------------ */

export interface CheckExpenseClaimsResultDto { readonly checked: number; readonly pass: number; readonly needsReview: number; readonly returned: number; readonly skipped: number }

export interface ExpenseJournalLinkProblemDto {
  readonly itemId?: string;
  readonly code: string;
  readonly message: string;
  readonly fixTarget: 'item' | 'policy-category' | 'policy-journal' | 'journal-chart';
  readonly categoryId?: string;
  readonly accountId?: string;
}

export interface DraftExpenseJournalEntriesResultDto { readonly claim: ExpenseClaimDto; readonly entryIds: readonly string[]; readonly warnings: readonly string[] }

export type ExpenseSettlementFormatDto = 'payout' | 'detail';

export interface ExpenseSettlementQueryDto { readonly format: ExpenseSettlementFormatDto; readonly status?: 'approved' | 'settled'; readonly from?: string; readonly to?: string }

export interface ExpenseSettlementResultDto {
  readonly format: ExpenseSettlementFormatDto;
  readonly fileName: string;
  readonly content: string;
  readonly claimCount: number;
  readonly itemCount: number;
  readonly totalAmount: number;
  readonly warnings: readonly string[];
}

export interface ExpenseCapabilitiesDto {
  readonly extraction: { readonly enabled: boolean; readonly vision: boolean };
  /** 経費専用の追加読取（UC7）。 */
  readonly detailExtraction: { readonly enabled: boolean };
  /** 規程のヒアリング生成（UC9）。 */
  readonly policyHearing: { readonly enabled: boolean };
}
