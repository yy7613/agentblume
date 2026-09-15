/**
 * ドメイン: 経費の申請（ExpenseClaim）集約と状態遷移（docs/21 §2.2 / §2.3 / §2.5 / §20.2.3 / §20.2.12）。
 *
 * 状態: `draft` → `checked`（チェック）→ `approved`（承認）→ `settled`（精算済み）。`checked` から `returned`（差し戻し）。
 * 2 段以上の承認経路では `checked` → `in-approval`（1 段目を承認）→ `approved`（最後の段を承認）。
 * 遷移はすべて純粋関数で新しい値を返し、拒否は `ExpenseTransitionError`（409）。形の不正は `ExpenseDomainError`（400）。
 *
 * 判定の古さ（`isJudgmentStale`）は「規程の updatedAt が変わった」か「明細・申請者・期間・仮払の指紋が変わった」で検出する。
 * 指紋は domain で計算できる安定な文字列連結のハッシュ（domain は `node:crypto` を使わない）。
 * 指紋は `claimant.employeeId` / `departmentId` と未定義の項目を含めない（既存の判定を読み込みや紐付けで古くしない。§20.2.13）。
 *
 * 形は UI の DTO と同型（テナントスコープ `tenant` を除く）。実用化の項目はすべて省略可で、無ければ書かない
 * （MVP で保存した record_json の再直列化がバイト同一になる）。
 */
import { isIsoDate } from '../journal/document';
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { currentApprovalStep, flowFromPlan, isMvpApprovalPlan, validateApprovalFlow, type ApprovalDecision, type ApprovalFlow, type ApprovalPlan } from './approval';
import { daysBetween } from './business-date';
import { validateDetailRecord, validateExtractionFlags, type ExpenseDetailRecord, type ExtractionFlag } from './detail-read';
import { ExpenseDomainError, ExpenseItemNotFoundError, ExpenseTransitionError, type ExpenseBlockingReason } from './errors';
import type { ExpenseAdvanceId, ExpenseClaimId, ExpenseItemId, ExpenseReceiptId } from './ids';
import { allReasons, reasonKey, validateStoredJudgment, type CheckReason, type StoredClaimJudgment, type Verdict } from './judgment';
import type { ExpensePolicy } from './policy';
import { isReasonCode, REASON_CODES, type ExpenseReasonCode, type Severity } from './reason-codes';
import { usableAmount, validateReceiptFacts, type ReceiptFacts } from './receipt-facts';

export const CLAIM_STATUSES = ['draft', 'checked', 'in-approval', 'returned', 'approved', 'settled'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const ITEM_SOURCE_TYPES = ['image', 'pdf', 'manual', 'csv-row'] as const;
export type ItemSourceType = (typeof ITEM_SOURCE_TYPES)[number];
export const ITEM_EXTRACTION_METHODS = ['llm', 'manual', 'csv'] as const;
export type ItemExtractionMethod = (typeof ITEM_EXTRACTION_METHODS)[number];
export const HISTORY_TYPES = [
  'created', 'edited', 'checked', 'acknowledged', 'returned', 'approved', 'unapproved', 'settled', 'journal-drafted',
  'approval-step', 'employee-linked', 'advance-linked', 'advance-unlinked', 'payout-exported', 'payout-cancelled',
] as const;
export type ClaimHistoryType = (typeof HISTORY_TYPES)[number];

export const CLAIM_MAX_ITEMS = 100;
export const CLAIM_MAX_HISTORY = 200;
export const CLAIM_MAX_PERIOD_DAYS = 366;
export const ACKNOWLEDGEMENT_NOTE_MAX = 500;
export const RETURN_MESSAGE_MAX = 4000;
export const CLAIM_TITLE_MAX = 200;
export const CLAIMANT_TEXT_MAX = 100;

export interface Claimant {
  /** 表示用の写し（従業員マスタに紐付けたら、紐付け時点の氏名）。 */
  readonly name: string;
  readonly employeeCode?: string;
  readonly department?: string;
  /** 従業員マスタへの参照（§20.2.3）。指紋に含めない。 */
  readonly employeeId?: string;
  /** 紐付け時点の部門 id の写し。指紋に含めない。 */
  readonly departmentId?: string;
}

export interface ClaimPeriod {
  readonly from: string;
  readonly to: string;
}

export interface ItemSource {
  readonly type: ItemSourceType;
  readonly fileName?: string;
  /** CSV の生値（列名 → 値）。 */
  readonly row?: { readonly [column: string]: string };
}

export interface ItemExtraction {
  readonly method: ItemExtractionMethod;
  readonly model?: { readonly provider: string; readonly model: string };
  readonly confidence?: number;
  /** 読取・取込の注意点（値は自動で補正せず、ここに理由を残して人に見せる）。 */
  readonly warnings: readonly string[];
  /** 読取時の仕訳 `DocumentKind` の写し。 */
  readonly documentKind?: string;
  /** 形の合わない登録番号の生の文字列。 */
  readonly rejectedRegistrationNumber?: string;
  /** 構造化した読取の印（UC7。空なら書かない）。判定は印だけを見る。 */
  readonly flags?: readonly ExtractionFlag[];
  /** 経費専用の追加読取の記録（監査・再表示用）。 */
  readonly detail?: ExpenseDetailRecord;
}

export interface ExpenseItem {
  readonly id: ExpenseItemId;
  readonly categoryId?: string;
  /** 費目を解決できなかったときの取込時の文字列。 */
  readonly categoryText?: string;
  readonly facts: ReceiptFacts;
  readonly receiptId?: ExpenseReceiptId;
  readonly source: ItemSource;
  readonly extraction: ItemExtraction;
  /** 取り込んだ日（業務のタイムゾーン）。提出期限 `submission-late` の起点。 */
  readonly addedOn?: string;
}

export interface Acknowledgement {
  readonly itemId?: string;
  readonly code: ExpenseReasonCode;
  readonly note: string;
  readonly by: string;
  readonly at: IsoDateTime;
}

export interface ReturnNote {
  readonly message: string;
  /** その時点の理由の写し。 */
  readonly reasons: readonly { readonly code: ExpenseReasonCode; readonly itemId?: string; readonly severity: Severity }[];
  readonly by: string;
  readonly at: IsoDateTime;
}

export interface Approval {
  readonly by: string;
  readonly displayName?: string;
  readonly at: IsoDateTime;
  readonly comment?: string;
}

export interface Settlement {
  readonly settledAt: IsoDateTime;
  readonly by: string;
  readonly exportFileName?: string;
}

export interface JournalLink {
  readonly entries: readonly { readonly itemId: string; readonly entryId: string }[];
  /** 全明細の下書きがそろったか（途中で拒否されたら false。「続きを作成」で残りだけ作る）。 */
  readonly complete: boolean;
  readonly draftedAt: IsoDateTime;
  readonly by: string;
  readonly warnings: readonly string[];
}

/** 取消されていない振込バッチに入っている印（二重の振込を防ぐ。§20.2.3）。 */
export interface ClaimPayoutMark {
  readonly batchId: string;
  readonly exportedAt: IsoDateTime;
}

export interface ClaimHistoryEvent {
  readonly type: ClaimHistoryType;
  readonly by?: string;
  readonly at: IsoDateTime;
  readonly note?: string;
  /** 代理承認の印。 */
  readonly proxy?: boolean;
}

export interface ExpenseClaim {
  readonly tenant: TenantScope;
  readonly id: ExpenseClaimId;
  readonly claimant: Claimant;
  readonly period: ClaimPeriod;
  readonly title?: string;
  /** 紐付けた仮払（1 申請 = 最大 1 仮払）。 */
  readonly advanceId?: ExpenseAdvanceId;
  readonly items: readonly ExpenseItem[];
  readonly status: ClaimStatus;
  readonly judgment?: StoredClaimJudgment;
  readonly acknowledgements: readonly Acknowledgement[];
  readonly returnNote?: ReturnNote;
  readonly approval?: Approval;
  /** 段ごとの承認の記録（MVP と同じ 1 段の承認では書かない）。 */
  readonly approvalFlow?: ApprovalFlow;
  readonly settlement?: Settlement;
  readonly payout?: ClaimPayoutMark;
  readonly journalLink?: JournalLink;
  readonly history: readonly ClaimHistoryEvent[];
  /** 取り込んだ主体の subject（自己承認の禁止に使う）。 */
  readonly submittedBy: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateExpenseClaimProps {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly claimant: Claimant;
  readonly period: ClaimPeriod;
  readonly title?: string;
  readonly advanceId?: string;
  readonly items?: readonly ExpenseItem[];
  readonly status?: ClaimStatus;
  readonly judgment?: StoredClaimJudgment;
  readonly acknowledgements?: readonly Acknowledgement[];
  readonly returnNote?: ReturnNote;
  readonly approval?: Approval;
  readonly approvalFlow?: ApprovalFlow;
  readonly settlement?: Settlement;
  readonly payout?: ClaimPayoutMark;
  readonly journalLink?: JournalLink;
  readonly history?: readonly ClaimHistoryEvent[];
  readonly submittedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fail(`${label} must be at most ${max} characters`);
  return trimmed === '' ? undefined : trimmed;
}

export function validateClaimant(value: unknown, label = 'expense claim: claimant'): Claimant {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const name = optionalText(raw['name'], `${label}.name`, CLAIMANT_TEXT_MAX);
  if (name === undefined) throw fail(`${label}.name must be a non-empty string`);
  return withDefined({
    name,
    employeeCode: optionalText(raw['employeeCode'], `${label}.employeeCode`, CLAIMANT_TEXT_MAX),
    department: optionalText(raw['department'], `${label}.department`, CLAIMANT_TEXT_MAX),
    employeeId: optionalText(raw['employeeId'], `${label}.employeeId`, 64),
    departmentId: optionalText(raw['departmentId'], `${label}.departmentId`, 64),
  });
}

export function validatePeriod(value: unknown, label = 'expense claim: period'): ClaimPeriod {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be { from, to }`);
  const raw = value as Record<string, unknown>;
  if (!isIsoDate(raw['from'])) throw fail(`${label}.from must be a date in YYYY-MM-DD`);
  if (!isIsoDate(raw['to'])) throw fail(`${label}.to must be a date in YYYY-MM-DD`);
  const days = daysBetween(raw['from'], raw['to']);
  if (days < 0) throw fail(`${label}.from must not be after ${label}.to`);
  if (days + 1 > CLAIM_MAX_PERIOD_DAYS) throw fail(`${label} must be at most ${CLAIM_MAX_PERIOD_DAYS} days`);
  return { from: raw['from'], to: raw['to'] };
}

/** 明細 1 件の形を検証して複製する。 */
export function validateExpenseItem(value: unknown, label = 'expense item'): ExpenseItem {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const id = optionalText(raw['id'], `${label}.id`, 64);
  if (id === undefined) throw fail(`${label}.id must be a non-empty string`);
  const source = raw['source'] as Record<string, unknown> | null | undefined;
  if (source === null || typeof source !== 'object') throw fail(`${label}.source must be an object`);
  if (!(ITEM_SOURCE_TYPES as readonly unknown[]).includes(source['type'])) throw fail(`${label}.source.type must be one of ${ITEM_SOURCE_TYPES.join(', ')}`);
  let row: ItemSource['row'];
  if (source['row'] !== undefined && source['row'] !== null) {
    if (typeof source['row'] !== 'object' || Array.isArray(source['row']) || Object.values(source['row'] as object).some((cell) => typeof cell !== 'string')) throw fail(`${label}.source.row must be an object of strings`);
    row = { ...(source['row'] as Record<string, string>) };
  }
  const extraction = raw['extraction'] as Record<string, unknown> | null | undefined;
  if (extraction === null || typeof extraction !== 'object') throw fail(`${label}.extraction must be an object`);
  if (!(ITEM_EXTRACTION_METHODS as readonly unknown[]).includes(extraction['method'])) throw fail(`${label}.extraction.method must be one of ${ITEM_EXTRACTION_METHODS.join(', ')}`);
  if (!Array.isArray(extraction['warnings']) || extraction['warnings'].some((warning) => typeof warning !== 'string')) throw fail(`${label}.extraction.warnings must be an array of strings`);
  const confidence = extraction['confidence'];
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) throw fail(`${label}.extraction.confidence must be between 0 and 1`);
  let model: ItemExtraction['model'];
  if (extraction['model'] !== undefined) {
    const candidate = extraction['model'] as Record<string, unknown> | null;
    if (candidate === null || typeof candidate !== 'object' || typeof candidate['provider'] !== 'string' || typeof candidate['model'] !== 'string') throw fail(`${label}.extraction.model must be { provider, model }`);
    model = { provider: candidate['provider'], model: candidate['model'] };
  }
  const addedOn = raw['addedOn'];
  if (addedOn !== undefined && !isIsoDate(addedOn)) throw fail(`${label}.addedOn must be a date in YYYY-MM-DD`);
  return withDefined({
    id,
    categoryId: optionalText(raw['categoryId'], `${label}.categoryId`, 64),
    categoryText: optionalText(raw['categoryText'], `${label}.categoryText`, 200),
    facts: validateReceiptFacts(raw['facts'], `${label}.facts`),
    receiptId: optionalText(raw['receiptId'], `${label}.receiptId`, 64),
    source: withDefined({ type: source['type'] as ItemSourceType, fileName: optionalText(source['fileName'], `${label}.source.fileName`, 255), row }),
    extraction: withDefined({
      method: extraction['method'] as ItemExtractionMethod,
      model,
      confidence: confidence as number | undefined,
      warnings: [...(extraction['warnings'] as string[])],
      documentKind: optionalText(extraction['documentKind'], `${label}.extraction.documentKind`, 64),
      rejectedRegistrationNumber: optionalText(extraction['rejectedRegistrationNumber'], `${label}.extraction.rejectedRegistrationNumber`, 64),
      flags: validateExtractionFlags(extraction['flags'], `${label}.extraction.flags`),
      detail: validateDetailRecord(extraction['detail'], `${label}.extraction.detail`),
    }),
    addedOn: addedOn as string | undefined,
  });
}

function validateAcknowledgement(value: unknown, label: string): Acknowledgement {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (!isReasonCode(raw['code'])) throw fail(`${label}.code must be a reason code`);
  const note = optionalText(raw['note'], `${label}.note`, ACKNOWLEDGEMENT_NOTE_MAX);
  if (note === undefined) throw fail(`${label}.note must be a non-empty string`);
  assertNonEmpty(raw['by'], `${label}.by`, fail);
  assertIsoDateTime(raw['at'], `${label}.at`, fail);
  return withDefined({ itemId: optionalText(raw['itemId'], `${label}.itemId`, 64), code: raw['code'], note, by: raw['by'] as string, at: raw['at'] });
}

function validateHistory(value: unknown, label: string): ClaimHistoryEvent {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (!(HISTORY_TYPES as readonly unknown[]).includes(raw['type'])) throw fail(`${label}.type must be one of ${HISTORY_TYPES.join(', ')}`);
  assertIsoDateTime(raw['at'], `${label}.at`, fail);
  if (raw['proxy'] !== undefined && typeof raw['proxy'] !== 'boolean') throw fail(`${label}.proxy must be a boolean`);
  return withDefined({ type: raw['type'] as ClaimHistoryType, by: optionalText(raw['by'], `${label}.by`, 256), at: raw['at'], note: optionalText(raw['note'], `${label}.note`, RETURN_MESSAGE_MAX), proxy: raw['proxy'] as boolean | undefined });
}

/** 申請を組み立てて不変条件を検証する。`id` が無いときは `makeId` で生成する。 */
export function createExpenseClaim(props: CreateExpenseClaimProps, makeId?: () => string): ExpenseClaim {
  if (props === null || typeof props !== 'object') throw fail('expense claim: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('expense claim: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'expense claim: tenant.tenantId', fail);
  assertNonEmpty(props.tenant.workspaceId, 'expense claim: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'expense claim: id', fail);
  const status = props.status ?? 'draft';
  if (!CLAIM_STATUSES.includes(status)) throw fail(`expense claim: status must be one of ${CLAIM_STATUSES.join(', ')}`);
  assertNonEmpty(props.submittedBy, 'expense claim: submittedBy', fail);
  assertIsoDateTime(props.createdAt, 'expense claim: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'expense claim: updatedAt', fail);

  const rawItems = props.items ?? [];
  if (!Array.isArray(rawItems)) throw fail('expense claim: items must be an array');
  if (rawItems.length > CLAIM_MAX_ITEMS) throw fail(`expense claim: items must have at most ${CLAIM_MAX_ITEMS} entries (split the period into separate claims)`);
  const items = rawItems.map((item, index) => validateExpenseItem(item, `expense claim: items[${index}]`));
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) throw fail(`expense claim: duplicate item id: ${item.id}`);
    itemIds.add(item.id);
  }

  const acknowledgements = (props.acknowledgements ?? []).map((entry, index) => validateAcknowledgement(entry, `expense claim: acknowledgements[${index}]`));
  let returnNote: ReturnNote | undefined;
  if (props.returnNote !== undefined) {
    const raw = props.returnNote as unknown as Record<string, unknown>;
    const message = optionalText(raw['message'], 'expense claim: returnNote.message', RETURN_MESSAGE_MAX);
    if (message === undefined) throw fail('expense claim: returnNote.message must be a non-empty string');
    if (!Array.isArray(raw['reasons'])) throw fail('expense claim: returnNote.reasons must be an array');
    const reasons = raw['reasons'].map((reason: unknown, index) => {
      const entry = reason as Record<string, unknown> | null;
      if (entry === null || typeof entry !== 'object' || !isReasonCode(entry['code']) || (entry['severity'] !== 'review' && entry['severity'] !== 'return')) {
        throw fail(`expense claim: returnNote.reasons[${index}] must be { code, itemId?, severity }`);
      }
      return withDefined({ code: entry['code'], itemId: typeof entry['itemId'] === 'string' ? entry['itemId'] : undefined, severity: entry['severity'] as Severity });
    });
    assertNonEmpty(raw['by'], 'expense claim: returnNote.by', fail);
    assertIsoDateTime(raw['at'], 'expense claim: returnNote.at', fail);
    returnNote = { message, reasons, by: raw['by'] as string, at: raw['at'] };
  }
  let approval: Approval | undefined;
  if (props.approval !== undefined) {
    const raw = props.approval as unknown as Record<string, unknown>;
    assertNonEmpty(raw['by'], 'expense claim: approval.by', fail);
    assertIsoDateTime(raw['at'], 'expense claim: approval.at', fail);
    approval = withDefined({ by: raw['by'] as string, displayName: optionalText(raw['displayName'], 'expense claim: approval.displayName', 256), at: raw['at'], comment: optionalText(raw['comment'], 'expense claim: approval.comment', ACKNOWLEDGEMENT_NOTE_MAX) });
  }
  let settlement: Settlement | undefined;
  if (props.settlement !== undefined) {
    const raw = props.settlement as unknown as Record<string, unknown>;
    assertIsoDateTime(raw['settledAt'], 'expense claim: settlement.settledAt', fail);
    assertNonEmpty(raw['by'], 'expense claim: settlement.by', fail);
    settlement = withDefined({ settledAt: raw['settledAt'], by: raw['by'] as string, exportFileName: optionalText(raw['exportFileName'], 'expense claim: settlement.exportFileName', 255) });
  }
  let journalLink: JournalLink | undefined;
  if (props.journalLink !== undefined) {
    const raw = props.journalLink as unknown as Record<string, unknown>;
    if (!Array.isArray(raw['entries']) || raw['entries'].some((entry) => entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>)['itemId'] !== 'string' || typeof (entry as Record<string, unknown>)['entryId'] !== 'string')) {
      throw fail('expense claim: journalLink.entries must be an array of { itemId, entryId }');
    }
    if (typeof raw['complete'] !== 'boolean') throw fail('expense claim: journalLink.complete must be a boolean');
    assertIsoDateTime(raw['draftedAt'], 'expense claim: journalLink.draftedAt', fail);
    assertNonEmpty(raw['by'], 'expense claim: journalLink.by', fail);
    if (!Array.isArray(raw['warnings']) || raw['warnings'].some((warning) => typeof warning !== 'string')) throw fail('expense claim: journalLink.warnings must be an array of strings');
    journalLink = {
      entries: (raw['entries'] as { itemId: string; entryId: string }[]).map((entry) => ({ itemId: entry.itemId, entryId: entry.entryId })),
      complete: raw['complete'],
      draftedAt: raw['draftedAt'],
      by: raw['by'] as string,
      warnings: [...(raw['warnings'] as string[])],
    };
  }
  const approvalFlow = props.approvalFlow === undefined ? undefined : validateApprovalFlow(props.approvalFlow, 'expense claim: approvalFlow');
  let payout: ClaimPayoutMark | undefined;
  if (props.payout !== undefined) {
    const raw = props.payout as unknown as Record<string, unknown>;
    assertNonEmpty(raw['batchId'], 'expense claim: payout.batchId', fail);
    assertIsoDateTime(raw['exportedAt'], 'expense claim: payout.exportedAt', fail);
    payout = { batchId: raw['batchId'] as string, exportedAt: raw['exportedAt'] };
  }
  const history = (props.history ?? []).map((entry, index) => validateHistory(entry, `expense claim: history[${index}]`)).slice(-CLAIM_MAX_HISTORY);
  if ((status === 'approved' || status === 'settled') && approval === undefined) throw fail(`expense claim: an ${status} claim must have an approval`);
  if (status === 'settled' && settlement === undefined) throw fail('expense claim: a settled claim must have a settlement');
  if (status === 'in-approval' && (approvalFlow === undefined || approvalFlow.currentIndex >= approvalFlow.steps.length)) throw fail('expense claim: an in-approval claim must have an approval flow with a pending step');
  if (approvalFlow !== undefined && status !== 'in-approval' && status !== 'approved' && status !== 'settled') throw fail(`expense claim: a ${status} claim must not have an approval flow`);
  if (payout !== undefined && status !== 'approved' && status !== 'settled') throw fail(`expense claim: a ${status} claim must not be in a payout batch`);

  return withDefined({
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    claimant: validateClaimant(props.claimant),
    period: validatePeriod(props.period),
    title: optionalText(props.title, 'expense claim: title', CLAIM_TITLE_MAX),
    advanceId: optionalText(props.advanceId, 'expense claim: advanceId', 64),
    items,
    status,
    judgment: props.judgment === undefined ? undefined : validateStoredJudgment(props.judgment, 'expense claim: judgment', fail),
    acknowledgements,
    returnNote,
    approval,
    approvalFlow,
    settlement,
    payout,
    journalLink,
    history,
    submittedBy: props.submittedBy,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
}

/* ---------------------------------------------------------------------------
 * 指紋・集計
 * ------------------------------------------------------------------------ */

/** キーを並べ替えた JSON（オブジェクトの挿入順に依らない）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export type FingerprintedClaim = Pick<ExpenseClaim, 'claimant' | 'period' | 'items'> & { readonly advanceId?: string };

/**
 * 明細（事実・費目・証憑の有無・読取の警告と印）・申請者（参照 id を除く）・期間・仮払の指紋。これが変われば判定は古い。
 * 未定義の項目は含めないので、MVP の申請の指紋は実用化の前後で変わらない（テストで文字列を固定）。
 */
export function claimFingerprint(claim: FingerprintedClaim): string {
  const { employeeId: _employeeId, departmentId: _departmentId, ...claimant } = claim.claimant;
  const text = stableStringify({ claimant, period: claim.period, items: claim.items, advanceId: claim.advanceId });
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x9747b28c)}${text.length.toString(16)}`;
}

/** 判定が現在の規程と明細に対して古いか（判定が無ければ false — 「未チェック」は古さとは別に扱う）。 */
export function isJudgmentStale(claim: Pick<ExpenseClaim, 'judgment'> & FingerprintedClaim, policy: Pick<ExpensePolicy, 'updatedAt'>): boolean {
  if (claim.judgment === undefined) return false;
  return claim.judgment.policyUpdatedAt !== policy.updatedAt || claim.judgment.itemsFingerprint !== claimFingerprint(claim);
}

/** 金額のある明細の合計（税込）。 */
export function claimTotalAmount(claim: Pick<ExpenseClaim, 'items'>): number {
  return claim.items.reduce((sum, item) => sum + (usableAmount(item.facts) ?? 0), 0);
}

/** 会社払いの明細を申請に含める運用のとき、会社払いとして除く明細か（§20.2.3。規程のフラグが off なら常に false）。 */
function excludedAsCorporate(item: ExpenseItem, policy: Pick<ExpensePolicy, 'card'>): boolean {
  return policy.card.acceptCorporatePaymentItems && item.facts.corporatePayment === true;
}

/**
 * 従業員へ支払う額（精算 CSV の `total_amount` と振込が使う）。金額のある明細のうち、会社払いとして受け入れた明細を除いた合計。
 * `card.acceptCorporatePaymentItems` が off（既定）なら `claimTotalAmount` と同じ。
 */
export function reimbursableAmount(claim: Pick<ExpenseClaim, 'items'>, policy: Pick<ExpensePolicy, 'card'>): number {
  return claim.items.reduce((sum, item) => sum + (excludedAsCorporate(item, policy) ? 0 : usableAmount(item.facts) ?? 0), 0);
}

/** 会社払いとして除いた額（`claimTotalAmount = reimbursableAmount + corporateAmount`）。 */
export function corporateAmount(claim: Pick<ExpenseClaim, 'items'>, policy: Pick<ExpensePolicy, 'card'>): number {
  return claim.items.reduce((sum, item) => sum + (excludedAsCorporate(item, policy) ? usableAmount(item.facts) ?? 0 : 0), 0);
}

/** 申請者の照合キー（NFKC・空白除去・小文字化 + 社員番号）。一覧の絞り込みと CSV の申請の束ね方に使う。 */
export function claimantKeyOf(claimant: Pick<Claimant, 'name' | 'employeeCode'>): string {
  const name = claimant.name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const code = claimant.employeeCode?.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  return code === undefined || code === '' ? name : `${name}#${code}`;
}

/* ---------------------------------------------------------------------------
 * 状態遷移
 * ------------------------------------------------------------------------ */

function pushHistory(claim: ExpenseClaim, event: ClaimHistoryEvent): readonly ClaimHistoryEvent[] {
  // 溢れたら古いものから落とす（正本は監査ログにある）。
  return [...claim.history, withDefined(event)].slice(-CLAIM_MAX_HISTORY);
}

function assertEditable(claim: ExpenseClaim, action: string): void {
  if (claim.status === 'approved') {
    throw new ExpenseTransitionError(`${action}: an approved claim cannot be edited; unapprove it first`, { nextStep: '承認を取り消してから編集してください' });
  }
  if (claim.status === 'settled') {
    throw new ExpenseTransitionError(`${action}: a settled claim cannot be edited`, { nextStep: '精算済みの申請は編集できません。直す必要があれば別の申請で出し直してください' });
  }
  if (claim.status === 'in-approval') {
    // 段の承認者は判定済みの内容を見て承認している。承認の途中で中身を変えると、前の段の承認が別の内容に付くことになる。
    throw new ExpenseTransitionError(`${action}: a claim in approval cannot be edited; return or unapprove it first`, { nextStep: '承認中は編集できません。差し戻すか承認を取り消してから編集してください' });
  }
}

/** 判定済みの申請を編集したら draft へ戻し、判定と確認済みを落とす（別の事実に対する確認だったため）。 */
function reopened(claim: ExpenseClaim, at: string): ExpenseClaim {
  const { judgment: _judgment, ...rest } = claim;
  return { ...rest, status: 'draft', acknowledgements: [], updatedAt: at };
}

export interface EditClaimPatch {
  readonly claimant?: Claimant;
  readonly period?: ClaimPeriod;
  /** 空文字で消す。 */
  readonly title?: string;
}

export function editClaim(claim: ExpenseClaim, patch: EditClaimPatch, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'editClaim: at', fail);
  assertEditable(claim, 'editClaim');
  const base = reopened(claim, at);
  const { title: _title, ...withoutTitle } = base;
  const title = patch.title === undefined ? claim.title : optionalText(patch.title, 'editClaim: title', CLAIM_TITLE_MAX);
  return {
    ...withoutTitle,
    claimant: patch.claimant === undefined ? claim.claimant : validateClaimant(patch.claimant, 'editClaim: claimant'),
    period: patch.period === undefined ? claim.period : validatePeriod(patch.period, 'editClaim: period'),
    ...(title === undefined ? {} : { title }),
    history: pushHistory(claim, { type: 'edited', by, at }),
  };
}

/** 明細を追加する（同じ id があれば置き換える）。 */
export function putItem(claim: ExpenseClaim, item: ExpenseItem, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'putItem: at', fail);
  assertEditable(claim, 'putItem');
  const validated = validateExpenseItem(item, 'putItem: item');
  const index = claim.items.findIndex((entry) => entry.id === validated.id);
  const items = index < 0 ? [...claim.items, validated] : claim.items.map((entry, position) => (position === index ? validated : entry));
  if (items.length > CLAIM_MAX_ITEMS) throw fail(`putItem: a claim can hold at most ${CLAIM_MAX_ITEMS} items; split the period into separate claims`);
  return { ...reopened(claim, at), items, history: pushHistory(claim, { type: 'edited', by, at, note: index < 0 ? `item added: ${validated.id}` : `item updated: ${validated.id}` }) };
}

/**
 * 明細をまとめて足す（CSV 取込）。履歴は 1 件にまとめる（100 行の取込で履歴の上限を食い潰さないため）。
 * 容量を超える分は呼び出し側が先に読み飛ばすこと（ここでは超えたら 400 にする）。
 */
export function appendItems(claim: ExpenseClaim, items: readonly ExpenseItem[], by: string, at: string, note: string): ExpenseClaim {
  assertIsoDateTime(at, 'appendItems: at', fail);
  assertEditable(claim, 'appendItems');
  if (items.length === 0) return claim;
  const validated = items.map((item, index) => validateExpenseItem(item, `appendItems: items[${index}]`));
  const merged = [...claim.items, ...validated];
  if (merged.length > CLAIM_MAX_ITEMS) throw fail(`appendItems: a claim can hold at most ${CLAIM_MAX_ITEMS} items; split the period into separate claims`);
  const ids = new Set<string>();
  for (const item of merged) {
    if (ids.has(item.id)) throw fail(`appendItems: duplicate item id: ${item.id}`);
    ids.add(item.id);
  }
  return { ...reopened(claim, at), items: merged, history: pushHistory(claim, { type: 'edited', by, at, note }) };
}

export function removeItem(claim: ExpenseClaim, itemId: string, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'removeItem: at', fail);
  assertEditable(claim, 'removeItem');
  if (!claim.items.some((item) => item.id === itemId)) throw new ExpenseItemNotFoundError(`expense item not found: ${itemId} (claim ${claim.id})`);
  return { ...reopened(claim, at), items: claim.items.filter((item) => item.id !== itemId), history: pushHistory(claim, { type: 'edited', by, at, note: `item removed: ${itemId}` }) };
}

/**
 * 判定結果を保存する。確認済みは、新しい判定にも同じ要確認の理由が残っているものだけを引き継ぐ。
 * `in-approval` の再チェック（規程が変わった）は段の承認を捨てて `checked` に戻す（古い判定に付いた承認を残さない）。
 */
export function withJudgment(claim: ExpenseClaim, judgment: StoredClaimJudgment, at: string, by?: string): ExpenseClaim {
  assertIsoDateTime(at, 'withJudgment: at', fail);
  if (claim.status === 'approved' || claim.status === 'settled') {
    throw new ExpenseTransitionError(`withJudgment: a ${claim.status} claim is not re-checked`, { nextStep: '承認済み・精算済みの申請は再チェックしません。直すなら承認を取り消してください' });
  }
  const validated = validateStoredJudgment(judgment, 'withJudgment: judgment', fail);
  const reviewKeys = new Set(allReasons(validated).filter((reason) => reason.severity === 'review').map((reason) => reasonKey(reason.code, reason.itemId)));
  const { approvalFlow: _approvalFlow, ...rest } = claim;
  return {
    ...rest,
    status: 'checked',
    judgment: validated,
    acknowledgements: claim.acknowledgements.filter((entry) => reviewKeys.has(reasonKey(entry.code, entry.itemId))),
    updatedAt: at,
    history: pushHistory(claim, { type: 'checked', ...(by === undefined ? {} : { by }), at, note: validated.verdict }),
  };
}

/** 確認済みでない要確認の理由。 */
export function unacknowledgedReviewReasons(claim: Pick<ExpenseClaim, 'judgment' | 'acknowledgements'>): readonly CheckReason[] {
  if (claim.judgment === undefined) return [];
  const acknowledged = new Set(claim.acknowledgements.map((entry) => reasonKey(entry.code, entry.itemId)));
  return allReasons(claim.judgment).filter((reason) => reason.severity === 'review' && !acknowledged.has(reasonKey(reason.code, reason.itemId)));
}

export function returnReasonsOf(claim: Pick<ExpenseClaim, 'judgment'>): readonly CheckReason[] {
  return claim.judgment === undefined ? [] : allReasons(claim.judgment).filter((reason) => reason.severity === 'return');
}

function statusLabel(status: ClaimStatus): string {
  switch (status) {
    case 'approved': return '承認済み';
    case 'settled': return '精算済み';
    case 'in-approval': return '承認中';
    default: return status;
  }
}

function assertChecked(claim: ExpenseClaim, action: string, allowInApproval = false): void {
  if (claim.status === 'checked' || (allowInApproval && claim.status === 'in-approval')) return;
  const nextStep = claim.status === 'draft'
    ? 'チェックしてから操作してください'
    : claim.status === 'returned'
      ? '差し戻した申請です。申請者の修正を反映して編集し、もう一度チェックしてください'
      : `${statusLabel(claim.status)}の申請にはこの操作はできません`;
  throw new ExpenseTransitionError(`${action}: the claim must be checked (status: ${claim.status})`, { nextStep });
}

export interface AcknowledgeInput {
  readonly itemId?: string;
  readonly code: string;
  readonly note: string;
}

/** 要確認の理由 1 件を確認済みにする（根拠コメント必須）。差し戻しの理由は確認済みにできない。 */
export function acknowledge(claim: ExpenseClaim, input: AcknowledgeInput, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'acknowledge: at', fail);
  assertChecked(claim, 'acknowledge');
  const key = reasonKey(input.code, input.itemId);
  const reasons = allReasons(claim.judgment ?? { items: [], claimReasons: [] }).filter((reason) => reasonKey(reason.code, reason.itemId) === key);
  if (reasons.length === 0) {
    throw new ExpenseTransitionError(`acknowledge: the current judgment has no reason ${input.code}${input.itemId === undefined ? '' : ` for item ${input.itemId}`}`, { nextStep: '画面を開き直して、いまの判定に残っている理由を確認してください' });
  }
  if (!reasons.some((reason) => reason.severity === 'review')) {
    throw new ExpenseTransitionError(`acknowledge: ${input.code} is a return reason and cannot be acknowledged`, { blockingReasons: [{ code: input.code, ...(input.itemId === undefined ? {} : { itemId: input.itemId }) }], nextStep: '差し戻しの理由は確認済みにできません。申請者に直してもらい、もう一度チェックしてください' });
  }
  if (typeof input.note !== 'string' || input.note.trim() === '') {
    throw new ExpenseTransitionError('acknowledge: a note explaining why the reason is acceptable is required', { nextStep: '確認済みにする根拠（誰と何のための支出か、なぜ認めるか）をコメントに書いてください' });
  }
  const note = optionalText(input.note, 'acknowledge: note', ACKNOWLEDGEMENT_NOTE_MAX) as string;
  const entry: Acknowledgement = withDefined({ itemId: input.itemId, code: input.code as ExpenseReasonCode, note, by, at });
  return {
    ...claim,
    acknowledgements: [...claim.acknowledgements.filter((existing) => reasonKey(existing.code, existing.itemId) !== key), entry],
    updatedAt: at,
    history: pushHistory(claim, { type: 'acknowledged', by, at, note: `${input.code}${input.itemId === undefined ? '' : ` (${input.itemId})`}: ${note}` }),
  };
}

/** 差し戻す（人が編集した申請者向けの文言を残す）。承認中の申請はどの段の承認者からでも差し戻せ、段の承認を捨てる。 */
export function returnClaim(claim: ExpenseClaim, message: string, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'returnClaim: at', fail);
  assertChecked(claim, 'returnClaim', true);
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ExpenseTransitionError('returnClaim: a message for the claimant is required', { nextStep: '申請者に何を直してほしいかを文言に書いてください' });
  }
  const trimmed = optionalText(message, 'returnClaim: message', RETURN_MESSAGE_MAX) as string;
  const reasons = [...returnReasonsOf(claim), ...unacknowledgedReviewReasons(claim)].map((reason) => withDefined({ code: reason.code, itemId: reason.itemId, severity: reason.severity }));
  const { approvalFlow: _approvalFlow, ...rest } = claim;
  return {
    ...rest,
    status: 'returned',
    returnNote: { message: trimmed, reasons, by, at },
    updatedAt: at,
    history: pushHistory(claim, { type: 'returned', by, at }),
  };
}

/**
 * 承認を妨げる理由（画面の「承認できない理由」とツールの説明に使う）。
 * `by` を渡すと自己承認の禁止も見る。承認経路・操作者に依存する理由（§20.5.1）は application が足す。
 */
export function approvalBlockers(claim: ExpenseClaim, policy: ExpensePolicy, by?: string): readonly ExpenseBlockingReason[] {
  const blockers: ExpenseBlockingReason[] = [];
  if (claim.judgment === undefined) blockers.push({ code: 'judgment-missing' });
  else if (isJudgmentStale(claim, policy)) blockers.push({ code: 'judgment-stale' });
  else {
    for (const reason of [...returnReasonsOf(claim), ...unacknowledgedReviewReasons(claim)]) {
      blockers.push({ code: reason.code, ...(reason.itemId === undefined ? {} : { itemId: reason.itemId }) });
    }
  }
  if (by !== undefined && policy.claimRules.forbidSelfApproval && by === claim.submittedBy) blockers.push({ code: 'self-approval' });
  return blockers;
}

/** 承認経路・操作者に依存する拒否理由の次の一手（§20.5.1）。 */
const APPROVAL_NEXT_STEPS: Readonly<Record<string, string>> = {
  'approval-route-unresolved': '承認経路の段の承認者が決まりません。従業員マスタ・組織・承認経路を直してから承認してください',
  'approval-step-changed': '画面を開いた後に承認が進みました。画面を再読み込みしてから操作してください',
  'approval-not-current-approver': 'あなたは現在の段の承認者ではありません。承認者に承認を依頼するか、規程の代理承認グループに入れてもらってください',
  'approval-actor-unlinked': 'ログイン ID が従業員マスタに紐付いていません。従業員マスタで自分の「ログイン ID」を登録してください',
  'approval-claimant-self': '申請者本人は自分の申請を承認できません。別の承認者に依頼してください',
  'approval-same-approver': '前の段を承認した人はこの段を承認できません。別の承認者に依頼してください',
  'approval-proxy-comment-missing': '代理承認にはコメントが必要です。誰の代わりに・なぜ承認するかを書いてください',
};

function nextStepFor(blockers: readonly ExpenseBlockingReason[], claim: ExpenseClaim): string {
  if (blockers.some((entry) => entry.code === 'judgment-missing' || entry.code === 'judgment-stale')) return '規程か明細が変わりました。もう一度チェックしてから承認してください';
  if (returnReasonsOf(claim).length > 0) return '差し戻しの理由が残っています。差し戻して申請者に直してもらってください';
  if (blockers.some((entry) => entry.code === 'self-approval')) return '取り込んだ人とは別の人が承認してください（規程の申請ルールで変更できます）';
  const approval = blockers.find((entry) => APPROVAL_NEXT_STEPS[entry.code] !== undefined);
  if (approval !== undefined) return APPROVAL_NEXT_STEPS[approval.code] as string;
  return '要確認の理由をすべて確認済みにしてから承認してください';
}

export interface ApproveOptions {
  readonly displayName?: string;
  readonly comment?: string;
}

export function approveClaim(claim: ExpenseClaim, policy: ExpensePolicy, by: string, at: string, options: ApproveOptions = {}): ExpenseClaim {
  assertIsoDateTime(at, 'approveClaim: at', fail);
  assertChecked(claim, 'approveClaim');
  const blockers = approvalBlockers(claim, policy, by);
  if (blockers.length > 0) {
    throw new ExpenseTransitionError(`approveClaim: the claim cannot be approved (${blockers.map((entry) => entry.code).join(', ')})`, { blockingReasons: blockers, nextStep: nextStepFor(blockers, claim) });
  }
  const approval: Approval = withDefined({ by, displayName: optionalText(options.displayName, 'approveClaim: displayName', 256), at, comment: optionalText(options.comment, 'approveClaim: comment', ACKNOWLEDGEMENT_NOTE_MAX) });
  return { ...claim, status: 'approved', approval, updatedAt: at, history: pushHistory(claim, { type: 'approved', by, at, ...(approval.comment === undefined ? {} : { note: approval.comment }) }) };
}

export interface ApproveStepOptions extends ApproveOptions {
  /** 画面が見ていた段（`in-approval` で現在の段と違えば `approval-step-changed`）。 */
  readonly stepId?: string;
  /** 操作者の従業員（承認の記録と、次の段の同一承認者の検査に使う）。 */
  readonly employeeId?: string;
  /** 代理承認（コメント必須）。 */
  readonly proxy?: boolean;
}

/**
 * 段を 1 つ承認する（§20.2.12）。`checked` なら計画 `plan` を申請へ写してから 1 段目を、`in-approval` なら保存済みの流れの現在の段を承認する。
 *
 * - 人の解決（誰が承認者か・代理できるか）は知らない。操作者の拒否理由は application（A の `actorStepBlockers`）が `actorBlockers` で渡す。
 * - 拒否: MVP の承認の拒否条件（判定なし・古い・差し戻し理由・未確認の要確認・自己承認）+ `plan.unresolved`（`checked` のとき）
 *   + `actorBlockers` + 段の食い違い + 代理でコメントなし。
 * - MVP と同じ計画（1 段・any-approver）で代理でなければ、記録は MVP と同じ `approval` だけにする（`approvalFlow` を書かない）。
 */
export function approveStep(
  claim: ExpenseClaim,
  policy: ExpensePolicy,
  plan: ApprovalPlan,
  actorBlockers: readonly ExpenseBlockingReason[],
  by: string,
  at: string,
  options: ApproveStepOptions = {},
): ExpenseClaim {
  assertIsoDateTime(at, 'approveStep: at', fail);
  assertChecked(claim, 'approveStep', true);
  const blockers: ExpenseBlockingReason[] = [...approvalBlockers(claim, policy, by)];
  let flow: ApprovalFlow;
  if (claim.status === 'checked') {
    for (const unresolved of plan.unresolved) {
      blockers.push({ code: 'approval-route-unresolved', params: { routeName: plan.routeName, stepId: unresolved.stepId, stepName: unresolved.stepName, cause: unresolved.cause, ...unresolved.params } });
    }
    flow = flowFromPlan(plan, at, policy.updatedAt);
  } else {
    flow = claim.approvalFlow as ApprovalFlow;
  }
  const current = currentApprovalStep(flow);
  if (options.stepId !== undefined && current !== undefined && current.stepId !== options.stepId) {
    blockers.push({ code: 'approval-step-changed', params: { stepName: current.name } });
  }
  blockers.push(...actorBlockers);
  const comment = optionalText(options.comment, 'approveStep: comment', ACKNOWLEDGEMENT_NOTE_MAX);
  if (options.proxy === true && comment === undefined && !blockers.some((entry) => entry.code === 'approval-proxy-comment-missing')) {
    blockers.push({ code: 'approval-proxy-comment-missing' });
  }
  if (blockers.length > 0) {
    throw new ExpenseTransitionError(`approveStep: the claim cannot be approved (${blockers.map((entry) => entry.code).join(', ')})`, { blockingReasons: blockers, nextStep: nextStepFor(blockers, claim) });
  }
  const displayName = optionalText(options.displayName, 'approveStep: displayName', 256);
  if (claim.status === 'checked' && isMvpApprovalPlan(plan) && options.proxy !== true) {
    return approveClaim(claim, policy, by, at, { ...(displayName === undefined ? {} : { displayName }), ...(comment === undefined ? {} : { comment }) });
  }

  const decision: ApprovalDecision = withDefined({ by, employeeId: options.employeeId, displayName, at, comment, proxy: options.proxy === true });
  const steps = flow.steps.map((step, index) => (index === flow.currentIndex && step.status === 'pending' ? { ...step, status: 'approved' as const, decision } : step));
  let next = current === undefined ? flow.currentIndex : flow.currentIndex + 1;
  while (next < steps.length && steps[next]?.status === 'skipped') next += 1;
  const updatedFlow: ApprovalFlow = { ...flow, steps, currentIndex: next };
  const proxy = options.proxy === true ? { proxy: true } : {};
  if (next >= steps.length) {
    const approval: Approval = withDefined({ by, displayName, at, comment });
    return { ...claim, status: 'approved', approval, approvalFlow: updatedFlow, updatedAt: at, history: pushHistory(claim, { type: 'approved', by, at, ...(comment === undefined ? {} : { note: comment }), ...proxy }) };
  }
  return {
    ...claim,
    status: 'in-approval',
    approvalFlow: updatedFlow,
    updatedAt: at,
    history: pushHistory(claim, { type: 'approval-step', by, at, note: comment === undefined ? `${current?.name ?? ''}` : `${current?.name ?? ''}: ${comment}`, ...proxy }),
  };
}

export interface UnapproveOptions {
  /** 紐付けた仮払が精算済み（仮払の精算の取消は後回しなので、承認も取り消せない）。application が仮払を読んで渡す。 */
  readonly advanceSettled?: boolean;
}

/** 承認取消（承認中は全段を捨てて checked へ。承認済みは精算前・仕訳下書き未作成・振込バッチ無し・仮払で精算していないときだけ）。 */
export function unapproveClaim(claim: ExpenseClaim, by: string, at: string, note: string, options: UnapproveOptions = {}): ExpenseClaim {
  assertIsoDateTime(at, 'unapproveClaim: at', fail);
  if (claim.status !== 'approved' && claim.status !== 'in-approval') {
    throw new ExpenseTransitionError(`unapproveClaim: only an approved claim can be unapproved (status: ${claim.status})`, { nextStep: claim.status === 'settled' ? '精算済みの申請は承認を取り消せません' : '承認されていない申請です' });
  }
  if (claim.journalLink !== undefined) {
    throw new ExpenseTransitionError('unapproveClaim: journal drafts were already created for this claim', { nextStep: '仕訳下書きを作成済みのため承認を取り消せません。仕訳画面で下書きを確認してください' });
  }
  if (claim.settlement !== undefined) {
    throw new ExpenseTransitionError('unapproveClaim: the claim is already settled', { nextStep: '精算済みの申請は承認を取り消せません' });
  }
  if (claim.payout !== undefined) {
    throw new ExpenseTransitionError(`unapproveClaim: the claim is in payout batch ${claim.payout.batchId}`, { nextStep: `振込データ ${claim.payout.batchId} に入っているため承認を取り消せません。振込データを取り消してから操作してください` });
  }
  if (options.advanceSettled === true) {
    throw new ExpenseTransitionError(`unapproveClaim: the claim was settled with advance ${claim.advanceId ?? ''}`, { nextStep: `仮払 ${claim.advanceId ?? ''} で精算済みです。仮払の精算を取り消す機能は後回しです` });
  }
  if (typeof note !== 'string' || note.trim() === '') {
    throw new ExpenseTransitionError('unapproveClaim: a note explaining why is required', { nextStep: '承認を取り消す理由を書いてください' });
  }
  const trimmed = optionalText(note, 'unapproveClaim: note', ACKNOWLEDGEMENT_NOTE_MAX) as string;
  const { approval: _approval, approvalFlow: _approvalFlow, ...rest } = claim;
  return { ...rest, status: 'checked', updatedAt: at, history: pushHistory(claim, { type: 'unapproved', by, at, note: trimmed }) };
}

/** 精算済みにする（`settled` は冪等）。 */
export function markSettled(claim: ExpenseClaim, by: string, at: string, exportFileName?: string): ExpenseClaim {
  assertIsoDateTime(at, 'markSettled: at', fail);
  if (claim.status === 'settled') return claim;
  if (claim.status !== 'approved') {
    throw new ExpenseTransitionError(`markSettled: only an approved claim can be settled (status: ${claim.status})`, { nextStep: '承認してから精算済みにしてください' });
  }
  const fileName = optionalText(exportFileName, 'markSettled: exportFileName', 255);
  return {
    ...claim,
    status: 'settled',
    settlement: withDefined({ settledAt: at, by, exportFileName: fileName }),
    updatedAt: at,
    history: pushHistory(claim, { type: 'settled', by, at, ...(fileName === undefined ? {} : { note: fileName }) }),
  };
}

export interface JournalLinkInput {
  readonly entries: readonly { readonly itemId: string; readonly entryId: string }[];
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

/** 仕訳下書きの作成結果を記録する。途中で止まったもの（complete: false）は続きを作ったときに上書きする。 */
export function withJournalLink(claim: ExpenseClaim, link: JournalLinkInput, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'withJournalLink: at', fail);
  if (claim.status !== 'approved' && claim.status !== 'settled') {
    throw new ExpenseTransitionError(`withJournalLink: only an approved or settled claim can be drafted into the journal (status: ${claim.status})`, { nextStep: '承認してから仕訳下書きを作成してください' });
  }
  if (claim.journalLink?.complete === true) {
    throw new ExpenseTransitionError('withJournalLink: journal drafts were already created for every item', { nextStep: '仕訳下書きは作成済みです。仕訳画面の出力タブで確定してください' });
  }
  return {
    ...claim,
    journalLink: { entries: link.entries.map((entry) => ({ itemId: entry.itemId, entryId: entry.entryId })), complete: link.complete, draftedAt: at, by, warnings: [...link.warnings] },
    updatedAt: at,
    history: link.complete ? pushHistory(claim, { type: 'journal-drafted', by, at, note: `${link.entries.length} entries` }) : claim.history,
  };
}

/* ---------------------------------------------------------------------------
 * 実用化の遷移（§20.2.12。紐付け・振込の印）
 * ------------------------------------------------------------------------ */

/** 従業員への紐付けで申請に写す値（application が従業員と組織から作る）。 */
export interface ClaimantLink {
  readonly employeeId: string;
  readonly name: string;
  readonly employeeCode?: string;
  readonly department?: string;
  readonly departmentId?: string;
}

/**
 * 申請者を従業員マスタに紐付ける。`draft` / `checked` / `returned` は編集と同じく `draft` へ戻し写しを入れ替える。
 * `approved` / `settled` は状態と判定を変えずに参照 id だけを足す（指紋に含めないので判定は古くならない）。
 * `in-approval` は段の承認者が申請者を前提に決まっているので断る。
 */
export function linkClaimantEmployee(claim: ExpenseClaim, link: ClaimantLink, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'linkClaimantEmployee: at', fail);
  assertNonEmpty(link.employeeId, 'linkClaimantEmployee: employeeId', fail);
  if (claim.status === 'in-approval') {
    throw new ExpenseTransitionError('linkClaimantEmployee: a claim in approval cannot be linked', { nextStep: '承認中の申請は申請者を紐付けられません。差し戻すか承認を取り消してから操作してください' });
  }
  const history = pushHistory(claim, { type: 'employee-linked', by, at, note: link.employeeId });
  if (claim.status === 'approved' || claim.status === 'settled') {
    return { ...claim, claimant: validateClaimant({ ...claim.claimant, employeeId: link.employeeId, departmentId: link.departmentId }, 'linkClaimantEmployee: claimant'), updatedAt: at, history };
  }
  const claimant = validateClaimant({ name: link.name, employeeCode: link.employeeCode, department: link.department, employeeId: link.employeeId, departmentId: link.departmentId }, 'linkClaimantEmployee: claimant');
  return { ...reopened(claim, at), claimant, history };
}

/** 仮払を紐付ける / 外す（null）。判定の前提が変わるので編集と同じく `draft` へ戻す。 */
export function linkAdvance(claim: ExpenseClaim, advance: { readonly id: string } | null, by: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'linkAdvance: at', fail);
  assertEditable(claim, 'linkAdvance');
  if ((advance?.id ?? undefined) === claim.advanceId) return claim;
  const { advanceId: _advanceId, ...base } = reopened(claim, at);
  const history = pushHistory(claim, advance === null ? { type: 'advance-unlinked', by, at, note: claim.advanceId ?? '' } : { type: 'advance-linked', by, at, note: advance.id });
  return { ...base, ...(advance === null ? {} : { advanceId: advance.id }), history };
}

/** 振込バッチに入れた印。承認済み以外・既に別のバッチに入っている申請は断る（同じバッチなら冪等）。 */
export function markPayoutExported(claim: ExpenseClaim, batchId: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'markPayoutExported: at', fail);
  assertNonEmpty(batchId, 'markPayoutExported: batchId', fail);
  if (claim.payout?.batchId === batchId) return claim;
  if (claim.status !== 'approved') {
    throw new ExpenseTransitionError(`markPayoutExported: only an approved claim can be exported (status: ${claim.status})`, { nextStep: '承認済みの申請だけを振込データに入れられます' });
  }
  if (claim.payout !== undefined) {
    throw new ExpenseTransitionError(`markPayoutExported: the claim is already in payout batch ${claim.payout.batchId}`, { nextStep: `申請は振込データ ${claim.payout.batchId} に既に入っています。そのファイルを使うか、振込データを取り消してから作り直してください` });
  }
  return { ...claim, payout: { batchId, exportedAt: at }, updatedAt: at, history: pushHistory(claim, { type: 'payout-exported', at, note: batchId }) };
}

/** 振込バッチの取消で印を外す（そのバッチの印でなければ何もしない）。 */
export function clearPayout(claim: ExpenseClaim, batchId: string, at: string): ExpenseClaim {
  assertIsoDateTime(at, 'clearPayout: at', fail);
  if (claim.payout?.batchId !== batchId) return claim;
  const { payout: _payout, ...rest } = claim;
  return { ...rest, updatedAt: at, history: pushHistory(claim, { type: 'payout-cancelled', at, note: batchId }) };
}

/* ---------------------------------------------------------------------------
 * 一覧用の要約
 * ------------------------------------------------------------------------ */

export interface ExpenseClaimSummary {
  readonly id: string;
  readonly claimant: Claimant;
  readonly period: ClaimPeriod;
  readonly title?: string;
  readonly status: ClaimStatus;
  readonly verdict?: Verdict;
  /** 判定が古いか。リポジトリは指紋だけを見て、規程との比較は `withPolicyStaleness` で足す。 */
  readonly stale: boolean;
  readonly itemCount: number;
  readonly totalAmount: number;
  /** 会社払いの明細の合計（規程のフラグに依らない。`reimbursable = total - corporate` は規程のフラグが on のときだけ）。 */
  readonly corporatePaymentAmount: number;
  readonly reasonCounts: { readonly return: number; readonly review: number; readonly acknowledged: number };
  readonly journalLinked: 'none' | 'partial' | 'complete';
  /** 多い順の理由コード（最大 5 件）。 */
  readonly topReasons: readonly string[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly settledAt?: string;
  readonly submittedBy: string;
  /** 判定時の規程の版（規程との古さの比較に使う）。 */
  readonly judgedPolicyUpdatedAt?: string;
  readonly advanceId?: string;
  readonly payoutBatchId?: string;
  /** 承認中の現在の段（`in-approval` のときだけ）。 */
  readonly currentStep?: { readonly stepId: string; readonly name: string; readonly approvers: readonly { readonly employeeId: string; readonly name: string }[] };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toExpenseClaimSummary(claim: ExpenseClaim): ExpenseClaimSummary {
  const reasons = claim.judgment === undefined ? [] : allReasons(claim.judgment);
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
  const order = (code: string): number => (REASON_CODES as readonly string[]).indexOf(code);
  const topReasons = [...counts.entries()].sort(([leftCode, left], [rightCode, right]) => right - left || order(leftCode) - order(rightCode)).slice(0, 5).map(([code]) => code);
  const step = claim.status === 'in-approval' && claim.approvalFlow !== undefined ? currentApprovalStep(claim.approvalFlow) : undefined;
  return withDefined({
    id: claim.id,
    claimant: { ...claim.claimant },
    period: { ...claim.period },
    title: claim.title,
    status: claim.status,
    verdict: claim.judgment?.verdict,
    stale: claim.judgment !== undefined && claim.judgment.itemsFingerprint !== claimFingerprint(claim),
    itemCount: claim.items.length,
    totalAmount: claimTotalAmount(claim),
    corporatePaymentAmount: claim.items.reduce((sum, item) => sum + (item.facts.corporatePayment === true ? usableAmount(item.facts) ?? 0 : 0), 0),
    reasonCounts: {
      return: reasons.filter((reason) => reason.severity === 'return').length,
      review: reasons.filter((reason) => reason.severity === 'review').length,
      acknowledged: claim.acknowledgements.length,
    },
    journalLinked: claim.journalLink === undefined ? 'none' as const : claim.journalLink.complete ? 'complete' as const : 'partial' as const,
    topReasons,
    approvedBy: claim.approval?.by,
    approvedAt: claim.approval?.at,
    settledAt: claim.settlement?.settledAt,
    submittedBy: claim.submittedBy,
    judgedPolicyUpdatedAt: claim.judgment?.policyUpdatedAt,
    advanceId: claim.advanceId,
    payoutBatchId: claim.payout?.batchId,
    currentStep: step === undefined ? undefined : { stepId: step.stepId, name: step.name, approvers: step.approvers.map((entry) => ({ ...entry })) },
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  });
}

/** 規程の版と比べた古さを足す（リポジトリは規程を知らないので、ユースケースが最後に通す）。 */
export function withPolicyStaleness(summary: ExpenseClaimSummary, policy: Pick<ExpensePolicy, 'updatedAt'>): ExpenseClaimSummary {
  if (summary.judgedPolicyUpdatedAt === undefined) return summary;
  return { ...summary, stale: summary.stale || summary.judgedPolicyUpdatedAt !== policy.updatedAt };
}

/** 画面・ツールで明細を指す短い呼び名（摘要 → 支払先 → 何件目）。 */
export function itemLabel(item: Pick<ExpenseItem, 'facts'>, index: number): string {
  return item.facts.description ?? item.facts.payeeName ?? `明細 ${index + 1}`;
}
