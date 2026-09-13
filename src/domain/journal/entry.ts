/**
 * ドメイン: 仕訳（JournalEntry）集約（docs/20 §2.4）。
 *
 * 借方合計 = 貸方合計 を不変条件にする。各行は科目 id と**確定時の科目名**（`accountName`）の両方を持ち、
 * マスタで改名されても仕訳は当時の名称を保つ。状態は `draft` → `confirmed` → `exported`。
 *
 * 形は UI の `JournalEntryDto` と同型（テナントスコープ `tenant` を除く）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { INVOICE_STATUSES, isIsoDate, REGISTRATION_NUMBER_PATTERN, type InvoiceStatus } from './document';
import { JournalDomainError } from './errors';
import type { JournalDocumentId, JournalEntryId, JournalRuleId } from './ids';
import { ENTRY_SIDES, type EntrySide } from './rule';

export const ENTRY_STATUSES = ['draft', 'confirmed', 'exported'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const DECIDED_BY = ['rule', 'hearing', 'manual'] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];

export interface JournalEntryLine {
  readonly side: EntrySide;
  readonly accountId: string;
  /** 確定時の科目名を写す（マスタの改名に影響されない）。 */
  readonly accountName: string;
  readonly dimensionValues?: { readonly [dimensionId: string]: string };
  readonly taxCode: string;
  /** 税込整数（円）、正。 */
  readonly amount: number;
  readonly taxAmount?: number;
  readonly partner?: string;
}

/** 仕訳の草案（判定結果・ヒアリング提案・手入力の共通形）。 */
export interface JournalEntryDraft {
  readonly date: string;
  readonly lines: readonly JournalEntryLine[];
  readonly description: string;
  readonly invoiceStatus: InvoiceStatus;
  readonly registrationNumber?: string;
  readonly item?: string;
  readonly tags?: readonly string[];
}

export interface JournalEntry extends JournalEntryDraft {
  readonly tenant: TenantScope;
  readonly id: JournalEntryId;
  readonly documentId?: JournalDocumentId;
  readonly ruleId?: JournalRuleId;
  readonly status: EntryStatus;
  readonly decidedBy: DecidedBy;
  readonly confidence?: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateJournalEntryProps extends JournalEntryDraft {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly documentId?: string;
  readonly ruleId?: string;
  readonly status?: EntryStatus;
  readonly decidedBy: DecidedBy;
  readonly confidence?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const ENTRY_MAX_LINES = 100;

const fail: ErrorFactory = (message) => new JournalDomainError(message);

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw fail(`${label} must be a string`);
  return value;
}

/** 貸借合計。 */
export function entryTotals(lines: readonly JournalEntryLine[]): { readonly debit: number; readonly credit: number } {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (line.side === 'debit') debit += line.amount;
    else credit += line.amount;
  }
  return { debit, credit };
}

function validateLine(value: JournalEntryLine, index: number, label: string): JournalEntryLine {
  const lineLabel = `${label}.lines[${index}]`;
  if (value === null || typeof value !== 'object') throw fail(`${lineLabel} must be an object`);
  if (!ENTRY_SIDES.includes(value.side)) throw fail(`${lineLabel}.side must be debit or credit`);
  assertNonEmpty(value.accountId, `${lineLabel}.accountId`, fail);
  assertNonEmpty(value.accountName, `${lineLabel}.accountName`, fail);
  assertNonEmpty(value.taxCode, `${lineLabel}.taxCode`, fail);
  if (!Number.isInteger(value.amount) || value.amount <= 0) throw fail(`${lineLabel}.amount must be a positive integer`);
  if (value.taxAmount !== undefined && (!Number.isInteger(value.taxAmount) || value.taxAmount < 0 || value.taxAmount > value.amount)) throw fail(`${lineLabel}.taxAmount must be an integer between 0 and amount`);
  let dimensionValues: JournalEntryLine['dimensionValues'];
  if (value.dimensionValues !== undefined) {
    if (value.dimensionValues === null || typeof value.dimensionValues !== 'object' || Array.isArray(value.dimensionValues) || Object.values(value.dimensionValues).some((entry) => typeof entry !== 'string')) {
      throw fail(`${lineLabel}.dimensionValues must be an object of strings`);
    }
    dimensionValues = { ...value.dimensionValues };
  }
  const partner = optionalString(value.partner, `${lineLabel}.partner`);
  return {
    side: value.side,
    accountId: value.accountId.trim(),
    accountName: value.accountName.trim(),
    ...(dimensionValues === undefined ? {} : { dimensionValues }),
    taxCode: value.taxCode.trim(),
    amount: value.amount,
    ...(value.taxAmount === undefined ? {} : { taxAmount: value.taxAmount }),
    ...(partner === undefined || partner.trim() === '' ? {} : { partner: partner.trim() }),
  };
}

/** 草案の不変条件（日付・行・貸借一致）を検証して複製する。判定結果と手入力の両方が通す。 */
export function validateJournalEntryDraft(value: JournalEntryDraft, label = 'createJournalEntry'): JournalEntryDraft {
  if (value === null || typeof value !== 'object') throw fail(`${label}: draft must be an object`);
  if (!isIsoDate(value.date)) throw fail(`${label}: date must be a date in YYYY-MM-DD`);
  if (typeof value.description !== 'string') throw fail(`${label}: description must be a string`);
  if (!INVOICE_STATUSES.includes(value.invoiceStatus)) throw fail(`${label}: invoiceStatus must be one of ${INVOICE_STATUSES.join(', ')}`);
  if (!Array.isArray(value.lines)) throw fail(`${label}: lines must be an array`);
  if (value.lines.length > ENTRY_MAX_LINES) throw fail(`${label}: lines must have at most ${ENTRY_MAX_LINES} entries`);
  const lines = value.lines.map((line, index) => validateLine(line, index, label));
  if (!lines.some((line) => line.side === 'debit') || !lines.some((line) => line.side === 'credit')) throw fail(`${label}: lines must include at least one debit and one credit`);
  const totals = entryTotals(lines);
  if (totals.debit !== totals.credit) throw fail(`${label}: debit total (${totals.debit}) must equal credit total (${totals.credit})`);
  const registrationNumber = optionalString(value.registrationNumber, `${label}: registrationNumber`);
  if (registrationNumber !== undefined && !REGISTRATION_NUMBER_PATTERN.test(registrationNumber)) throw fail(`${label}: registrationNumber must be T followed by 13 digits`);
  const item = optionalString(value.item, `${label}: item`);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string'))) throw fail(`${label}: tags must be an array of strings`);
  return {
    date: value.date,
    lines,
    description: value.description.trim(),
    invoiceStatus: value.invoiceStatus,
    ...(registrationNumber === undefined ? {} : { registrationNumber }),
    ...(item === undefined || item.trim() === '' ? {} : { item: item.trim() }),
    ...(value.tags === undefined ? {} : { tags: value.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0) }),
  };
}

/** 仕訳を組み立てて不変条件を検証する。`id` が無いときは `makeId` で生成する。 */
export function createJournalEntry(props: CreateJournalEntryProps, makeId?: () => string): JournalEntry {
  if (props === null || typeof props !== 'object') throw fail('createJournalEntry: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('createJournalEntry: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'createJournalEntry: tenant.tenantId', fail);
  assertNonEmpty(props.tenant.workspaceId, 'createJournalEntry: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createJournalEntry: id', fail);
  const status = props.status ?? 'draft';
  if (!ENTRY_STATUSES.includes(status)) throw fail(`createJournalEntry: status must be one of ${ENTRY_STATUSES.join(', ')}`);
  if (!DECIDED_BY.includes(props.decidedBy)) throw fail(`createJournalEntry: decidedBy must be one of ${DECIDED_BY.join(', ')}`);
  if (props.confidence !== undefined && (typeof props.confidence !== 'number' || props.confidence < 0 || props.confidence > 1)) throw fail('createJournalEntry: confidence must be between 0 and 1');
  assertIsoDateTime(props.createdAt, 'createJournalEntry: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createJournalEntry: updatedAt', fail);
  const documentId = optionalString(props.documentId, 'createJournalEntry: documentId');
  const ruleId = optionalString(props.ruleId, 'createJournalEntry: ruleId');
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    ...(documentId === undefined ? {} : { documentId }),
    ...(ruleId === undefined ? {} : { ruleId }),
    ...validateJournalEntryDraft(props),
    status,
    decidedBy: props.decidedBy,
    ...(props.confidence === undefined ? {} : { confidence: props.confidence }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/** 確定（draft → confirmed）。confirmed は冪等、exported は戻せない。 */
export function confirmEntry(entry: JournalEntry, at: string): JournalEntry {
  assertIsoDateTime(at, 'confirmEntry: at', fail);
  if (entry.status === 'confirmed') return entry;
  if (entry.status === 'exported') throw fail('confirmEntry: an exported entry cannot be confirmed again');
  return { ...entry, status: 'confirmed', updatedAt: at };
}

/** CSV に出したことを反映する（draft / confirmed → exported）。 */
export function markEntryExported(entry: JournalEntry, at: string): JournalEntry {
  assertIsoDateTime(at, 'markEntryExported: at', fail);
  if (entry.status === 'exported') return entry;
  return { ...entry, status: 'exported', updatedAt: at };
}
