/**
 * ui/api層: 入金消込（docs/22-receivables.md §7）の HTTP DTO。
 *
 * サーバーの応答（domain の集約から tenant を除いた形）と同型。UI はバックエンドの層を import できないので、
 * ここに書き写す（ADR-0039 §8。共有の `types.ts` は触らない）。
 */

export type RoundingModeDto = 'floor' | 'round-half-up' | 'ceil';
export type PricingDto = 'exclusive' | 'inclusive';
export type TaxRateDto = 10 | 8 | 0;
export type ZeroRateKindDto = 'exempt' | 'non-taxable' | 'export';
export type InvoiceStatusDto = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void';
export type BankTransactionStatusDto = 'unmatched' | 'matched' | 'ignored';
export type MatchStageDto = 'decided' | 'candidate' | 'unmatched';
export type NameMatchDto = 'alias' | 'kana' | 'name' | 'partial' | 'none';
export type CsvEncodingHintDto = 'auto' | 'utf-8' | 'shift_jis';

export interface TransferAccountDto {
  readonly bankName: string;
  readonly branchName: string;
  readonly accountType: string;
  readonly accountNumber: string;
  readonly holderKana: string;
}

export interface ReceivablesSettingsDto {
  readonly issuer: { readonly name: string; readonly registered: boolean; readonly registrationNumber?: string; readonly address?: string; readonly tel?: string; readonly transferAccounts: readonly TransferAccountDto[]; readonly note?: string };
  readonly rounding: { readonly mode: RoundingModeDto; readonly defaultPricing: PricingDto };
  readonly matching: { readonly feeTolerance: { readonly min: number; readonly max: number }; readonly maxCombinationSize: number; readonly partialNameMinLength: number };
  readonly journal: {
    readonly enabled: boolean;
    readonly accounts: { readonly sales: string; readonly receivable: string; readonly deposit: string; readonly fee: string };
    readonly salesTaxCodes: { readonly '10': string; readonly '8': string; readonly '0': string };
    readonly feeTaxCode: string;
    readonly nonTaxableTaxCode: string;
    readonly salesEntryDate: 'transaction-date' | 'issue-date';
  };
  readonly numbering: { readonly format: string };
  readonly updatedAt?: string;
}

export interface PayerAliasDto {
  readonly id: string;
  readonly text: string;
  readonly normalized: string;
  readonly origin: 'manual' | 'learned';
  readonly matchingId?: string;
  readonly createdAt: string;
  readonly lastMatchedAt?: string;
}

export interface CustomerDto {
  readonly id: string;
  readonly name: string;
  readonly honorific: '御中' | '様';
  readonly kana?: string;
  readonly registrationNumber?: string;
  readonly paymentTermDays?: number;
  readonly address?: string;
  readonly note?: string;
  readonly payerAliases: readonly PayerAliasDto[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 一覧だけが持つ。 */
  readonly outstanding?: number;
}

export interface SaveCustomerDto {
  readonly name: string;
  readonly honorific?: '御中' | '様';
  readonly kana?: string;
  readonly registrationNumber?: string;
  readonly paymentTermDays?: number;
  readonly address?: string;
  readonly note?: string;
  readonly payerAliases?: readonly { readonly id?: string; readonly text: string }[];
  readonly enabled?: boolean;
}

export interface AliasConflictDto {
  readonly normalized: string;
  readonly otherCustomerId: string;
  readonly otherCustomerName: string;
}

export interface InvoiceLineDto {
  readonly description: string;
  readonly quantity?: number;
  readonly unit?: string;
  readonly unitPrice?: number;
  readonly amount?: number;
  readonly taxRate?: TaxRateDto;
  readonly zeroRateKind?: ZeroRateKindDto;
}

export interface DeclaredTaxesDto {
  readonly lineTaxAmounts?: readonly (number | null)[];
  readonly taxByRate?: readonly { readonly rate: TaxRateDto; readonly taxAmount: number }[];
  readonly grandTotal?: number;
}

/** 請求書の中身（ツールの `draft_json` もこの形。`customerNameHint` は画面だけが読む）。 */
export interface SaveInvoiceDto {
  readonly customerId?: string;
  readonly issueDate?: string;
  readonly transactionDate?: string;
  readonly transactionPeriod?: { readonly from: string; readonly to: string };
  readonly dueDate?: string;
  readonly pricing: PricingDto;
  readonly lines: readonly InvoiceLineDto[];
  readonly declared?: DeclaredTaxesDto;
  readonly note?: string;
}

export interface RateTotalDto { readonly rate: TaxRateDto; readonly taxable: number; readonly tax: number; readonly inclusive: number }
export interface InvoiceTotalsDto { readonly byRate: readonly RateTotalDto[]; readonly taxTotal: number; readonly grandTotal: number }

export interface InvoiceIssueDto {
  readonly code: string;
  readonly path?: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface InvoiceCheckDto {
  readonly totals: InvoiceTotalsDto;
  readonly violations: readonly InvoiceIssueDto[];
  readonly warnings: readonly InvoiceIssueDto[];
}

export interface InvoiceDto extends SaveInvoiceDto {
  readonly id: string;
  readonly number?: string;
  readonly status: InvoiceStatusDto;
  readonly roundingMode: RoundingModeDto;
  readonly totals: InvoiceTotalsDto;
  readonly snapshot?: {
    readonly issuer: ReceivablesSettingsDto['issuer'];
    readonly customer: { readonly name: string; readonly honorific: string; readonly address?: string; readonly registrationNumber?: string };
    readonly roundingMode: RoundingModeDto;
    readonly issuedAt: string;
  };
  readonly paidAmount: number;
  readonly journal: { readonly salesEntryId?: string; readonly salesEntryKept?: boolean };
  readonly voided?: { readonly at: string; readonly reason: string };
  readonly duplicatedFrom?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InvoiceSummaryDto extends InvoiceDto {
  readonly customerName?: string;
  readonly outstanding: number;
  readonly daysOverdue: number;
  readonly violationCount: number;
}

export interface InvoicePaymentDto {
  readonly matchingId: string;
  readonly transactionId: string;
  readonly amount: number;
  readonly feeAmount: number;
  readonly status: 'confirmed' | 'cancelled';
  readonly confirmedAt: string;
}

export interface JournalFollowUpDto {
  readonly entryId: string;
  readonly action: 'review' | 'reverse';
  readonly entryStatus?: 'confirmed' | 'exported';
}

export interface IssueInvoiceResultDto {
  readonly invoice: InvoiceDto;
  readonly journal?: { readonly status: 'created' | 'updated' | 'kept' | 'disabled'; readonly entryId?: string };
  readonly journalFollowUp?: JournalFollowUpDto;
}

export interface ColumnMappingDto {
  readonly date: string;
  readonly description?: string;
  readonly deposit?: string;
  readonly withdrawal?: string;
  readonly amount?: string;
  readonly balance?: string;
  readonly detail?: string;
  readonly payerName?: string;
}

export interface BankCsvProfileDto {
  readonly id: string;
  readonly name: string;
  readonly origin: 'builtin' | 'user';
  readonly presetId?: string;
  readonly mapping?: ColumnMappingDto;
  readonly headerSignature: readonly string[];
  readonly headerRow: number | 'auto';
  readonly accountKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CsvWarningDto {
  readonly code: 'garbled-rows' | 'no-balance-column' | 'detected-profile' | 'skipped-rows';
  readonly params: Readonly<Record<string, string | number>>;
}

export interface BankCsvReadDto {
  readonly contentBase64: string;
  readonly encoding?: CsvEncodingHintDto;
  readonly profileId?: string;
  readonly mapping?: ColumnMappingDto;
  readonly headerRow?: number;
  readonly accountKey?: string;
  readonly fileName?: string;
}

export interface BankCsvPreviewDto {
  readonly encoding: 'utf-8' | 'shift_jis';
  readonly warnings: readonly CsvWarningDto[];
  readonly headerRow: number;
  readonly headers: readonly string[];
  readonly profile?: { readonly id: string; readonly name: string; readonly origin: string; readonly accountKey?: string };
  readonly mapping?: ColumnMappingDto;
  readonly mappingRequired: boolean;
  readonly mappingProblems: readonly string[];
  readonly preamble: readonly (readonly string[])[];
  readonly rows: readonly (readonly string[])[];
  readonly dataRowCount: number;
}

export interface MatchCandidateDto {
  readonly invoiceIds: readonly string[];
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: number }[];
  readonly candidateTotal: number;
  readonly difference: number;
  readonly feeAmount: number;
  readonly customerId: string;
  readonly nameMatch: NameMatchDto;
  readonly nameScore: number;
  readonly rank: number;
}

export interface MatchJudgmentDto {
  readonly stage: MatchStageDto;
  readonly reason: string;
  readonly candidates: readonly MatchCandidateDto[];
  readonly params?: Readonly<Record<string, string | number>>;
  readonly judgedAt?: string;
  readonly contendedBy?: readonly string[];
}

export interface BankTransactionDto {
  readonly id: string;
  readonly accountKey: string;
  readonly date: string;
  readonly amount: number;
  readonly description: string;
  readonly payerName: string;
  readonly payerNameNorm: string;
  readonly balance?: number;
  readonly source: { readonly fileName?: string; readonly profileId?: string; readonly row: Readonly<Record<string, string>>; readonly rowNumber: number };
  readonly fingerprint: string;
  readonly status: BankTransactionStatusDto;
  readonly judgment?: MatchJudgmentDto;
  readonly matchingId?: string;
  readonly ignoredNote?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BankCsvImportResultDto {
  readonly profileId?: string;
  readonly encoding: 'utf-8' | 'shift_jis';
  readonly imported: readonly BankTransactionDto[];
  readonly skippedWithdrawals: number;
  readonly duplicates: readonly { readonly row: number; readonly date: string; readonly amount: number; readonly payerName: string; readonly existingId: string }[];
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly warnings: readonly CsvWarningDto[];
}

export interface JudgeResultDto {
  readonly judged: readonly { readonly transactionId: string; readonly stage: MatchStageDto; readonly reason: string; readonly contendedBy?: readonly string[] }[];
  readonly counts: { readonly decided: number; readonly candidate: number; readonly unmatched: number };
}

export interface MatchingDto {
  readonly id: string;
  readonly transactionId: string;
  readonly transactionAmount: number;
  readonly customerId?: string;
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: number }[];
  readonly feeAmount: number;
  readonly status: 'confirmed' | 'cancelled';
  readonly decidedBy: 'judgment' | 'manual';
  readonly judgmentReason?: string;
  readonly learnedAlias?: { readonly customerId: string; readonly aliasId: string };
  readonly journal: { readonly entryId?: string; readonly outcome?: 'created' | 'updated' | 'kept' | 'disabled' };
  readonly confirmedAt: string;
  readonly cancelledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConfirmMatchingDto {
  readonly transactionId: string;
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: number }[];
  readonly feeAmount: number;
  readonly expectedOutstanding?: Readonly<Record<string, number>>;
  readonly learnAlias?: { readonly customerId: string };
}

export interface ConfirmMatchingResultDto {
  readonly matching: MatchingDto;
  readonly journal: { readonly status: 'created' | 'updated' | 'kept' | 'disabled'; readonly entryId?: string };
  readonly journalFollowUp?: JournalFollowUpDto;
  readonly learnedAlias?: { readonly customerId: string; readonly aliasId: string; readonly created: boolean };
}

export interface ConfirmDecidedResultDto {
  readonly confirmed: readonly { readonly transactionId: string; readonly matchingId: string }[];
  readonly failed: readonly { readonly transactionId: string; readonly code: string; readonly reason?: string; readonly message: string }[];
}

export interface CancelMatchingResultDto {
  readonly matching: MatchingDto;
  readonly journalFollowUp?: JournalFollowUpDto;
  readonly removedAlias: boolean;
}

export interface ReceivablesCapabilitiesDto {
  readonly invoiceDraft: { readonly enabled: boolean; readonly vision: boolean };
}
