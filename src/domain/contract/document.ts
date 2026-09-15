/**
 * ドメイン: 取込んだ契約書 1 通（ContractDocument）の集約と状態遷移（docs/23 §2.5）。
 *
 * - 本文は原文のまま（NFKC はかけない）。上限 300,000 文字（A4 約 150 ページ相当）。
 * - PDF・画像の原本は保存しない（本文テキストとハッシュだけ）。
 * - 抽出結果は仕訳と違い**保存する**（長文の抽出は数分かかり、再読み込みで失うと時間が大きく失われる）。
 *   `confirmed` までは下書き扱い。
 * - `signed` の文書は本文・条項を変更できない（台帳の根拠が変わるため。直すときは締結済み契約側）。
 *
 * ```
 * imported → extracted（抽出）→ confirmed（人が確定）→ reviewed（判定の確定）→ signed（締結登録）
 * 本文を直すと imported へ戻り、抽出とレビューを破棄する。条項を直すと confirmed へ戻る。
 * ```
 */
import type { TenantScope } from '../shared/tenant-scope';
import { clauseValueProblem, type ClauseValue } from './clause-value';
import { ContractDomainError, ContractStateError } from './errors';
import type { ContractDocumentId } from './ids';
import { isReasonCode, type ReasonCode } from './reasons';
import type { ContractArticle, ContractPage } from './segmentation';
import { CONTRACT_NATURES, isOneOf, OUR_ROLES, PARTY_KEYS, PROFILE_ANSWERS, type ContractNature, type OurRole, type PartyKey, type ProfileAnswer } from './vocabulary';

export const BODY_MAX_CHARS = 300_000;
export const MAX_PAGES = 500;

export const CONTRACT_DOCUMENT_STATUSES = ['imported', 'extracted', 'confirmed', 'reviewed', 'signed'] as const;
export type ContractDocumentStatus = (typeof CONTRACT_DOCUMENT_STATUSES)[number];

export const CONTRACT_SOURCE_TYPES = ['text', 'pdf-text', 'image-ocr', 'pdf-ocr'] as const;
export type ContractSourceType = (typeof CONTRACT_SOURCE_TYPES)[number];

export interface ContractSource {
  readonly type: ContractSourceType;
  readonly fileName?: string;
  readonly pageCount?: number;
  readonly sha256?: string;
}

export interface Party { readonly label: string; readonly name?: string }
export interface Parties { readonly A: Party; readonly B: Party }

export interface Evidence {
  readonly quote: string;
  readonly start?: number;
  readonly end?: number;
  readonly verified: boolean;
}

/**
 * 条項の警告。`code` があれば理由コード（判定と画面の 3 点セットに使う）、無ければ補足の説明
 * （例: 期間の条文にあるのに値に使われていない日付表現の列挙）。
 */
export interface ClauseWarning {
  readonly code?: ReasonCode;
  readonly message: string;
  /** 付けた処理。`consistency` の警告は突き合わせのたびに付け直す。 */
  readonly origin: 'extraction' | 'consistency' | 'manual';
  /** 期限の突き合わせの差（日）。 */
  readonly days?: number;
}

/** 同じトピックに食い違う条文が複数あったときの候補（人が採用を選ぶ）。 */
export interface ClauseCandidate {
  readonly articleRef?: string;
  readonly evidence: readonly Evidence[];
  readonly value?: ClauseValue;
}

export interface Clause {
  readonly topicId: string;
  readonly present: boolean;
  readonly articleRef?: string;
  readonly evidence: readonly Evidence[];
  readonly value?: ClauseValue;
  readonly confidence?: number;
  readonly source: 'llm' | 'manual';
  readonly warnings: readonly ClauseWarning[];
  readonly candidates?: readonly ClauseCandidate[];
}

export interface ExtractionChunk {
  readonly index: number;
  readonly articleRefs: readonly string[];
  readonly topicIds: readonly string[];
  readonly status: 'ok' | 'failed';
  readonly error?: string;
}

export interface ExtractionRecord {
  /** 抽出に使った審査基準（条項の確定・レビューの既定に使う）。 */
  readonly playbookId?: string;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly promptTemplateVersion: string;
  readonly chunks: readonly ExtractionChunk[];
  readonly warnings: readonly string[];
  /** キーワードに当たらず読まなかった条文。 */
  readonly unscannedArticleRefs: readonly string[];
  readonly scanAllArticles: boolean;
  readonly extractedAt: string;
}

export interface CounterpartyProfileDeclaration {
  readonly toriteki: ProfileAnswer;
  readonly freelance: ProfileAnswer;
}

export interface ContractDocument {
  readonly tenant: TenantScope;
  readonly id: ContractDocumentId;
  readonly title: string;
  readonly source: ContractSource;
  readonly body: string;
  readonly pages: readonly ContractPage[];
  readonly articles: readonly ContractArticle[];
  readonly parties: Parties;
  readonly ourParty?: PartyKey;
  readonly ourRole?: OurRole;
  readonly counterpartyProfile: CounterpartyProfileDeclaration;
  readonly contractNature?: { readonly value: ContractNature; readonly quote?: string };
  /** 契約金額（円）。印紙税の候補に使う。利用者が入力する（抽出の対象ではない）。 */
  readonly contractAmount?: number;
  readonly signingDateText?: string;
  readonly extraction?: ExtractionRecord;
  readonly clauses: readonly Clause[];
  readonly status: ContractDocumentStatus;
  readonly reviewId?: string;
  readonly signedContractId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateContractDocumentProps = ContractDocument;

export interface ContractDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly status: ContractDocumentStatus;
  readonly sourceType: ContractSourceType;
  readonly fileName?: string;
  readonly pageCount?: number;
  /** 同じファイルの二重取込の警告に使う。 */
  readonly sha256?: string;
  readonly counterpartyName?: string;
  readonly ourRole?: OurRole;
  readonly bodyLength: number;
  readonly clauseCount: number;
  readonly reviewId?: string;
  readonly signedContractId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function fail(message: string): never {
  throw new ContractDomainError(`createContractDocument: ${message}`);
}

function validateEvidence(evidence: readonly Evidence[], label: string, bodyLength: number): readonly Evidence[] {
  if (!Array.isArray(evidence) || evidence.length > 20) fail(`${label} must be an array of at most 20 quotes`);
  return evidence.map((entry, index) => {
    const at = `${label}[${index}]`;
    if (typeof entry?.quote !== 'string' || entry.quote.trim() === '' || entry.quote.length > 2000) fail(`${at}.quote must be a non-empty string of at most 2000 characters`);
    if (typeof entry.verified !== 'boolean') fail(`${at}.verified must be a boolean`);
    const hasRange = entry.start !== undefined || entry.end !== undefined;
    if (hasRange && !(Number.isInteger(entry.start) && Number.isInteger(entry.end) && entry.start! >= 0 && entry.start! < entry.end! && entry.end! <= bodyLength)) fail(`${at} has a position outside the body`);
    return { quote: entry.quote, ...(hasRange ? { start: entry.start!, end: entry.end! } : {}), verified: entry.verified };
  });
}

function validateValue(value: ClauseValue | undefined, label: string): ClauseValue | undefined {
  if (value === undefined) return undefined;
  const problem = clauseValueProblem(value);
  if (problem !== undefined) fail(`${label}: ${problem}`);
  return structuredClone(value);
}

export function validateClause(clause: Clause, index: number, bodyLength: number): Clause {
  const label = `clauses[${index}]`;
  if (typeof clause?.topicId !== 'string' || clause.topicId === '') fail(`${label}.topicId is required`);
  if (typeof clause.present !== 'boolean') fail(`${label}.present must be a boolean`);
  if (clause.source !== 'llm' && clause.source !== 'manual') fail(`${label}.source must be llm or manual`);
  if (!Array.isArray(clause.warnings)) fail(`${label}.warnings must be an array`);
  if (clause.confidence !== undefined && !(typeof clause.confidence === 'number' && clause.confidence >= 0 && clause.confidence <= 1)) fail(`${label}.confidence must be between 0 and 1`);
  return {
    topicId: clause.topicId,
    present: clause.present,
    ...(clause.articleRef === undefined || clause.articleRef === '' ? {} : { articleRef: String(clause.articleRef).slice(0, 100) }),
    evidence: validateEvidence(clause.evidence, `${label}.evidence`, bodyLength),
    ...(clause.value === undefined ? {} : { value: validateValue(clause.value, `${label}.value`)! }),
    ...(clause.confidence === undefined ? {} : { confidence: clause.confidence }),
    source: clause.source,
    warnings: clause.warnings.map((warning, warningIndex) => {
      if (typeof warning?.message !== 'string') fail(`${label}.warnings[${warningIndex}].message must be a string`);
      if (warning.code !== undefined && !isReasonCode(warning.code)) fail(`${label}.warnings[${warningIndex}].code is not a reason code: ${String(warning.code)}`);
      if (warning.origin !== 'extraction' && warning.origin !== 'consistency' && warning.origin !== 'manual') fail(`${label}.warnings[${warningIndex}].origin is invalid`);
      return { ...(warning.code === undefined ? {} : { code: warning.code }), message: warning.message, origin: warning.origin, ...(typeof warning.days === 'number' ? { days: warning.days } : {}) };
    }),
    ...(clause.candidates === undefined ? {} : {
      candidates: clause.candidates.map((candidate, candidateIndex) => ({
        ...(candidate.articleRef === undefined ? {} : { articleRef: String(candidate.articleRef) }),
        evidence: validateEvidence(candidate.evidence, `${label}.candidates[${candidateIndex}].evidence`, bodyLength),
        ...(candidate.value === undefined ? {} : { value: validateValue(candidate.value, `${label}.candidates[${candidateIndex}].value`)! }),
      })),
    }),
  };
}

export function createContractDocument(props: CreateContractDocumentProps): ContractDocument {
  if (props === null || typeof props !== 'object') fail('props must be an object');
  if (typeof props.tenant?.tenantId !== 'string' || typeof props.tenant.workspaceId !== 'string') fail('tenant is required');
  if (typeof props.id !== 'string' || props.id === '') fail('id is required');
  if (typeof props.title !== 'string' || props.title.trim() === '' || props.title.length > 200) fail('title must be a non-empty string of at most 200 characters');
  if (typeof props.body !== 'string' || props.body.trim() === '') fail('body must not be empty');
  if (props.body.length > BODY_MAX_CHARS) fail(`body must be at most ${BODY_MAX_CHARS} characters (received ${props.body.length}); split the appendices and import them separately`);
  if (!isOneOf(CONTRACT_SOURCE_TYPES, props.source?.type)) fail(`source.type must be one of ${CONTRACT_SOURCE_TYPES.join(', ')}`);
  if (props.source.pageCount !== undefined && !(Number.isInteger(props.source.pageCount) && props.source.pageCount >= 1 && props.source.pageCount <= MAX_PAGES)) fail(`source.pageCount must be between 1 and ${MAX_PAGES}`);
  if (!Array.isArray(props.pages) || props.pages.length === 0 || props.pages.length > MAX_PAGES) fail(`pages must have 1 to ${MAX_PAGES} entries`);
  const bodyLength = props.body.length;
  props.pages.forEach((page, index) => {
    if (!(Number.isInteger(page?.page) && Number.isInteger(page.start) && Number.isInteger(page.end) && page.start >= 0 && page.start <= page.end && page.end <= bodyLength)) fail(`pages[${index}] has a range outside the body`);
    if (page.method !== 'text-layer' && page.method !== 'vision') fail(`pages[${index}].method must be text-layer or vision`);
  });
  if (!Array.isArray(props.articles)) fail('articles must be an array');
  props.articles.forEach((article, index) => {
    if (typeof article?.ref !== 'string' || !(Number.isInteger(article.start) && Number.isInteger(article.end) && article.start >= 0 && article.start < article.end && article.end <= bodyLength)) fail(`articles[${index}] has a range outside the body`);
  });
  if (props.ourParty !== undefined && !isOneOf(PARTY_KEYS, props.ourParty)) fail('ourParty must be A or B');
  if (props.ourRole !== undefined && !isOneOf(OUR_ROLES, props.ourRole)) fail('ourRole must be client, vendor or mutual');
  if (!isOneOf(PROFILE_ANSWERS, props.counterpartyProfile?.toriteki) || !isOneOf(PROFILE_ANSWERS, props.counterpartyProfile.freelance)) fail('counterpartyProfile.toriteki / freelance must be yes, no or unknown');
  if (props.contractNature !== undefined && !isOneOf(CONTRACT_NATURES, props.contractNature.value)) fail(`contractNature.value must be one of ${CONTRACT_NATURES.join(', ')}`);
  if (props.contractAmount !== undefined && !(Number.isInteger(props.contractAmount) && props.contractAmount >= 0)) fail('contractAmount must be a non-negative integer (JPY)');
  if (!isOneOf(CONTRACT_DOCUMENT_STATUSES, props.status)) fail(`status must be one of ${CONTRACT_DOCUMENT_STATUSES.join(', ')}`);
  if (!Array.isArray(props.clauses)) fail('clauses must be an array');
  const clauses = props.clauses.map((clause, index) => validateClause(clause, index, bodyLength));
  const topicIds = new Set<string>();
  for (const clause of clauses) {
    if (topicIds.has(clause.topicId)) fail(`clauses has the clause type "${clause.topicId}" twice; pick one of the candidates instead`);
    topicIds.add(clause.topicId);
  }
  if (props.status === 'signed' && props.signedContractId === undefined) fail('a signed document needs signedContractId');
  const party = (value: Party | undefined, fallback: string): Party => ({ label: typeof value?.label === 'string' && value.label !== '' ? value.label : fallback, ...(typeof value?.name === 'string' && value.name.trim() !== '' ? { name: value.name.trim().slice(0, 200) } : {}) });
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id: props.id,
    title: props.title.trim(),
    source: {
      type: props.source.type,
      ...(props.source.fileName === undefined ? {} : { fileName: String(props.source.fileName).slice(0, 200) }),
      ...(props.source.pageCount === undefined ? {} : { pageCount: props.source.pageCount }),
      ...(props.source.sha256 === undefined ? {} : { sha256: String(props.source.sha256) }),
    },
    body: props.body,
    pages: props.pages.map((page) => ({ page: page.page, start: page.start, end: page.end, method: page.method, warnings: Array.isArray(page.warnings) ? page.warnings.map(String) : [] })),
    articles: props.articles.map((article) => ({ ref: article.ref, ...(article.heading === undefined ? {} : { heading: article.heading }), start: article.start, end: article.end, page: article.page })),
    parties: { A: party(props.parties?.A, '甲'), B: party(props.parties?.B, '乙') },
    ...(props.ourParty === undefined ? {} : { ourParty: props.ourParty }),
    ...(props.ourRole === undefined ? {} : { ourRole: props.ourRole }),
    counterpartyProfile: { toriteki: props.counterpartyProfile.toriteki, freelance: props.counterpartyProfile.freelance },
    ...(props.contractNature === undefined ? {} : { contractNature: { value: props.contractNature.value, ...(props.contractNature.quote === undefined ? {} : { quote: props.contractNature.quote }) } }),
    ...(props.contractAmount === undefined ? {} : { contractAmount: props.contractAmount }),
    ...(props.signingDateText === undefined ? {} : { signingDateText: props.signingDateText }),
    ...(props.extraction === undefined ? {} : { extraction: structuredClone(props.extraction) }),
    clauses,
    status: props.status,
    ...(props.reviewId === undefined ? {} : { reviewId: props.reviewId }),
    ...(props.signedContractId === undefined ? {} : { signedContractId: props.signedContractId }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/** 自社側の名前（前文の当事者名）。 */
export function ourNameOf(document: Pick<ContractDocument, 'parties' | 'ourParty'>): string | undefined {
  return document.ourParty === undefined ? undefined : document.parties[document.ourParty].name;
}

/** 相手方の名前。自社が未設定なら undefined（どちらが相手か分からない）。 */
export function counterpartyNameOf(document: Pick<ContractDocument, 'parties' | 'ourParty'>): string | undefined {
  if (document.ourParty === undefined) return undefined;
  return document.parties[document.ourParty === 'A' ? 'B' : 'A'].name;
}

export function toContractDocumentSummary(document: ContractDocument): ContractDocumentSummary {
  const counterparty = counterpartyNameOf(document);
  return {
    id: document.id, title: document.title, status: document.status, sourceType: document.source.type,
    ...(document.source.fileName === undefined ? {} : { fileName: document.source.fileName }),
    ...(document.source.pageCount === undefined ? {} : { pageCount: document.source.pageCount }),
    ...(document.source.sha256 === undefined ? {} : { sha256: document.source.sha256 }),
    ...(counterparty === undefined ? {} : { counterpartyName: counterparty }),
    ...(document.ourRole === undefined ? {} : { ourRole: document.ourRole }),
    bodyLength: document.body.length,
    clauseCount: document.clauses.filter((clause) => clause.present).length,
    ...(document.reviewId === undefined ? {} : { reviewId: document.reviewId }),
    ...(document.signedContractId === undefined ? {} : { signedContractId: document.signedContractId }),
    createdAt: document.createdAt, updatedAt: document.updatedAt,
  };
}

/** 締結済みの文書は本文・条項を変えられない。 */
export function assertNotSigned(document: ContractDocument, action: string): void {
  if (document.status === 'signed') {
    throw new ContractStateError(`the contract document "${document.id}" is already registered as signed, so it cannot ${action}; edit the clauses of the signed contract instead`, { documentId: document.id, ...(document.signedContractId === undefined ? {} : { contractId: document.signedContractId }) });
  }
}

/**
 * 条項の根拠となる条文。`articleRef`（「第12条第2項」）を条文の `ref`（「第12条」）へ最長一致で当て、
 * 当たらなければ根拠の位置を含む条文、それも無ければ undefined。
 */
export function articleForClause(document: Pick<ContractDocument, 'articles'>, clause: Pick<Clause, 'articleRef' | 'evidence'>): ContractArticle | undefined {
  const ref = clause.articleRef;
  if (ref !== undefined) {
    const matches = document.articles.filter((article) => ref === article.ref || (ref.startsWith(article.ref) && !/[0-9の]/u.test(ref.charAt(article.ref.length))));
    const longest = matches.sort((left, right) => right.ref.length - left.ref.length)[0];
    if (longest !== undefined) return longest;
  }
  const position = clause.evidence.find((entry) => entry.start !== undefined)?.start;
  return position === undefined ? undefined : document.articles.find((article) => position >= article.start && position < article.end);
}
