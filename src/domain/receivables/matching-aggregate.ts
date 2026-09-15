/**
 * ドメイン: 消込の確定記録（Matching）集約（docs/22 §2.5）。
 *
 * 不変条件は `Σ allocations.amount = 入金額 + feeAmount`（手数料差額の分だけ請求を多く消す）。
 * 入金額を記録に持つのは、読み戻したときにもこの不変条件を検証できるようにするため。
 * 取消は論理（`cancelled`）で、監査のために記録は残す。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ReceivablesDomainError, ReceivablesStateError } from './errors';
import type { BankTransactionId, MatchingId } from './ids';
import { HARD_MAX_COMBINATION_SIZE } from './settings';

export const MATCHING_STATUSES = ['confirmed', 'cancelled'] as const;
export type MatchingStatus = (typeof MATCHING_STATUSES)[number];
export const MATCHING_DECIDED_BY = ['judgment', 'manual'] as const;
export type MatchingDecidedBy = (typeof MATCHING_DECIDED_BY)[number];
/** 仕訳の下書きをどうしたか。`kept` は確定済みの仕訳を上書きしなかった、`disabled` は連携が無効だった。 */
export const JOURNAL_DRAFT_OUTCOMES = ['created', 'updated', 'kept', 'disabled'] as const;
export type JournalDraftOutcome = (typeof JOURNAL_DRAFT_OUTCOMES)[number];

export interface Matching {
  readonly tenant: TenantScope;
  readonly id: MatchingId;
  readonly transactionId: BankTransactionId;
  readonly transactionAmount: number;
  readonly customerId?: string;
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: number }[];
  readonly feeAmount: number;
  readonly status: MatchingStatus;
  readonly decidedBy: MatchingDecidedBy;
  readonly judgmentReason?: string;
  readonly learnedAlias?: { readonly customerId: string; readonly aliasId: string };
  readonly journal: { readonly entryId?: string; readonly outcome?: JournalDraftOutcome };
  readonly confirmedAt: IsoDateTime;
  readonly cancelledAt?: IsoDateTime;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateMatchingProps extends Omit<Matching, 'id' | 'status' | 'journal' | 'tenant'> {
  readonly tenant: TenantScope;
  readonly id?: string;
  readonly status?: MatchingStatus;
  readonly journal?: Matching['journal'];
}

const fail: ErrorFactory = (message) => new ReceivablesDomainError(message);

/** 配分の合計が入金額 + 手数料と合うか（確定の前提チェックでも使う）。 */
export function allocationSumMatches(allocations: readonly { readonly amount: number }[], transactionAmount: number, feeAmount: number): boolean {
  return allocations.reduce((total, allocation) => total + allocation.amount, 0) === transactionAmount + feeAmount;
}

export function createMatching(props: CreateMatchingProps, makeId?: () => string): Matching {
  if (props === null || typeof props !== 'object') throw fail('createMatching: props are required');
  assertNonEmpty(props.tenant?.tenantId, 'createMatching: tenant.tenantId', fail);
  assertNonEmpty(props.tenant?.workspaceId, 'createMatching: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createMatching: id', fail);
  assertNonEmpty(props.transactionId, 'matching transactionId', fail);
  if (!Number.isSafeInteger(props.transactionAmount) || props.transactionAmount <= 0) throw fail('matching transactionAmount must be a positive integer');
  if (!Array.isArray(props.allocations) || props.allocations.length === 0 || props.allocations.length > HARD_MAX_COMBINATION_SIZE) throw fail(`matching allocations must have 1 to ${HARD_MAX_COMBINATION_SIZE} entries`);
  const seen = new Set<string>();
  const allocations = props.allocations.map((allocation, index) => {
    if (allocation === null || typeof allocation !== 'object') throw fail(`matching allocations[${index}] must be an object`);
    assertNonEmpty(allocation.invoiceId, `matching allocations[${index}].invoiceId`, fail);
    if (seen.has(allocation.invoiceId)) throw fail(`matching allocations[${index}].invoiceId is duplicated: ${allocation.invoiceId}`);
    seen.add(allocation.invoiceId);
    if (!Number.isSafeInteger(allocation.amount) || allocation.amount <= 0) throw fail(`matching allocations[${index}].amount must be a positive integer`);
    return { invoiceId: allocation.invoiceId, amount: allocation.amount };
  });
  if (!Number.isSafeInteger(props.feeAmount) || props.feeAmount < 0) throw fail('matching feeAmount must be a non-negative integer');
  if (!allocationSumMatches(allocations, props.transactionAmount, props.feeAmount)) throw fail('matching allocations must sum to the transaction amount plus the fee');
  const status = props.status ?? 'confirmed';
  if (!MATCHING_STATUSES.includes(status)) throw fail(`matching status must be one of ${MATCHING_STATUSES.join(', ')}`);
  if (!MATCHING_DECIDED_BY.includes(props.decidedBy)) throw fail(`matching decidedBy must be one of ${MATCHING_DECIDED_BY.join(', ')}`);
  assertIsoDateTime(props.confirmedAt, 'matching confirmedAt', fail);
  if (status === 'cancelled') assertIsoDateTime(props.cancelledAt, 'matching cancelledAt', fail);
  assertIsoDateTime(props.createdAt, 'createMatching: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createMatching: updatedAt', fail);
  const journal = props.journal ?? {};
  if (journal.outcome !== undefined && !JOURNAL_DRAFT_OUTCOMES.includes(journal.outcome)) throw fail(`matching journal.outcome must be one of ${JOURNAL_DRAFT_OUTCOMES.join(', ')}`);
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id,
    transactionId: props.transactionId,
    transactionAmount: props.transactionAmount,
    ...(props.customerId === undefined ? {} : { customerId: props.customerId }),
    allocations,
    feeAmount: props.feeAmount,
    status,
    decidedBy: props.decidedBy,
    ...(props.judgmentReason === undefined ? {} : { judgmentReason: props.judgmentReason }),
    ...(props.learnedAlias === undefined ? {} : { learnedAlias: { customerId: props.learnedAlias.customerId, aliasId: props.learnedAlias.aliasId } }),
    journal: {
      ...(journal.entryId === undefined ? {} : { entryId: journal.entryId }),
      ...(journal.outcome === undefined ? {} : { outcome: journal.outcome }),
    },
    confirmedAt: props.confirmedAt,
    ...(status === 'cancelled' && props.cancelledAt !== undefined ? { cancelledAt: props.cancelledAt } : {}),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

export function cancelMatching(matching: Matching, at: string): Matching {
  if (matching.status !== 'confirmed') throw new ReceivablesStateError('matching-not-confirmed', `matching ${matching.id} is already ${matching.status}`);
  return createMatching({ ...matching, status: 'cancelled', cancelledAt: at, updatedAt: at });
}

export function withMatchingJournal(matching: Matching, journal: Matching['journal'], at: string): Matching {
  return createMatching({ ...matching, journal, updatedAt: at });
}
