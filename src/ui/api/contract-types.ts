/**
 * ui/api層: 契約書レビューと期限台帳（docs/23-contract.md §6）の DTO。
 *
 * UI は domain を import しない（depcruise `ui-http-boundary-only`）ので、API の応答の形をここに写す。
 * 列挙の値は API の応答と同じ文字列。
 */

export type ValueKindDto = 'term' | 'auto_renewal' | 'notice' | 'payment_terms' | 'liability_cap' | 'permission' | 'ip_ownership' | 'jurisdiction' | 'text';
export type OurRoleDto = 'client' | 'vendor' | 'mutual';
export type PartyKeyDto = 'A' | 'B';
export type ProfileAnswerDto = 'yes' | 'no' | 'unknown';
export type ContractNatureDto = 'ukeoi' | 'jun_inin' | 'sale' | 'nda' | 'license' | 'basic_transaction' | 'other' | 'unknown';
export type SigningMethodDto = 'paper' | 'electronic' | 'unknown';
export type VerdictDto = 'accept' | 'negotiate' | 'reject' | 'unresolved';
export type HumanDecisionDto = 'accept' | 'negotiate' | 'reject';
export type ContractDocumentStatusDto = 'imported' | 'extracted' | 'confirmed' | 'reviewed' | 'signed';
export type ContractSourceTypeDto = 'text' | 'pdf-text' | 'image-ocr' | 'pdf-ocr';
export type DeadlineKindDto = 'expiry' | 'renewal_notice' | 'renewal' | 'custom';
export type DeadlineStateDto = 'overdue' | 'due-soon' | 'upcoming';
export type SignedContractStatusDto = 'active' | 'expired' | 'terminated';
export type ConditionOpDto = 'equals' | 'notEquals' | 'in' | 'notIn' | 'gte' | 'lte' | 'exists' | 'notExists' | 'isTrue' | 'isFalse' | 'contains';
export type PaymentMethodDto = 'bank_transfer' | 'promissory_note' | 'electronic_record' | 'factoring' | 'cash' | 'other';

export interface ContractCapabilitiesDto {
  readonly extraction: { readonly enabled: boolean; readonly vision: boolean };
  readonly review: { readonly llm: boolean };
}

export interface ClauseTopicDto {
  readonly id: string;
  readonly label: string;
  readonly valueKind: ValueKindDto;
  readonly keywords: readonly string[];
  readonly guidance: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export interface ConditionDto {
  readonly field: string;
  readonly op: ConditionOpDto;
  readonly value?: string | number | boolean | readonly (string | number | boolean)[];
}

export type CriterionCheckDto =
  | { readonly type: 'required' }
  | { readonly type: 'condition'; readonly conditions: readonly ConditionDto[] }
  | { readonly type: 'legal'; readonly rule: 'payment-max-days' | 'prohibited-payment-method' }
  | { readonly type: 'llm'; readonly question: string; readonly passWhen: 'yes' | 'no' };

export interface PlaybookCriterionDto {
  readonly id: string;
  readonly topicId: string;
  readonly appliesToRoles?: readonly OurRoleDto[];
  readonly check: CriterionCheckDto;
  readonly onFail: 'negotiate' | 'reject';
  readonly recommendedText?: string;
  readonly rationale: string;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export interface LegalSettingsDto {
  readonly paymentMaxDays: number;
  readonly freelancePaymentMaxDays: number;
  readonly freelanceRedelegationMaxDays: number;
  readonly prohibitedPaymentMethods: readonly PaymentMethodDto[];
  readonly allowMonthEndNextMonthEnd: boolean;
  readonly dueSoonDays: number;
  readonly sources: readonly { readonly label: string; readonly url: string }[];
}

export interface StampDutyDocumentTypeDto {
  readonly code: string;
  readonly name: string;
  readonly natures: readonly ContractNatureDto[];
  readonly condition?: { readonly excludeTermMonthsAtMost?: number; readonly unlessRenewal?: boolean };
  readonly fixedAmount?: number;
  readonly tiers?: readonly { readonly upTo: number | null; readonly amount: number }[];
  readonly noAmountStated?: number;
  readonly sourceUrl: string;
  readonly note: string;
}

export interface StampDutySettingsDto {
  readonly enabled: boolean;
  readonly documentTypes: readonly StampDutyDocumentTypeDto[];
}

export interface PlaybookDto {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly ourRole: OurRoleDto;
  readonly ourCompanyNames: readonly string[];
  readonly topics: readonly ClauseTopicDto[];
  readonly criteria: readonly PlaybookCriterionDto[];
  readonly legal: LegalSettingsDto;
  readonly stampDuty: StampDutySettingsDto;
  readonly extraction: { readonly scanAllArticles: boolean; readonly chunkMaxChars: number };
  readonly templateId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SavePlaybookDto = Omit<PlaybookDto, 'id' | 'createdAt' | 'updatedAt'> & { readonly id?: string };

export interface PlaybookSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly ourRole: OurRoleDto;
  readonly topicCount: number;
  readonly criterionCount: number;
  readonly templateId?: string;
  readonly updatedAt: string;
}

export interface PlaybookTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ourRole: OurRoleDto;
  readonly topicCount: number;
  readonly criterionCount: number;
}

export interface ContractPageDto {
  readonly page: number;
  readonly start: number;
  readonly end: number;
  readonly method: 'text-layer' | 'vision';
  readonly warnings: readonly string[];
}

export interface ContractArticleDto {
  readonly ref: string;
  readonly heading?: string;
  readonly start: number;
  readonly end: number;
  readonly page: number;
}

export interface EvidenceDto {
  readonly quote: string;
  readonly start?: number;
  readonly end?: number;
  readonly verified: boolean;
}

export interface ClauseWarningDto {
  readonly code?: string;
  readonly message: string;
  readonly origin: 'extraction' | 'consistency' | 'manual';
  readonly days?: number;
}

/** 値の型ごとの形（API の応答そのまま。どのキーがあるかは kind で決まる）。 */
export type ClauseValueDto = { readonly kind: ValueKindDto } & Readonly<Record<string, string | number | boolean | undefined>>;

export interface ClauseDto {
  readonly topicId: string;
  readonly present: boolean;
  readonly articleRef?: string;
  readonly evidence: readonly EvidenceDto[];
  readonly value?: ClauseValueDto;
  readonly confidence?: number;
  readonly source: 'llm' | 'manual';
  readonly warnings: readonly ClauseWarningDto[];
  readonly candidates?: readonly { readonly articleRef?: string; readonly evidence: readonly EvidenceDto[]; readonly value?: ClauseValueDto }[];
}

export interface ExtractionRecordDto {
  readonly playbookId?: string;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly promptTemplateVersion: string;
  readonly chunks: readonly { readonly index: number; readonly articleRefs: readonly string[]; readonly topicIds: readonly string[]; readonly status: 'ok' | 'failed'; readonly error?: string }[];
  readonly warnings: readonly string[];
  readonly unscannedArticleRefs: readonly string[];
  readonly scanAllArticles: boolean;
  readonly extractedAt: string;
}

export interface CounterpartyProfileDto {
  readonly toriteki: ProfileAnswerDto;
  readonly freelance: ProfileAnswerDto;
}

export interface ContractDocumentDto {
  readonly id: string;
  readonly title: string;
  readonly source: { readonly type: ContractSourceTypeDto; readonly fileName?: string; readonly pageCount?: number; readonly sha256?: string };
  readonly body: string;
  readonly pages: readonly ContractPageDto[];
  readonly articles: readonly ContractArticleDto[];
  readonly parties: { readonly A: { readonly label: string; readonly name?: string }; readonly B: { readonly label: string; readonly name?: string } };
  readonly ourParty?: PartyKeyDto;
  readonly ourRole?: OurRoleDto;
  readonly counterpartyProfile: CounterpartyProfileDto;
  readonly contractNature?: { readonly value: ContractNatureDto; readonly quote?: string };
  readonly contractAmount?: number;
  readonly signingDateText?: string;
  readonly extraction?: ExtractionRecordDto;
  readonly clauses: readonly ClauseDto[];
  readonly status: ContractDocumentStatusDto;
  readonly reviewId?: string;
  readonly signedContractId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContractDocumentSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly status: ContractDocumentStatusDto;
  readonly sourceType: ContractSourceTypeDto;
  readonly fileName?: string;
  readonly pageCount?: number;
  readonly counterpartyName?: string;
  readonly ourRole?: OurRoleDto;
  readonly bodyLength: number;
  readonly clauseCount: number;
  readonly reviewId?: string;
  readonly signedContractId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ImportContractDocumentDto {
  readonly title: string;
  readonly body: string;
  readonly source: { readonly type: ContractSourceTypeDto; readonly fileName?: string; readonly pageCount?: number; readonly sha256?: string };
  readonly pages?: readonly ContractPageDto[];
  readonly parties?: { readonly A?: string; readonly B?: string };
  readonly ourParty?: PartyKeyDto;
  readonly ourRole?: OurRoleDto;
  readonly counterpartyProfile?: CounterpartyProfileDto;
  readonly contractNature?: ContractNatureDto;
  readonly contractAmount?: number;
  readonly playbookId?: string;
}

export interface TranscribeResultDto {
  readonly pages: readonly { readonly index: number; readonly text: string; readonly warnings: readonly string[] }[];
  readonly promptTemplateVersion: string;
  readonly model?: { readonly provider: string; readonly model: string };
}

export type ReasonDetailDto = Readonly<Record<string, string | number | boolean | null>>;

export interface ReasonDto {
  readonly code: string;
  readonly criterionId?: string;
  readonly topicId?: string;
  readonly detail?: ReasonDetailDto;
}

export interface CriterionResultDto {
  readonly criterionId: string;
  readonly outcome: 'pass' | 'fail' | 'unresolved' | 'not-applicable';
  readonly reasonCode?: string;
  readonly detail?: ReasonDetailDto;
  readonly llm?: { readonly answer: 'yes' | 'no' | 'unclear'; readonly evidenceQuote: string | null; readonly reasoning: string };
}

export interface TopicResultDto {
  readonly topicId: string;
  readonly topicLabel: string;
  readonly verdict: VerdictDto;
  readonly present: boolean;
  readonly reasons: readonly ReasonDto[];
  readonly criteria: readonly CriterionResultDto[];
  readonly recommendedTexts: readonly string[];
  readonly humanDecision?: HumanDecisionDto;
  readonly humanNote?: string;
}

export interface ContractReviewDto {
  readonly id: string;
  readonly documentId: string;
  readonly playbookId: string;
  readonly playbookName: string;
  readonly playbookSnapshot: Omit<PlaybookDto, 'createdAt'> & { readonly createdAt?: string };
  readonly playbookSnapshotAt: string;
  readonly results: readonly TopicResultDto[];
  readonly documentFindings: readonly ReasonDto[];
  readonly overall: VerdictDto;
  readonly status: 'draft' | 'finalized';
  readonly stale: boolean;
  readonly finalizedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewEnvelopeDto {
  readonly review: ContractReviewDto;
  /** 「審査基準との照合であり法的判断ではない」固定文言。 */
  readonly notice: string;
}

export interface DeadlineDto {
  readonly id: string;
  readonly kind: DeadlineKindDto;
  readonly dueDate: string;
  readonly basis: string;
  readonly termIndex?: number;
  readonly termEnd?: string;
  readonly status: 'open' | 'done' | 'superseded';
  readonly completedAt?: string;
  readonly note?: string;
}

export interface ContractWarningDto {
  readonly code?: string;
  readonly message: string;
}

export interface SignedClauseDto {
  readonly topicId: string;
  readonly topicLabel: string;
  readonly valueKind: ValueKindDto;
  readonly present: boolean;
  readonly articleRef?: string;
  readonly quote?: string;
  readonly quoteVerified: boolean;
  readonly value?: ClauseValueDto;
}

export interface SignedContractDto {
  readonly id: string;
  readonly documentId: string;
  readonly reviewId?: string;
  readonly title: string;
  readonly counterpartyName: string;
  readonly signedDate: string;
  readonly signingMethod: SigningMethodDto;
  readonly ourParty?: PartyKeyDto;
  readonly clauses: readonly SignedClauseDto[];
  readonly stampDuty?: { readonly documentTypeCode?: string; readonly amount?: number; readonly affixed: boolean | null };
  readonly deadlines: readonly DeadlineDto[];
  readonly status: SignedContractStatusDto;
  readonly terminatedAt?: string;
  readonly terminationReason?: string;
  readonly reviewVerdicts: Readonly<Record<string, VerdictDto>>;
  readonly warnings: readonly ContractWarningDto[];
  readonly displayStatus?: SignedContractStatusDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StampDutyCandidateDto {
  readonly code: 'stamp-duty-candidate' | 'stamp-duty-amount-unknown';
  readonly documentTypeCode: string;
  readonly name: string;
  readonly amount: number | null;
  readonly nature: ContractNatureDto;
  readonly electronic: boolean;
  readonly sourceUrl: string;
}

export interface DeadlinePreviewDto {
  readonly deadlines: readonly DeadlineDto[];
  readonly warnings: readonly ContractWarningDto[];
  readonly autoRenewal: boolean;
  readonly termEnd?: string;
  readonly stampDutyCandidates: readonly StampDutyCandidateDto[];
  readonly review: 'none' | 'draft' | 'finalized';
  readonly counterpartyName?: string;
}

export interface RegisterSignedContractDto {
  readonly documentId: string;
  readonly signedDate: string;
  readonly signingMethod: SigningMethodDto;
  readonly title?: string;
  readonly counterpartyName?: string;
  readonly stampDuty?: { readonly documentTypeCode?: string; readonly amount?: number; readonly affixed: boolean | null };
  readonly playbookId?: string;
}

export interface LedgerRowDto {
  readonly contractId: string;
  readonly title: string;
  readonly counterpartyName: string;
  readonly deadline: DeadlineDto;
  readonly daysLeft: number;
  readonly state: DeadlineStateDto;
  readonly autoRenewal: boolean;
  readonly contractStatus: SignedContractStatusDto;
}

export interface LedgerDto {
  readonly today: string;
  readonly dueSoonDays: number;
  readonly rows: readonly LedgerRowDto[];
}

export interface LedgerQueryDto {
  readonly withinDays?: number;
  readonly includeOverdue?: boolean;
  readonly kind?: DeadlineKindDto;
  readonly limit?: number;
}
