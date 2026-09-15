/**
 * ドメイン: 法人カード（カードと列マッピングの設定・取込・利用行）の型と不変条件（docs/21 §20.2.8。UC5。取込・照合は B）。
 *
 * - 設定（`ExpenseCardSettings`）はワークスペースに 1 つ（`expense_settings` の kind `cards`）。
 * - 取込 1 回（`ExpenseCardImport`）と利用 1 行（`ExpenseCardTransaction`）は別テーブル。同じファイルは SHA-256 で、
 *   期間の重なるファイルの同じ行は `dedupeKey` で 1 件にする（DB の一意制約）。
 * - 状態: `unmatched → matched`（照合 / 手動の紐付け）、`matched → unmatched`（解除）、`unmatched ⇄ excluded`（対象外の印）。
 *   ここは保存済みの値の整合（状態と記録の対応）だけを検証する。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { ExpenseDomainError } from './errors';
import type { ExpenseCardId, ExpenseCardImportId, ExpenseCardTransactionId } from './ids';

export const CARD_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
export const CARD_SETTINGS_MAX_CARDS = 100;
export const CARD_SETTINGS_MAX_PROFILES = 30;
export const CARD_SKIP_LINES_MAX = 20;
export const DEFAULT_CARD_SETTINGS_UPDATED_AT = '2026-09-15T00:00:00.000Z';

export const CARD_AMOUNT_SIGNS = ['charge-positive', 'charge-negative'] as const;
export type CardAmountSign = (typeof CARD_AMOUNT_SIGNS)[number];

export interface ExpenseCard {
  readonly id: ExpenseCardId;
  readonly label: string;
  readonly issuerName?: string;
  /** カード番号の下 4 桁（それ以上は保存しない）。 */
  readonly last4: string;
  /** 保有者。共用カードは空（照合で申請者と比べない）。 */
  readonly holderEmployeeId?: string;
  readonly enabled: boolean;
}

/** 明細 CSV の列 → 項目（見出しの文字列）。 */
export interface CardColumnMapping {
  readonly usedOn: string;
  readonly merchant: string;
  readonly amount: string;
  readonly postedOn?: string;
  readonly cardLast4?: string;
  readonly memo?: string;
}

export interface CardStatementProfile {
  readonly id: string;
  readonly name: string;
  /** `normalizeHeader` 済みの見出しの並び（次回から自動で選ぶ鍵）。 */
  readonly headerSignature: readonly string[];
  readonly columns: CardColumnMapping;
  readonly amountSign: CardAmountSign;
  readonly skipLinesBefore: number;
}

export interface ExpenseCardSettings {
  readonly cards: readonly ExpenseCard[];
  readonly profiles: readonly CardStatementProfile[];
  readonly updatedAt: IsoDateTime;
}

export interface CardImportMapping {
  readonly columns: CardColumnMapping;
  readonly amountSign: CardAmountSign;
  readonly skipLinesBefore: number;
}

export interface ExpenseCardImport {
  readonly tenant: TenantScope;
  readonly id: ExpenseCardImportId;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly profileId?: string;
  /** 取込時の写し（プロファイルを後で変えても、この取込の読み方は変わらない）。 */
  readonly mapping: CardImportMapping;
  readonly cardId?: string;
  readonly rowCount: number;
  readonly importedCount: number;
  readonly duplicateCount: number;
  readonly skippedRows: readonly { readonly row: number; readonly reason: string }[];
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly by: string;
  readonly createdAt: IsoDateTime;
}

export const CARD_TRANSACTION_STATUSES = ['unmatched', 'matched', 'excluded'] as const;
export type CardTransactionStatus = (typeof CARD_TRANSACTION_STATUSES)[number];
export const CARD_MATCH_KINDS = ['corporate-item', 'reimbursement-item'] as const;
export type CardMatchKind = (typeof CARD_MATCH_KINDS)[number];
export const CARD_MATCH_STRENGTHS = ['strong', 'weak'] as const;
export type CardMatchStrength = (typeof CARD_MATCH_STRENGTHS)[number];

export interface CardMatch {
  readonly claimId: string;
  readonly itemId: string;
  /** `corporate-item` = 会社払いの明細（正常）。`reimbursement-item` = 立替の明細（二重計上の疑い）。 */
  readonly kind: CardMatchKind;
  readonly strength: CardMatchStrength;
  readonly dateDiffDays: number;
  readonly amountDiff: number;
  /** 手動の紐付け（照合のやり直しで上書きしない）。 */
  readonly manual: boolean;
  readonly at: IsoDateTime;
  readonly by?: string;
}

export interface ExpenseCardTransaction {
  readonly tenant: TenantScope;
  readonly id: ExpenseCardTransactionId;
  readonly importId: string;
  readonly cardId: string;
  readonly usedOn: string;
  readonly postedOn?: string;
  readonly merchantRaw: string;
  /** `payeeKeyOf(merchantRaw)`（空の加盟店名は空文字）。 */
  readonly merchantKey: string;
  /** 符号付き整数（返金は負）。 */
  readonly amount: number;
  readonly memo?: string;
  /** CSV の生値（列名 → 値）。 */
  readonly row: Readonly<Record<string, string>>;
  readonly dedupeKey: string;
  readonly status: CardTransactionStatus;
  readonly match?: CardMatch;
  readonly exclusion?: { readonly reason: string; readonly by: string; readonly at: IsoDateTime };
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

/** 照合の候補になる明細（`ExpenseClaimRepository.findCardCandidates` の 1 行）。 */
export interface CardMatchableItem {
  readonly claimId: string;
  readonly itemId: string;
  readonly claimStatus: string;
  readonly employeeId?: string;
  readonly transactionDate: string;
  readonly amount: number;
  readonly payeeKey?: string;
  readonly corporate: boolean;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) throw fail(`${label} must be 1 to ${max} characters`);
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, label, max);
}

function date(value: unknown, label: string): string {
  if (!isIsoDate(value)) throw fail(`${label} must be a date in YYYY-MM-DD`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw fail(`${label} must be a non-negative integer`);
  return value;
}

function validateMapping(value: unknown, label: string): CardColumnMapping {
  const raw = obj(value, label);
  return withDefined({
    usedOn: text(raw['usedOn'], `${label}.usedOn`, 200),
    merchant: text(raw['merchant'], `${label}.merchant`, 200),
    amount: text(raw['amount'], `${label}.amount`, 200),
    postedOn: optionalText(raw['postedOn'], `${label}.postedOn`, 200),
    cardLast4: optionalText(raw['cardLast4'], `${label}.cardLast4`, 200),
    memo: optionalText(raw['memo'], `${label}.memo`, 200),
  });
}

function validateImportMapping(value: unknown, label: string): CardImportMapping {
  const raw = obj(value, label);
  if (!(CARD_AMOUNT_SIGNS as readonly unknown[]).includes(raw['amountSign'])) throw fail(`${label}.amountSign must be one of ${CARD_AMOUNT_SIGNS.join(', ')}`);
  const skip = raw['skipLinesBefore'];
  if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0 || skip > CARD_SKIP_LINES_MAX) throw fail(`${label}.skipLinesBefore must be an integer between 0 and ${CARD_SKIP_LINES_MAX}`);
  return { columns: validateMapping(raw['columns'], `${label}.columns`), amountSign: raw['amountSign'] as CardAmountSign, skipLinesBefore: skip };
}

export function createExpenseCardSettings(props: { readonly cards?: readonly ExpenseCard[]; readonly profiles?: readonly CardStatementProfile[]; readonly updatedAt: string }): ExpenseCardSettings {
  if (props === null || typeof props !== 'object') throw fail('expense card settings: props are required');
  const rawCards = props.cards ?? [];
  if (!Array.isArray(rawCards) || rawCards.length > CARD_SETTINGS_MAX_CARDS) throw fail(`expense card settings: cards must have at most ${CARD_SETTINGS_MAX_CARDS} entries`);
  const cards = rawCards.map((entry: unknown, index): ExpenseCard => {
    const label = `expense card settings: cards[${index}]`;
    const raw = obj(entry, label);
    if (typeof raw['id'] !== 'string' || !CARD_ID_PATTERN.test(raw['id'])) throw fail(`${label}.id must match ${CARD_ID_PATTERN.source}`);
    if (typeof raw['last4'] !== 'string' || !/^\d{4}$/u.test(raw['last4'])) throw fail(`${label}.last4 must be 4 digits`);
    if (typeof raw['enabled'] !== 'boolean') throw fail(`${label}.enabled must be a boolean`);
    return withDefined({ id: raw['id'], label: text(raw['label'], `${label}.label`, 100), issuerName: optionalText(raw['issuerName'], `${label}.issuerName`, 100), last4: raw['last4'], holderEmployeeId: optionalText(raw['holderEmployeeId'], `${label}.holderEmployeeId`, 64), enabled: raw['enabled'] });
  });
  if (new Set(cards.map((card) => card.id)).size !== cards.length) throw fail('expense card settings: card ids must be unique');
  const rawProfiles = props.profiles ?? [];
  if (!Array.isArray(rawProfiles) || rawProfiles.length > CARD_SETTINGS_MAX_PROFILES) throw fail(`expense card settings: profiles must have at most ${CARD_SETTINGS_MAX_PROFILES} entries`);
  const profiles = rawProfiles.map((entry: unknown, index): CardStatementProfile => {
    const label = `expense card settings: profiles[${index}]`;
    const raw = obj(entry, label);
    if (typeof raw['id'] !== 'string' || !CARD_ID_PATTERN.test(raw['id'])) throw fail(`${label}.id must match ${CARD_ID_PATTERN.source}`);
    const signature = raw['headerSignature'];
    if (!Array.isArray(signature) || signature.length === 0 || signature.length > 100 || signature.some((header) => typeof header !== 'string')) throw fail(`${label}.headerSignature must be 1 to 100 header names`);
    const mapping = validateImportMapping({ columns: raw['columns'], amountSign: raw['amountSign'], skipLinesBefore: raw['skipLinesBefore'] }, label);
    return { id: raw['id'], name: text(raw['name'], `${label}.name`, 100), headerSignature: [...signature as string[]], ...mapping };
  });
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw fail('expense card settings: profile ids must be unique');
  assertIsoDateTime(props.updatedAt, 'expense card settings: updatedAt', fail);
  return { cards, profiles, updatedAt: props.updatedAt };
}

export function emptyExpenseCardSettings(updatedAt: string = DEFAULT_CARD_SETTINGS_UPDATED_AT): ExpenseCardSettings {
  return { cards: [], profiles: [], updatedAt };
}

export function createExpenseCardImport(props: ExpenseCardImport): ExpenseCardImport {
  if (props === null || typeof props !== 'object') throw fail('expense card import: props are required');
  const tenant = obj(props.tenant, 'expense card import: tenant');
  assertNonEmpty(tenant['tenantId'], 'expense card import: tenant.tenantId', fail);
  assertNonEmpty(tenant['workspaceId'], 'expense card import: tenant.workspaceId', fail);
  assertNonEmpty(props.id, 'expense card import: id', fail);
  if (typeof props.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(props.fileSha256)) throw fail('expense card import: fileSha256 must be a lowercase SHA-256 hex digest');
  const periodFrom = date(props.periodFrom, 'expense card import: periodFrom');
  const periodTo = date(props.periodTo, 'expense card import: periodTo');
  if (periodFrom > periodTo) throw fail('expense card import: periodFrom must not be after periodTo');
  if (!Array.isArray(props.skippedRows)) throw fail('expense card import: skippedRows must be an array');
  const skippedRows = props.skippedRows.map((entry, index) => {
    const raw = obj(entry, `expense card import: skippedRows[${index}]`);
    return { row: count(raw['row'], `expense card import: skippedRows[${index}].row`), reason: text(raw['reason'], `expense card import: skippedRows[${index}].reason`, 500) };
  });
  const rowCount = count(props.rowCount, 'expense card import: rowCount');
  const importedCount = count(props.importedCount, 'expense card import: importedCount');
  const duplicateCount = count(props.duplicateCount, 'expense card import: duplicateCount');
  if (importedCount + duplicateCount + skippedRows.length > rowCount) throw fail('expense card import: imported, duplicate and skipped rows must not exceed rowCount');
  assertNonEmpty(props.by, 'expense card import: by', fail);
  assertIsoDateTime(props.createdAt, 'expense card import: createdAt', fail);
  return withDefined({
    tenant: { tenantId: tenant['tenantId'] as string, workspaceId: tenant['workspaceId'] as string },
    id: props.id,
    fileName: text(props.fileName, 'expense card import: fileName', 255),
    fileSha256: props.fileSha256,
    profileId: optionalText(props.profileId, 'expense card import: profileId', 64),
    mapping: validateImportMapping(props.mapping, 'expense card import: mapping'),
    cardId: optionalText(props.cardId, 'expense card import: cardId', 64),
    rowCount,
    importedCount,
    duplicateCount,
    skippedRows,
    periodFrom,
    periodTo,
    by: props.by,
    createdAt: props.createdAt,
  });
}

/** 行の重複キー（`cardId|usedOn|amount|merchantKey|n`。`n` は同じファイル内で同じ組の何件目か）。 */
export function cardDedupeKey(cardId: string, usedOn: string, amount: number, merchantKey: string, occurrence: number): string {
  return `${cardId}|${usedOn}|${amount}|${merchantKey}|${occurrence}`;
}

export function createExpenseCardTransaction(props: ExpenseCardTransaction): ExpenseCardTransaction {
  if (props === null || typeof props !== 'object') throw fail('expense card transaction: props are required');
  const tenant = obj(props.tenant, 'expense card transaction: tenant');
  assertNonEmpty(tenant['tenantId'], 'expense card transaction: tenant.tenantId', fail);
  assertNonEmpty(tenant['workspaceId'], 'expense card transaction: tenant.workspaceId', fail);
  for (const key of ['id', 'importId', 'cardId', 'dedupeKey'] as const) assertNonEmpty(props[key], `expense card transaction: ${key}`, fail);
  if (typeof props.amount !== 'number' || !Number.isSafeInteger(props.amount) || props.amount === 0) throw fail('expense card transaction: amount must be a non-zero integer');
  if (typeof props.merchantRaw !== 'string' || props.merchantRaw.length > 200) throw fail('expense card transaction: merchantRaw must be a string of at most 200 characters');
  if (typeof props.merchantKey !== 'string') throw fail('expense card transaction: merchantKey must be a string');
  const row = obj(props.row, 'expense card transaction: row');
  if (Object.values(row).some((cell) => typeof cell !== 'string')) throw fail('expense card transaction: row must be an object of strings');
  if (!CARD_TRANSACTION_STATUSES.includes(props.status)) throw fail(`expense card transaction: status must be one of ${CARD_TRANSACTION_STATUSES.join(', ')}`);
  let match: CardMatch | undefined;
  if (props.match !== undefined) {
    const raw = obj(props.match, 'expense card transaction: match');
    if (!(CARD_MATCH_KINDS as readonly unknown[]).includes(raw['kind'])) throw fail(`expense card transaction: match.kind must be one of ${CARD_MATCH_KINDS.join(', ')}`);
    if (!(CARD_MATCH_STRENGTHS as readonly unknown[]).includes(raw['strength'])) throw fail(`expense card transaction: match.strength must be one of ${CARD_MATCH_STRENGTHS.join(', ')}`);
    assertNonEmpty(raw['claimId'], 'expense card transaction: match.claimId', fail);
    assertNonEmpty(raw['itemId'], 'expense card transaction: match.itemId', fail);
    if (typeof raw['dateDiffDays'] !== 'number' || !Number.isInteger(raw['dateDiffDays']) || typeof raw['amountDiff'] !== 'number' || !Number.isInteger(raw['amountDiff'])) throw fail('expense card transaction: match.dateDiffDays and amountDiff must be integers');
    if (typeof raw['manual'] !== 'boolean') throw fail('expense card transaction: match.manual must be a boolean');
    assertIsoDateTime(raw['at'], 'expense card transaction: match.at', fail);
    match = withDefined({ claimId: raw['claimId'] as string, itemId: raw['itemId'] as string, kind: raw['kind'] as CardMatchKind, strength: raw['strength'] as CardMatchStrength, dateDiffDays: raw['dateDiffDays'], amountDiff: raw['amountDiff'], manual: raw['manual'], at: raw['at'] as string, by: optionalText(raw['by'], 'expense card transaction: match.by', 256) });
  }
  let exclusion: ExpenseCardTransaction['exclusion'];
  if (props.exclusion !== undefined) {
    const raw = obj(props.exclusion, 'expense card transaction: exclusion');
    assertNonEmpty(raw['by'], 'expense card transaction: exclusion.by', fail);
    assertIsoDateTime(raw['at'], 'expense card transaction: exclusion.at', fail);
    exclusion = { reason: text(raw['reason'], 'expense card transaction: exclusion.reason', 200), by: raw['by'] as string, at: raw['at'] as string };
  }
  if ((props.status === 'matched') !== (match !== undefined)) throw fail('expense card transaction: a matched transaction must have a match, and only a matched one');
  if ((props.status === 'excluded') !== (exclusion !== undefined)) throw fail('expense card transaction: an excluded transaction must have an exclusion, and only an excluded one');
  assertIsoDateTime(props.createdAt, 'expense card transaction: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'expense card transaction: updatedAt', fail);
  return withDefined({
    tenant: { tenantId: tenant['tenantId'] as string, workspaceId: tenant['workspaceId'] as string },
    id: props.id,
    importId: props.importId,
    cardId: props.cardId,
    usedOn: date(props.usedOn, 'expense card transaction: usedOn'),
    postedOn: props.postedOn === undefined ? undefined : date(props.postedOn, 'expense card transaction: postedOn'),
    merchantRaw: props.merchantRaw,
    merchantKey: props.merchantKey,
    amount: props.amount,
    memo: optionalText(props.memo, 'expense card transaction: memo', 500),
    row: { ...(row as Record<string, string>) },
    dedupeKey: props.dedupeKey,
    status: props.status,
    match,
    exclusion,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
}
