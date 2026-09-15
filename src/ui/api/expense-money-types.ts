/**
 * ui/api層: 経費精算「お金の流れ（仮払・カード明細・集計。docs/21 §20.9.3）」の DTO。
 *
 * サーバーの応答（Serialized から tenant を除いた形）と同型。口座番号はどの DTO にも無い。
 */
import type { ExpenseBlockingReasonDto, ExpenseClaimDto, ExpenseClaimStatusDto, ExpenseClaimSummaryDto } from './expense-types';

/* 仮払 ------------------------------------------------------------------- */

export type ExpenseAdvanceStatusDto = 'requested' | 'approved' | 'paid' | 'settling' | 'settled' | 'cancelled';
export type ExpenseAdvancePaymentMethodDto = 'transfer' | 'cash';

export interface ExpenseAdvanceDto {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeSnapshot: { readonly name: string; readonly departmentId?: string };
  readonly purpose: string;
  readonly amount: number;
  readonly neededOn: string;
  readonly plannedSettleBy: string;
  readonly status: ExpenseAdvanceStatusDto;
  readonly approval?: { readonly by: string; readonly employeeId?: string; readonly at: string; readonly comment?: string; readonly proxy: boolean };
  readonly payment?: { readonly paidOn: string; readonly method: ExpenseAdvancePaymentMethodDto; readonly by: string; readonly at: string; readonly payoutBatchId?: string };
  readonly settlement?: {
    readonly computedAt: string;
    readonly claimIds: readonly string[];
    readonly claimsTotal: number;
    readonly difference: number;
    readonly additionalPayment?: { readonly amount: number; readonly status: 'pending' | 'exported' | 'paid'; readonly payoutBatchId?: string; readonly paidOn?: string };
    readonly refund?: { readonly amount: number; readonly receivedOn?: string; readonly by?: string };
    readonly settledOn?: string;
  };
  readonly journalLink?: { readonly paymentEntryId?: string; readonly settlementEntryId?: string; readonly warnings: readonly string[] };
  readonly cancel?: { readonly by: string; readonly at: string; readonly note: string };
  readonly submittedBy: string;
  readonly history: readonly { readonly type: string; readonly by?: string; readonly at: string; readonly note?: string; readonly proxy?: boolean }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly linkedClaimCount: number;
  readonly linkedClaimTotal: number;
  /** 支払済み以降で精算されておらず、精算予定日を過ぎた。 */
  readonly overdue: boolean;
  /** 部門名（組織にあれば）。 */
  readonly department?: string;
}

export interface ExpenseAdvanceDetailDto {
  readonly advance: ExpenseAdvanceDto;
  readonly claims: readonly ExpenseClaimSummaryDto[];
}

export interface ExpenseAdvanceListFilterDto {
  readonly status?: ExpenseAdvanceStatusDto;
  readonly employeeId?: string;
  readonly limit?: number;
}

export interface SaveExpenseAdvanceDto {
  readonly purpose: string;
  readonly amount: number;
  readonly neededOn: string;
  readonly plannedSettleBy: string;
}

export interface CreateExpenseAdvanceDto extends SaveExpenseAdvanceDto {
  readonly employeeId: string;
}

export interface ExpenseAdvancePaymentDto {
  readonly paidOn: string;
  readonly method: ExpenseAdvancePaymentMethodDto;
}

export type ExpenseAdvanceSettlementDirectionDto = 'additional' | 'refund' | 'even';

export interface ExpenseAdvanceSettlementPreviewDto {
  readonly claims: readonly { readonly id: string; readonly status: string; readonly reimbursableAmount: number; readonly employeeId?: string; readonly claimantName?: string; readonly journalLinked?: 'none' | 'partial' | 'complete' }[];
  readonly claimsTotal: number;
  readonly difference: number;
  readonly direction: ExpenseAdvanceSettlementDirectionDto;
  /** 精算できない理由（code: advance-not-paid / advance-claim-not-approved / advance-employee-mismatch / advance-too-many-claims）。 */
  readonly blockers: readonly ExpenseBlockingReasonDto[];
}

export interface ExpenseAdvanceSettleResultDto {
  readonly advance: ExpenseAdvanceDto;
  readonly claims: readonly ExpenseClaimDto[];
}

export type ExpenseAdvanceJournalStageDto = 'payment' | 'settlement';

export interface ExpenseAdvanceJournalResultDto {
  readonly advance: ExpenseAdvanceDto;
  readonly entryIds: readonly string[];
  readonly warnings: readonly string[];
}

/* カード ----------------------------------------------------------------- */

export type ExpenseCardAmountSignDto = 'charge-positive' | 'charge-negative';

export interface ExpenseCardDto {
  readonly id: string;
  readonly label: string;
  readonly issuerName?: string;
  readonly last4: string;
  readonly holderEmployeeId?: string;
  readonly enabled: boolean;
}

export interface ExpenseCardColumnsDto {
  readonly usedOn: string;
  readonly merchant: string;
  readonly amount: string;
  readonly postedOn?: string;
  readonly cardLast4?: string;
  readonly memo?: string;
}

export type ExpenseCardColumnKeyDto = keyof ExpenseCardColumnsDto;

export interface ExpenseCardMappingDto {
  readonly columns: ExpenseCardColumnsDto;
  readonly amountSign: ExpenseCardAmountSignDto;
  readonly skipLinesBefore: number;
}

export interface ExpenseCardStatementProfileDto extends ExpenseCardMappingDto {
  readonly id: string;
  readonly name: string;
  readonly headerSignature: readonly string[];
}

export interface ExpenseCardSettingsDto {
  readonly cards: readonly ExpenseCardDto[];
  readonly profiles: readonly ExpenseCardStatementProfileDto[];
  readonly updatedAt: string;
}

export interface ExpenseCardSettingsResultDto {
  readonly settings: ExpenseCardSettingsDto;
  readonly saved: boolean;
}

export interface ExpenseCardStatementInputDto {
  readonly content: string;
  readonly profileId?: string;
  readonly mapping?: ExpenseCardMappingDto;
  readonly cardId?: string;
}

export interface ExpenseCardStatementImportInputDto extends ExpenseCardStatementInputDto {
  readonly fileName: string;
  readonly saveProfileAs?: string;
}

export interface ExpenseCardStatementPreviewDto {
  readonly headers: readonly string[];
  readonly detectedProfileId?: string;
  readonly suggestedMapping: Partial<Record<ExpenseCardColumnKeyDto, string>>;
  readonly rows: readonly { readonly row: number; readonly cardId: string; readonly usedOn: string; readonly postedOn?: string; readonly merchantRaw: string; readonly merchantKey: string; readonly amount: number; readonly memo?: string }[];
  readonly rowCount: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly problems: readonly { readonly code: 'mapping-missing' | 'card-import'; readonly message: string; readonly row?: number; readonly missingColumns?: readonly string[] }[];
}

export interface ExpenseCardImportResultDto {
  readonly importId: string;
  readonly imported: number;
  readonly duplicates: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly string[];
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly profileId?: string;
}

export interface ExpenseCardImportDto {
  readonly id: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly profileId?: string;
  readonly mapping: ExpenseCardMappingDto;
  readonly cardId?: string;
  readonly rowCount: number;
  readonly importedCount: number;
  readonly duplicateCount: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly by: string;
  readonly createdAt: string;
}

export type ExpenseCardTransactionStatusDto = 'unmatched' | 'matched' | 'excluded';

export interface ExpenseCardTransactionDto {
  readonly id: string;
  readonly importId: string;
  readonly cardId: string;
  readonly usedOn: string;
  readonly postedOn?: string;
  readonly merchantRaw: string;
  readonly merchantKey: string;
  /** 返金は負。 */
  readonly amount: number;
  readonly memo?: string;
  readonly row: Readonly<Record<string, string>>;
  readonly dedupeKey: string;
  readonly status: ExpenseCardTransactionStatusDto;
  readonly match?: {
    readonly claimId: string;
    readonly itemId: string;
    /** corporate-item = 会社払いの明細（正常）/ reimbursement-item = 立替の明細（二重計上の疑い）。 */
    readonly kind: 'corporate-item' | 'reimbursement-item';
    readonly strength: 'strong' | 'weak';
    readonly dateDiffDays: number;
    readonly amountDiff: number;
    readonly manual: boolean;
    readonly at: string;
    readonly by?: string;
  };
  readonly exclusion?: { readonly reason: string; readonly by: string; readonly at: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cardLabel: string;
  readonly cardLast4: string;
  readonly holder?: string;
  readonly claimant?: string;
  readonly claimStatus?: ExpenseClaimStatusDto;
  readonly importFile: string;
}

export interface ExpenseCardTransactionFilterDto {
  readonly status?: ExpenseCardTransactionStatusDto;
  readonly cardId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly claimId?: string;
  readonly limit?: number;
}

export interface ExpenseCardMatchResultDto {
  readonly matched: number;
  readonly reimbursementMatches: number;
  readonly unmatched: number;
  readonly kept: number;
}

/* 集計 ------------------------------------------------------------------- */

export type ExpenseSummaryGroupKeyDto = 'month' | 'department' | 'category' | 'claimant' | 'status';
export type ExpenseSummaryBasisDto = 'transaction' | 'approved' | 'settled';

export interface ExpenseSummaryQueryDto {
  /** YYYY-MM（両端を含む。最長 36 か月）。 */
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly ExpenseSummaryGroupKeyDto[];
  /** 空 = 既定（approved, settled）。 */
  readonly statuses: readonly ExpenseClaimStatusDto[];
  readonly basis: ExpenseSummaryBasisDto;
}

export interface ExpenseSummaryRowDto {
  readonly month: string | null;
  readonly departmentId: string | null;
  readonly department: string | null;
  readonly categoryId: string | null;
  readonly category: string | null;
  readonly employeeId: string | null;
  readonly claimant: string | null;
  readonly status: string | null;
  readonly claimCount: number;
  readonly itemCount: number;
  readonly amount: number;
  readonly reimbursableAmount: number;
  readonly corporateAmount: number;
}

export interface ExpenseSummaryResultDto {
  readonly rows: readonly ExpenseSummaryRowDto[];
  readonly totals: { readonly claimCount: number; readonly itemCount: number; readonly amount: number; readonly reimbursableAmount: number; readonly corporateAmount: number };
  readonly warnings: readonly string[];
  readonly basis: ExpenseSummaryBasisDto;
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly ExpenseSummaryGroupKeyDto[];
  readonly statuses: readonly ExpenseClaimStatusDto[];
}

/* 準備状況 --------------------------------------------------------------- */

/** 「実用機能の準備」カードのうち、お金の流れの状況（`readinessRows(policy, { cards, payout })` に渡す）。 */
export interface ExpenseMoneyReadinessDto {
  readonly cards: boolean;
  readonly cardCount: number;
  readonly cardImportCount: number;
  readonly lastCardImportAt?: string;
  readonly cardCoverage: readonly { readonly cardId: string; readonly from: string; readonly to: string }[];
  readonly payout: boolean;
}

/* 振込データ（UC3） ------------------------------------------------------ */

export interface ZenginFormatDto {
  readonly lineEnding: 'crlf' | 'none';
  readonly eofMark: boolean;
  readonly includeBankNames: boolean;
  readonly clearingHouse: 'zeros' | 'spaces';
  readonly transferKind: '7' | '8' | 'space';
  readonly newCode: '0' | '1' | '2';
  readonly customerCode1: 'none' | 'employee-code';
  readonly charset: 'strict' | 'extended';
  readonly maxRecords: number;
}

export type PayoutSourceAccountTypeDto = 'ordinary' | 'current' | 'other';

export interface PayoutSourceAccountDto {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: PayoutSourceAccountTypeDto;
  /** 口座番号は返さない（末尾 4 桁だけ）。 */
  readonly accountNumberLast4: string;
}

export interface ExpensePayoutSettingsDto {
  readonly source?: PayoutSourceAccountDto;
  readonly requesterCode?: string;
  readonly requesterNameKana?: string;
  readonly format: ZenginFormatDto;
  readonly journal: { readonly createPaymentEntry: boolean; readonly sourceAccountId: string };
  readonly updatedAt: string;
}

export interface ExpensePayoutSettingsResultDto {
  readonly settings: ExpensePayoutSettingsDto;
  readonly saved: boolean;
}

export interface SaveExpensePayoutSettingsDto {
  /** undefined = 既存を保つ、null = 振込元を外す。`accountNumber` 省略 = 既存の口座番号を保つ。 */
  readonly source?: (Omit<PayoutSourceAccountDto, 'accountNumberLast4'> & { readonly accountNumber?: string }) | null;
  readonly requesterCode?: string;
  readonly requesterNameKana?: string;
  readonly format?: Partial<ZenginFormatDto>;
  readonly journal?: Partial<ExpensePayoutSettingsDto['journal']>;
}

export type ExpensePayoutFixTargetDto = 'payout-settings' | 'claim-claimant' | 'employee-links' | 'employee-bank-account' | 'employee-history' | 'payout-batch' | 'approve' | 'transfer-date' | 'settle' | 'none';

export interface ExpensePayoutProblemDto {
  readonly code: string;
  readonly employeeId?: string;
  readonly claimId?: string;
  readonly advanceId?: string;
  readonly field?: string;
  /** 原因と次の一手（日本語）。 */
  readonly message: string;
  readonly fixTarget: ExpensePayoutFixTargetDto;
  readonly params?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MaskedBankAccountDto {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: 'ordinary' | 'current' | 'savings' | 'other';
  readonly holderKana: string;
  readonly accountNumberLast4: string;
}

export type ExpensePayoutSourceKindDto = 'claim' | 'advance-payment' | 'advance-additional';

export interface ExpensePayoutLineDto {
  readonly employeeId: string;
  readonly name: string;
  readonly employeeCode?: string;
  readonly holderKanaConverted: string;
  readonly bank: MaskedBankAccountDto;
  readonly amount: number;
  readonly sources: readonly { readonly kind: ExpensePayoutSourceKindDto; readonly id: string; readonly amount: number }[];
}

export interface ExpensePayoutRequestDto {
  readonly claimIds?: readonly string[];
  readonly advanceIds?: readonly string[];
  readonly transferDate: string;
}

export interface ExpensePayoutPreviewDto {
  readonly candidates: {
    readonly claims: readonly { readonly id: string; readonly claimantName: string; readonly employeeId?: string; readonly amount: number; readonly journalLinked: 'none' | 'partial' | 'complete' }[];
    readonly advancePayments: readonly { readonly id: string; readonly employeeId: string; readonly employeeName: string; readonly amount: number }[];
    readonly advanceAdditionals: readonly { readonly id: string; readonly employeeId: string; readonly employeeName: string; readonly amount: number }[];
  };
  readonly lines: readonly ExpensePayoutLineDto[];
  readonly totalAmount: number;
  readonly recordCount: number;
  readonly problems: readonly ExpensePayoutProblemDto[];
  readonly warnings: readonly ExpensePayoutProblemDto[];
}

export type ExpensePayoutBatchStatusDto = 'exported' | 'confirmed' | 'cancelled';

export interface ExpensePayoutBatchDto {
  readonly id: string;
  readonly status: ExpensePayoutBatchStatusDto;
  readonly transferDate: string;
  readonly lines: readonly Omit<ExpensePayoutLineDto, 'employeeCode'>[];
  readonly recordCount: number;
  readonly totalAmount: number;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly settingsSnapshot: ExpensePayoutSettingsDto;
  readonly acknowledgedWarnings: readonly string[];
  readonly by: string;
  readonly createdAt: string;
  readonly confirmedAt?: string;
  readonly confirmedBy?: string;
  readonly cancel?: { readonly by: string; readonly at: string; readonly note: string };
  readonly journalEntryId?: string;
}

export interface ExpensePayoutFileDto {
  readonly fileName: string;
  readonly contentBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ExpensePayoutCreateResultDto {
  readonly batch: ExpensePayoutBatchDto;
  readonly file: ExpensePayoutFileDto;
}

export interface ExpensePayoutConfirmResultDto {
  readonly batch: ExpensePayoutBatchDto;
  readonly claims: readonly ExpenseClaimDto[];
  readonly advances: readonly ExpenseAdvanceDto[];
  readonly warnings: readonly string[];
}
