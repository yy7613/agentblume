/**
 * ui/api層: 経費精算「入力と規程」（§20.9.4）の DTO。サーバーの応答（テナント抜き）と同じ形。
 */
import type { ExpenseCategoryDto, ExpenseFareTypeDto, ExpenseItemDraftDto, ExpensePolicyDto } from './expense-types';

/* 運賃マスタ ----------------------------------------------------------------- */

export interface ExpenseFareRouteDto {
  readonly id: string;
  /** [出発, …経由, 到着]。 */
  readonly stations: readonly string[];
  readonly fareType: ExpenseFareTypeDto;
  /** 片道運賃（円）。 */
  readonly fare: number;
  readonly bidirectional: boolean;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly note?: string;
}

export interface ExpenseStationAliasDto { readonly name: string; readonly aliases: readonly string[] }

export interface ExpenseFareTableDto {
  readonly routes: readonly ExpenseFareRouteDto[];
  readonly stationAliases: readonly ExpenseStationAliasDto[];
  readonly updatedAt: string;
}

export interface ExpenseFareTableResultDto { readonly table: ExpenseFareTableDto; readonly saved: boolean }

export interface SaveExpenseFareTableDto {
  readonly routes: readonly ExpenseFareRouteDto[];
  readonly stationAliases: readonly ExpenseStationAliasDto[];
}

export interface ExpenseFareLookupDto {
  readonly stations: readonly string[];
  readonly fareType?: ExpenseFareTypeDto;
  readonly date?: string;
  readonly trips?: number;
  /** 申請者の従業員（通勤定期のヒントを引く）。 */
  readonly employeeId?: string;
}

export type ExpenseCommuterHintDto =
  | { readonly kind: 'full'; readonly passRoute: string; readonly validTo?: string }
  | { readonly kind: 'partial'; readonly passRoute: string; readonly validTo?: string; readonly overlapFrom: string; readonly overlapTo: string; readonly restRoute?: string; readonly suggestedAmount?: number };

export interface ExpenseFareLookupResultDto {
  readonly fareType: ExpenseFareTypeDto;
  readonly candidates: readonly ExpenseFareRouteDto[];
  readonly maxFare?: number;
  /** 運賃マスタの経路の数（0 なら未登録）。 */
  readonly routeCount: number;
  readonly commuterHint?: ExpenseCommuterHintDto;
}

/* 追加読取 ------------------------------------------------------------------- */

export interface ExpenseDetailDisagreementDto {
  readonly field: 'registrationNumber' | 'transactionDate' | 'issueDate' | 'payeeName';
  readonly journalValue: string | null;
  readonly detailValue: string | null;
}

export interface ExtractExpenseDetailDto {
  readonly images: readonly string[];
  readonly draft: ExpenseItemDraftDto;
}

export interface ExtractExpenseDetailResultDto {
  readonly draft: ExpenseItemDraftDto;
  readonly disagreements: readonly ExpenseDetailDisagreementDto[];
  readonly warnings: readonly string[];
}

/* 規程のヒアリング ----------------------------------------------------------- */

export type ExpenseHearingModeDto = 'document' | 'questions';
export type ExpenseHearingStatusDto = 'open' | 'proposed' | 'accepted' | 'cancelled';
export type ExpenseHearingQuestionKindDto = 'single' | 'multi' | 'text' | 'number' | 'confirm';
export type ExpenseHearingAnswerValueDto = string | number | boolean | readonly string[];

export interface ExpenseHearingQuestionDto {
  readonly id: string;
  readonly text: string;
  readonly kind: ExpenseHearingQuestionKindDto;
  readonly options?: readonly string[];
  readonly topic: string;
}

export interface ExpenseHearingAnswerDto { readonly questionId: string; readonly value: ExpenseHearingAnswerValueDto }

export interface ExpenseHearingTurnDto {
  readonly questions: readonly ExpenseHearingQuestionDto[];
  readonly answers?: readonly ExpenseHearingAnswerDto[];
  readonly askedAt: string;
  readonly answeredAt?: string;
}

export interface ExpensePolicyRationaleDto { readonly path: string; readonly quote?: string; readonly quoteFound: boolean; readonly note?: string }

export interface ExpensePolicyProposalDto {
  readonly candidate: {
    readonly categories?: readonly ExpenseCategoryDto[];
    readonly claimRules?: Readonly<Record<string, unknown>>;
    readonly preApprovalRules?: readonly unknown[];
    readonly approvalRoutes?: readonly unknown[];
    readonly severityOverrides?: Readonly<Record<string, string>>;
  };
  readonly rationales: readonly ExpensePolicyRationaleDto[];
  readonly dropped: readonly { readonly path: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export interface ExpensePolicyHearingDto {
  readonly id: string;
  readonly mode: ExpenseHearingModeDto;
  readonly source: { readonly documentText?: string; readonly fileName?: string; readonly sha256?: string; readonly sections?: readonly { readonly heading: string; readonly start: number; readonly end: number }[] };
  readonly status: ExpenseHearingStatusDto;
  readonly turns: readonly ExpenseHearingTurnDto[];
  readonly proposal?: ExpensePolicyProposalDto;
  readonly basePolicyUpdatedAt: string;
  readonly acceptedChangeIds?: readonly string[];
  readonly model?: { readonly provider: string; readonly model: string };
  readonly promptVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExpensePolicyHearingSummaryDto {
  readonly id: string;
  readonly mode: ExpenseHearingModeDto;
  readonly status: ExpenseHearingStatusDto;
  readonly fileName?: string;
  readonly turnCount: number;
  readonly proposedItemCount: number;
  readonly droppedCount: number;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StartExpensePolicyHearingDto {
  readonly mode: ExpenseHearingModeDto;
  readonly documentText?: string;
  readonly fileName?: string;
}

export type ExpensePolicyChangeKindDto = 'add' | 'update' | 'disable';
export type ExpensePolicyChangeSectionDto = 'category' | 'claim-rule' | 'pre-approval' | 'approval-route' | 'severity';

export interface ExpensePolicyChangeDto {
  readonly id: string;
  readonly kind: ExpensePolicyChangeKindDto;
  readonly section: ExpensePolicyChangeSectionDto;
  readonly key: string;
  readonly field?: string;
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly rationale?: ExpensePolicyRationaleDto;
}

export interface ExpensePolicyDiffDto {
  readonly changes: readonly ExpensePolicyChangeDto[];
  readonly basePolicyUpdatedAt: string;
  /** 案を作った後に規程が保存された（差分は現在の規程に対して作り直してある）。 */
  readonly stale: boolean;
}

export interface AcceptExpensePolicyHearingResultDto { readonly hearing: ExpensePolicyHearingDto; readonly policy: ExpensePolicyDto }
