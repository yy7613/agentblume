/**
 * ドメイン: 取込んだ 1 証憑（JournalDocument）集約（docs/20 §2.1 / §2.2）。
 *
 * 帳票種別を問わず `facts`（正規化済み事実）を同じ形で持ち、判定（`judgment.ts`）はここだけを見る。
 * 証憑本体（画像 data URL / 原文テキスト / CSV 行）は `source` に同梱する（1 件 8 MiB 上限）。
 * 状態: `extracted` → `decided`（Stage 1 で確定）/ `undecided`（理由付き）→ `hearing` → `decided` / `skipped` / `exported`。
 *
 * 形は UI の `JournalDocumentDto` と同型（テナントスコープ `tenant` を除く）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { JournalDomainError } from './errors';
import type { JournalDocumentId, JournalEntryId, JournalHearingId, JournalRuleId } from './ids';

export const DOCUMENT_KINDS = [
  'invoice', 'simplified_invoice', 'receipt', 'delivery_note', 'quotation', 'bank_statement', 'card_statement',
  'expense_report', 'payslip', 'slip_transfer', 'slip_cash_in', 'slip_cash_out', 'other', 'unknown',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** 判定キューに乗せない種別（見積・納品は取引の確定前）。 */
export const NON_JUDGEABLE_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>(['quotation', 'delivery_note']);

export const DIRECTIONS = ['in', 'out'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const PAYMENT_METHODS = ['cash', 'credit_card', 'bank_transfer', 'qr', 'e_money', 'direct_debit', 'unknown'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVOICE_STATUSES = ['qualified', 'transitional', 'none', 'not_required'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const TAX_RATES = [10, 8, 0] as const;
export type TaxRate = (typeof TAX_RATES)[number];

export const DOCUMENT_SOURCE_TYPES = ['image', 'pdf', 'text', 'structured', 'csv-row'] as const;
export type DocumentSourceType = (typeof DOCUMENT_SOURCE_TYPES)[number];

export const EXTRACTION_METHODS = ['manual', 'llm', 'csv-preset', 'structured'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const DOCUMENT_STATUSES = ['extracted', 'decided', 'undecided', 'hearing', 'skipped', 'exported'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** 帳票固有の追加項目の値（JSON）。 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface TotalsByRate {
  readonly rate: TaxRate;
  readonly taxableAmount: number;
  readonly taxAmount?: number;
  readonly amountIncludesTax: boolean;
}

export interface DocumentLine {
  readonly description: string;
  readonly quantity?: number;
  readonly unitPrice?: number;
  readonly amount: number;
  readonly taxRate?: TaxRate;
  readonly reducedRateMark?: boolean;
}

/** 正規化済み事実。金額は税込整数（円）、日付は `YYYY-MM-DD`。無いものは undefined。 */
export interface DocumentFacts {
  readonly direction?: Direction;
  readonly issuerName?: string;
  readonly recipientName?: string;
  /** `T` + 13 桁に正規化済み。 */
  readonly registrationNumber?: string;
  readonly issueDate?: string;
  readonly transactionDate?: string;
  readonly dueDate?: string;
  readonly grandTotal?: number;
  readonly totalsByRate?: readonly TotalsByRate[];
  readonly lines?: readonly DocumentLine[];
  readonly paymentMethod?: PaymentMethod;
  /** 銀行口座 / カード名（CSV プリセット由来）。ルールの `scope.accountHints` に使う。 */
  readonly accountHint?: string;
  readonly description?: string;
  readonly descriptionNorm?: string;
  readonly counterpartyHint?: string;
  /** 帳票固有の追加項目。ヒアリングの回答もここに書き戻す。 */
  readonly extra?: { readonly [key: string]: JsonValue };
}

export interface JournalDocumentSource {
  readonly type: DocumentSourceType;
  readonly fileName?: string;
  readonly mime?: string;
  /** 画像（`data:image/...;base64,`）。`type: 'image'` のときだけ。 */
  readonly dataUrl?: string;
  readonly text?: string;
  readonly row?: { readonly [column: string]: string };
  readonly preset?: string;
}

export interface Extraction {
  readonly method: ExtractionMethod;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly confidence?: number;
  readonly warnings: readonly string[];
  readonly fieldEvidence?: { readonly [factPath: string]: { readonly sourceText?: string; readonly confidence: number } };
}

export interface RuleMatch {
  readonly ruleId: JournalRuleId;
  readonly ruleName: string;
  readonly mode: 'auto' | 'suggest';
  readonly priority: number;
  readonly specificity: number;
}

export type UndecidedReason =
  | { readonly code: 'no-rule' }
  | { readonly code: 'multiple-rules'; readonly ruleIds: readonly string[] }
  | { readonly code: 'missing-fact'; readonly ruleId: string; readonly facts: readonly string[] }
  | { readonly code: 'ask-if'; readonly ruleId: string; readonly questionId: string; readonly prompt: string }
  | { readonly code: 'rule-suggest-mode'; readonly ruleIds: readonly string[] }
  | { readonly code: 'unknown-account'; readonly ruleId: string; readonly accountIds: readonly string[] }
  | { readonly code: 'unbalanced'; readonly ruleId: string };

/** 文書に保存する直近の判定結果（純関数 `judgeDocument` の結果から仕訳草案を除き、時刻と entryId を足した形）。 */
export type StoredJudgment =
  | { readonly stage: 'decided'; readonly ruleId: string; readonly entryId?: string; readonly specificity: number; readonly candidates: readonly RuleMatch[]; readonly judgedAt: string }
  | { readonly stage: 'undecided'; readonly reasons: readonly UndecidedReason[]; readonly candidates: readonly RuleMatch[]; readonly judgedAt: string }
  | { readonly stage: 'skipped'; readonly reason: 'document-kind'; readonly judgedAt: string };

export interface JournalDocument {
  readonly tenant: TenantScope;
  readonly id: JournalDocumentId;
  readonly kind: DocumentKind;
  readonly source: JournalDocumentSource;
  readonly facts: DocumentFacts;
  readonly extraction: Extraction;
  readonly status: DocumentStatus;
  readonly judgment?: StoredJudgment;
  readonly entryId?: JournalEntryId;
  readonly hearingId?: JournalHearingId;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

/** 一覧用（画像 data URL を含まない）。UI の `JournalDocumentSummaryDto` と同型。 */
export interface JournalDocumentSummary {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  readonly sourceType: DocumentSourceType;
  readonly fileName?: string;
  readonly transactionDate?: string;
  readonly issuerName?: string;
  readonly description?: string;
  readonly grandTotal?: number;
  readonly direction?: Direction;
  readonly judgment?: StoredJudgment;
  readonly entryId?: string;
  readonly hearingId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateJournalDocumentProps {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly kind: DocumentKind;
  readonly source: JournalDocumentSource;
  readonly facts: DocumentFacts;
  readonly extraction?: Extraction;
  readonly status?: DocumentStatus;
  readonly judgment?: StoredJudgment;
  readonly entryId?: string;
  readonly hearingId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 証憑本体の上限（data URL / テキストの文字数）。 */
export const DOCUMENT_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const REGISTRATION_NUMBER_PATTERN = /^T\d{13}$/u;
const DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/u;

const fail: ErrorFactory = (message) => new JournalDomainError(message);

/** `YYYY-MM-DD` で実在する日付か。 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function assertIsoDate(value: unknown, label: string): asserts value is string {
  if (!isIsoDate(value)) throw fail(`${label} must be a date in YYYY-MM-DD`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw fail(`${label} must be an integer`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`${label} must be a number`);
  return value;
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  assertIsoDate(value, label);
  return value;
}

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** facts の不変条件を検証して防御的コピーを返す（保存前・判定前に共通で通す）。 */
export function validateDocumentFacts(value: DocumentFacts, label = 'createJournalDocument: facts'): DocumentFacts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  if (value.direction !== undefined && !DIRECTIONS.includes(value.direction)) throw fail(`${label}.direction must be one of ${DIRECTIONS.join(', ')}`);
  if (value.paymentMethod !== undefined && !PAYMENT_METHODS.includes(value.paymentMethod)) throw fail(`${label}.paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`);
  const registrationNumber = optionalString(value.registrationNumber, `${label}.registrationNumber`);
  if (registrationNumber !== undefined && !REGISTRATION_NUMBER_PATTERN.test(registrationNumber)) throw fail(`${label}.registrationNumber must be T followed by 13 digits`);

  let totalsByRate: readonly TotalsByRate[] | undefined;
  if (value.totalsByRate !== undefined) {
    if (!Array.isArray(value.totalsByRate)) throw fail(`${label}.totalsByRate must be an array`);
    totalsByRate = value.totalsByRate.map((entry, index) => {
      const entryLabel = `${label}.totalsByRate[${index}]`;
      if (entry === null || typeof entry !== 'object') throw fail(`${entryLabel} must be an object`);
      if (!TAX_RATES.includes(entry.rate)) throw fail(`${entryLabel}.rate must be one of ${TAX_RATES.join(', ')}`);
      if (!Number.isInteger(entry.taxableAmount)) throw fail(`${entryLabel}.taxableAmount must be an integer`);
      const taxAmount = optionalInteger(entry.taxAmount, `${entryLabel}.taxAmount`);
      if (typeof entry.amountIncludesTax !== 'boolean') throw fail(`${entryLabel}.amountIncludesTax must be a boolean`);
      return withDefined({ rate: entry.rate, taxableAmount: entry.taxableAmount, taxAmount, amountIncludesTax: entry.amountIncludesTax });
    });
  }

  let lines: readonly DocumentLine[] | undefined;
  if (value.lines !== undefined) {
    if (!Array.isArray(value.lines)) throw fail(`${label}.lines must be an array`);
    lines = value.lines.map((entry, index) => {
      const entryLabel = `${label}.lines[${index}]`;
      if (entry === null || typeof entry !== 'object') throw fail(`${entryLabel} must be an object`);
      if (typeof entry.description !== 'string') throw fail(`${entryLabel}.description must be a string`);
      if (!Number.isInteger(entry.amount)) throw fail(`${entryLabel}.amount must be an integer`);
      if (entry.taxRate !== undefined && !TAX_RATES.includes(entry.taxRate)) throw fail(`${entryLabel}.taxRate must be one of ${TAX_RATES.join(', ')}`);
      if (entry.reducedRateMark !== undefined && typeof entry.reducedRateMark !== 'boolean') throw fail(`${entryLabel}.reducedRateMark must be a boolean`);
      return withDefined({
        description: entry.description,
        quantity: optionalNumber(entry.quantity, `${entryLabel}.quantity`),
        unitPrice: optionalNumber(entry.unitPrice, `${entryLabel}.unitPrice`),
        amount: entry.amount,
        taxRate: entry.taxRate,
        reducedRateMark: entry.reducedRateMark,
      });
    });
  }

  let extra: DocumentFacts['extra'];
  if (value.extra !== undefined) {
    if (value.extra === null || typeof value.extra !== 'object' || Array.isArray(value.extra) || !isJsonValue(value.extra)) throw fail(`${label}.extra must be a JSON object`);
    extra = structuredClone(value.extra);
  }

  return withDefined({
    direction: value.direction,
    issuerName: optionalString(value.issuerName, `${label}.issuerName`),
    recipientName: optionalString(value.recipientName, `${label}.recipientName`),
    registrationNumber,
    issueDate: optionalDate(value.issueDate, `${label}.issueDate`),
    transactionDate: optionalDate(value.transactionDate, `${label}.transactionDate`),
    dueDate: optionalDate(value.dueDate, `${label}.dueDate`),
    grandTotal: optionalInteger(value.grandTotal, `${label}.grandTotal`),
    totalsByRate,
    lines,
    paymentMethod: value.paymentMethod,
    accountHint: optionalString(value.accountHint, `${label}.accountHint`),
    description: optionalString(value.description, `${label}.description`),
    descriptionNorm: optionalString(value.descriptionNorm, `${label}.descriptionNorm`),
    counterpartyHint: optionalString(value.counterpartyHint, `${label}.counterpartyHint`),
    extra,
  });
}

function validateSource(value: JournalDocumentSource): JournalDocumentSource {
  const label = 'createJournalDocument: source';
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  if (!DOCUMENT_SOURCE_TYPES.includes(value.type)) throw fail(`${label}.type must be one of ${DOCUMENT_SOURCE_TYPES.join(', ')}`);
  const dataUrl = optionalString(value.dataUrl, `${label}.dataUrl`);
  if (dataUrl !== undefined) {
    if (value.type !== 'image') throw fail(`${label}.dataUrl is only allowed for type 'image'`);
    if (dataUrl.length > DOCUMENT_PAYLOAD_MAX_BYTES) throw fail(`${label}.dataUrl must be at most ${DOCUMENT_PAYLOAD_MAX_BYTES} bytes`);
    if (!DATA_URL_PATTERN.test(dataUrl)) throw fail(`${label}.dataUrl must be a base64 data URL of image/png, image/jpeg, image/webp or image/gif`);
  }
  const text = optionalString(value.text, `${label}.text`);
  if (text !== undefined && text.length > DOCUMENT_PAYLOAD_MAX_BYTES) throw fail(`${label}.text must be at most ${DOCUMENT_PAYLOAD_MAX_BYTES} characters`);
  let row: JournalDocumentSource['row'];
  if (value.row !== undefined) {
    if (value.row === null || typeof value.row !== 'object' || Array.isArray(value.row) || Object.values(value.row).some((cell) => typeof cell !== 'string')) throw fail(`${label}.row must be an object of strings`);
    row = { ...value.row };
  }
  return withDefined({
    type: value.type,
    fileName: optionalString(value.fileName, `${label}.fileName`),
    mime: optionalString(value.mime, `${label}.mime`),
    dataUrl,
    text,
    row,
    preset: optionalString(value.preset, `${label}.preset`),
  });
}

export const DEFAULT_EXTRACTION: Extraction = { method: 'manual', warnings: [] };

function validateExtraction(value: Extraction): Extraction {
  const label = 'createJournalDocument: extraction';
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  if (!EXTRACTION_METHODS.includes(value.method)) throw fail(`${label}.method must be one of ${EXTRACTION_METHODS.join(', ')}`);
  const confidence = optionalNumber(value.confidence, `${label}.confidence`);
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) throw fail(`${label}.confidence must be between 0 and 1`);
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) throw fail(`${label}.warnings must be an array of strings`);
  let model: Extraction['model'];
  if (value.model !== undefined) {
    if (value.model === null || typeof value.model !== 'object' || typeof value.model.provider !== 'string' || typeof value.model.model !== 'string') throw fail(`${label}.model must be { provider, model }`);
    model = { provider: value.model.provider, model: value.model.model };
  }
  let fieldEvidence: Extraction['fieldEvidence'];
  if (value.fieldEvidence !== undefined) {
    if (value.fieldEvidence === null || typeof value.fieldEvidence !== 'object' || Array.isArray(value.fieldEvidence)) throw fail(`${label}.fieldEvidence must be an object`);
    fieldEvidence = Object.fromEntries(Object.entries(value.fieldEvidence).map(([path, evidence]) => {
      if (evidence === null || typeof evidence !== 'object' || typeof evidence.confidence !== 'number' || evidence.confidence < 0 || evidence.confidence > 1) throw fail(`${label}.fieldEvidence['${path}'].confidence must be between 0 and 1`);
      const sourceText = optionalString(evidence.sourceText, `${label}.fieldEvidence['${path}'].sourceText`);
      return [path, withDefined({ sourceText, confidence: evidence.confidence })];
    }));
  }
  return withDefined({ method: value.method, model, confidence, warnings: [...value.warnings], fieldEvidence });
}

function validateStoredJudgment(value: StoredJudgment): StoredJudgment {
  const label = 'createJournalDocument: judgment';
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  assertIsoDateTime(value.judgedAt, `${label}.judgedAt`, fail);
  if (value.stage === 'skipped') {
    if (value.reason !== 'document-kind') throw fail(`${label}.reason must be 'document-kind'`);
    return { stage: 'skipped', reason: 'document-kind', judgedAt: value.judgedAt };
  }
  if (value.stage !== 'decided' && value.stage !== 'undecided') throw fail(`${label}.stage must be decided, undecided or skipped`);
  if (!Array.isArray(value.candidates)) throw fail(`${label}.candidates must be an array`);
  const candidates = value.candidates.map((candidate) => ({ ...candidate }));
  if (value.stage === 'decided') {
    assertNonEmpty(value.ruleId, `${label}.ruleId`, fail);
    if (typeof value.specificity !== 'number') throw fail(`${label}.specificity must be a number`);
    return withDefined({ stage: 'decided' as const, ruleId: value.ruleId, entryId: optionalString(value.entryId, `${label}.entryId`), specificity: value.specificity, candidates, judgedAt: value.judgedAt });
  }
  if (!Array.isArray(value.reasons)) throw fail(`${label}.reasons must be an array`);
  return { stage: 'undecided', reasons: structuredClone(value.reasons), candidates, judgedAt: value.judgedAt };
}

/** 文書を組み立てて不変条件を検証する。`id` が無いときは `makeId` で生成する。 */
export function createJournalDocument(props: CreateJournalDocumentProps, makeId?: () => string): JournalDocument {
  if (props === null || typeof props !== 'object') throw fail('createJournalDocument: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('createJournalDocument: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'createJournalDocument: tenant.tenantId', fail);
  assertNonEmpty(props.tenant.workspaceId, 'createJournalDocument: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createJournalDocument: id', fail);
  if (!DOCUMENT_KINDS.includes(props.kind)) throw fail(`createJournalDocument: kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
  const status = props.status ?? 'extracted';
  if (!DOCUMENT_STATUSES.includes(status)) throw fail(`createJournalDocument: status must be one of ${DOCUMENT_STATUSES.join(', ')}`);
  assertIsoDateTime(props.createdAt, 'createJournalDocument: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createJournalDocument: updatedAt', fail);
  const entryId = optionalString(props.entryId, 'createJournalDocument: entryId');
  const hearingId = optionalString(props.hearingId, 'createJournalDocument: hearingId');
  if (status === 'decided' && entryId === undefined) throw fail('createJournalDocument: a decided document must have an entryId');

  return withDefined({
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    kind: props.kind,
    source: validateSource(props.source),
    facts: validateDocumentFacts(props.facts),
    extraction: validateExtraction(props.extraction ?? DEFAULT_EXTRACTION),
    status,
    judgment: props.judgment === undefined ? undefined : validateStoredJudgment(props.judgment),
    entryId,
    hearingId,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
}

/** 判定結果を反映する。decided は entryId 必須。undecided / skipped は entryId を外す（前回の草案は使わない）。 */
export function withJudgment(document: JournalDocument, judgment: StoredJudgment, at: string): JournalDocument {
  assertIsoDateTime(at, 'withJudgment: at', fail);
  if (document.status === 'exported') throw fail('withJudgment: an exported document cannot be re-judged');
  const { entryId: _entryId, ...rest } = document;
  if (judgment.stage === 'decided') {
    assertNonEmpty(judgment.entryId, 'withJudgment: judgment.entryId', fail);
    return { ...rest, status: 'decided', judgment: validateStoredJudgment(judgment), entryId: judgment.entryId, updatedAt: at };
  }
  return { ...rest, status: judgment.stage === 'skipped' ? 'skipped' : 'undecided', judgment: validateStoredJudgment(judgment), updatedAt: at };
}

/** ヒアリング開始を反映する（`hearing` 状態へ）。 */
export function withHearing(document: JournalDocument, hearingId: string, at: string): JournalDocument {
  assertNonEmpty(hearingId, 'withHearing: hearingId', fail);
  assertIsoDateTime(at, 'withHearing: at', fail);
  if (document.status === 'exported' || document.status === 'skipped') throw fail(`withHearing: a ${document.status} document cannot start a hearing`);
  return { ...document, status: 'hearing', hearingId, updatedAt: at };
}

/** 仕訳を CSV へ出したことを反映する（`decided` からのみ）。 */
export function markDocumentExported(document: JournalDocument, at: string): JournalDocument {
  assertIsoDateTime(at, 'markDocumentExported: at', fail);
  if (document.status === 'exported') return document;
  if (document.status !== 'decided') throw fail(`markDocumentExported: only a decided document can be exported (status: ${document.status})`);
  return { ...document, status: 'exported', updatedAt: at };
}

/** 判定をやり直す前に判定結果と仕訳参照を外す（`extracted` へ戻す）。仕訳を削除したときに使う。 */
export function clearJudgment(document: JournalDocument, at: string): JournalDocument {
  assertIsoDateTime(at, 'clearJudgment: at', fail);
  const { judgment: _judgment, entryId: _entryId, ...rest } = document;
  return { ...rest, status: 'extracted', updatedAt: at };
}

/** 一覧用の要約（data URL・原文・CSV 行を含まない）。 */
export function toJournalDocumentSummary(document: JournalDocument): JournalDocumentSummary {
  return withDefined({
    id: document.id,
    kind: document.kind,
    status: document.status,
    sourceType: document.source.type,
    fileName: document.source.fileName,
    transactionDate: document.facts.transactionDate ?? document.facts.issueDate,
    issuerName: document.facts.issuerName ?? document.facts.counterpartyHint,
    description: document.facts.description,
    grandTotal: document.facts.grandTotal,
    direction: document.facts.direction,
    judgment: document.judgment === undefined ? undefined : structuredClone(document.judgment),
    entryId: document.entryId,
    hearingId: document.hearingId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
}
