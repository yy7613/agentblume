/**
 * ドメイン: 入金明細 1 行（BankTransaction）集約（docs/22 §2.4）。
 *
 * 出金行は取り込まない（件数だけ報告する）ので、金額は常に正の整数。
 * 状態: `unmatched` → `matched`（消込の確定）/ `ignored`（利息・返金など消込対象外。戻せる）。
 * `judgment` は直近の判定で、確定時の前提チェック（判定の後に残高が変わっていないか）と画面の表示に使う。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { ReceivablesDomainError, ReceivablesStateError } from './errors';
import type { BankTransactionId, MatchingId } from './ids';
import { CANDIDATE_REASONS, MATCH_STAGES, NAME_MATCHES, UNMATCHED_REASONS, type MatchJudgment } from './matching';

export const BANK_TRANSACTION_STATUSES = ['unmatched', 'matched', 'ignored'] as const;
export type BankTransactionStatus = (typeof BANK_TRANSACTION_STATUSES)[number];

/** 明細に保存する判定（判定の時刻と、同じ請求を推す別の入金）。 */
export type StoredMatchJudgment = MatchJudgment & { readonly judgedAt: IsoDateTime; readonly contendedBy?: readonly string[] };

export interface BankTransactionSource {
  readonly fileName?: string;
  readonly profileId?: string;
  readonly row: { readonly [column: string]: string };
  /** ファイル上の行番号（表計算ソフトの行番号と一致させる）。 */
  readonly rowNumber: number;
}

export interface BankTransaction {
  readonly tenant: TenantScope;
  readonly id: BankTransactionId;
  readonly accountKey: string;
  readonly date: string;
  readonly amount: number;
  readonly description: string;
  readonly payerName: string;
  readonly payerNameNorm: string;
  readonly balance?: number;
  readonly source: BankTransactionSource;
  readonly fingerprint: string;
  readonly status: BankTransactionStatus;
  readonly judgment?: StoredMatchJudgment;
  readonly matchingId?: MatchingId;
  readonly ignoredNote?: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateBankTransactionProps extends Omit<BankTransaction, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'tenant'> {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly status?: BankTransactionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const fail: ErrorFactory = (message) => new ReceivablesDomainError(message);
const REASONS: readonly string[] = ['exact-amount-and-name', ...CANDIDATE_REASONS, ...UNMATCHED_REASONS];

/** 保存済みの判定の形を検証して複製する。 */
export function validateStoredMatchJudgment(value: StoredMatchJudgment): StoredMatchJudgment {
  if (value === null || typeof value !== 'object') throw fail('bank transaction judgment must be an object');
  if (!MATCH_STAGES.includes(value.stage)) throw fail(`bank transaction judgment.stage must be one of ${MATCH_STAGES.join(', ')}`);
  if (!REASONS.includes(value.reason)) throw fail(`bank transaction judgment.reason is unknown: ${String(value.reason)}`);
  assertIsoDateTime(value.judgedAt, 'bank transaction judgment.judgedAt', fail);
  if (!Array.isArray(value.candidates)) throw fail('bank transaction judgment.candidates must be an array');
  for (const candidate of value.candidates) {
    if (candidate === null || typeof candidate !== 'object' || !Array.isArray(candidate.invoiceIds) || !Array.isArray(candidate.allocations) || !NAME_MATCHES.includes(candidate.nameMatch)) {
      throw fail('bank transaction judgment.candidates has an invalid candidate');
    }
  }
  if (value.contendedBy !== undefined && (!Array.isArray(value.contendedBy) || value.contendedBy.some((id) => typeof id !== 'string'))) throw fail('bank transaction judgment.contendedBy must be an array of strings');
  return structuredClone(value);
}

export function createBankTransaction(props: CreateBankTransactionProps, makeId?: () => string): BankTransaction {
  if (props === null || typeof props !== 'object') throw fail('createBankTransaction: props are required');
  assertNonEmpty(props.tenant?.tenantId, 'createBankTransaction: tenant.tenantId', fail);
  assertNonEmpty(props.tenant?.workspaceId, 'createBankTransaction: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createBankTransaction: id', fail);
  assertNonEmpty(props.accountKey, 'bank transaction accountKey', fail);
  if (!isIsoDate(props.date)) throw fail('bank transaction date must be a date in YYYY-MM-DD');
  if (!Number.isSafeInteger(props.amount) || props.amount <= 0) throw fail('bank transaction amount must be a positive integer');
  if (typeof props.description !== 'string' || typeof props.payerName !== 'string' || typeof props.payerNameNorm !== 'string') throw fail('bank transaction description and payer name must be strings');
  if (props.balance !== undefined && !Number.isSafeInteger(props.balance)) throw fail('bank transaction balance must be an integer');
  assertNonEmpty(props.fingerprint, 'bank transaction fingerprint', fail);
  const status = props.status ?? 'unmatched';
  if (!BANK_TRANSACTION_STATUSES.includes(status)) throw fail(`bank transaction status must be one of ${BANK_TRANSACTION_STATUSES.join(', ')}`);
  if (status === 'matched' && props.matchingId === undefined) throw fail('a matched bank transaction must have a matchingId');
  if (status !== 'matched' && props.matchingId !== undefined) throw fail('only a matched bank transaction can have a matchingId');
  const source = props.source;
  if (source === null || typeof source !== 'object' || !Number.isInteger(source.rowNumber) || source.rowNumber < 1) throw fail('bank transaction source.rowNumber must be a positive integer');
  if (source.row === null || typeof source.row !== 'object' || Object.values(source.row).some((cell) => typeof cell !== 'string')) throw fail('bank transaction source.row must be an object of strings');
  assertIsoDateTime(props.createdAt, 'createBankTransaction: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createBankTransaction: updatedAt', fail);
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    accountKey: props.accountKey.trim(),
    date: props.date,
    amount: props.amount,
    description: props.description,
    payerName: props.payerName,
    payerNameNorm: props.payerNameNorm,
    ...(props.balance === undefined ? {} : { balance: props.balance }),
    source: {
      ...(source.fileName === undefined ? {} : { fileName: source.fileName }),
      ...(source.profileId === undefined ? {} : { profileId: source.profileId }),
      row: { ...source.row },
      rowNumber: source.rowNumber,
    },
    fingerprint: props.fingerprint,
    status,
    ...(props.judgment === undefined || status !== 'unmatched' && status !== 'matched' ? {} : { judgment: validateStoredMatchJudgment(props.judgment) }),
    ...(props.matchingId === undefined ? {} : { matchingId: props.matchingId }),
    ...(props.ignoredNote === undefined || status !== 'ignored' ? {} : { ignoredNote: props.ignoredNote }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

function requireStatus(transaction: BankTransaction, status: BankTransactionStatus, reason: 'transaction-not-unmatched' | 'transaction-not-ignored'): void {
  if (transaction.status !== status) throw new ReceivablesStateError(reason, `bank transaction ${transaction.id} is ${transaction.status}`, { transactionId: transaction.id, status: transaction.status });
}

export function withMatchJudgment(transaction: BankTransaction, judgment: StoredMatchJudgment, at: string): BankTransaction {
  requireStatus(transaction, 'unmatched', 'transaction-not-unmatched');
  return { ...transaction, judgment: validateStoredMatchJudgment(judgment), updatedAt: at };
}

export function markTransactionMatched(transaction: BankTransaction, matchingId: string, at: string): BankTransaction {
  requireStatus(transaction, 'unmatched', 'transaction-not-unmatched');
  return { ...transaction, status: 'matched', matchingId, updatedAt: at };
}

/** 消込の取消（matched → unmatched）。判定は古いので消す。 */
export function markTransactionUnmatched(transaction: BankTransaction, at: string): BankTransaction {
  if (transaction.status !== 'matched') throw new ReceivablesStateError('matching-not-confirmed', `bank transaction ${transaction.id} is ${transaction.status}`);
  const { matchingId: _matchingId, judgment: _judgment, ...rest } = transaction;
  return { ...rest, status: 'unmatched', updatedAt: at };
}

export function ignoreTransaction(transaction: BankTransaction, note: string | undefined, at: string): BankTransaction {
  requireStatus(transaction, 'unmatched', 'transaction-not-unmatched');
  const { judgment: _judgment, ...rest } = transaction;
  const trimmed = note?.trim() ?? '';
  return { ...rest, status: 'ignored', ...(trimmed === '' ? {} : { ignoredNote: trimmed }), updatedAt: at };
}

export function unignoreTransaction(transaction: BankTransaction, at: string): BankTransaction {
  requireStatus(transaction, 'ignored', 'transaction-not-ignored');
  const { ignoredNote: _note, ...rest } = transaction;
  return { ...rest, status: 'unmatched', updatedAt: at };
}
