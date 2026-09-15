/**
 * ドメイン: 仮払（ExpenseAdvance）集約の型と不変条件（docs/21 §20.2.7。UC4。遷移・精算の計算・仕訳は B）。
 *
 * 経費申請は `claim.advanceId` で仮払を指す（正本は申請側の 1 か所。仮払側に申請の一覧を持たない）。
 * 精算の差額は他の申請の支払額と相殺しない（誰のどのお金かが帳簿と振込の両方で追えなくなるため。ADR-0043 §7）。
 *
 * ここは保存済みの値に課す整合（状態ごとに要る記録・差額の計算）だけを検証する。遷移関数（`advance-transitions.ts`）は B が書く。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { ExpenseDomainError } from './errors';
import type { ExpenseAdvanceId, ExpenseEmployeeId } from './ids';

export const ADVANCE_STATUSES = ['requested', 'approved', 'paid', 'settling', 'settled', 'cancelled'] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];
export const ADVANCE_PAYMENT_METHODS = ['transfer', 'cash'] as const;
export type AdvancePaymentMethod = (typeof ADVANCE_PAYMENT_METHODS)[number];
export const ADDITIONAL_PAYMENT_STATUSES = ['pending', 'exported', 'paid'] as const;
export type AdditionalPaymentStatus = (typeof ADDITIONAL_PAYMENT_STATUSES)[number];

export const ADVANCE_AMOUNT_MAX = 10_000_000;
export const ADVANCE_PURPOSE_MAX = 500;
export const ADVANCE_HISTORY_MAX = 100;
/** 1 仮払に紐付けられる申請の上限（§20.2.3）。 */
export const ADVANCE_MAX_CLAIMS = 20;

export const ADVANCE_HISTORY_TYPES = ['requested', 'edited', 'approved', 'cancelled', 'paid', 'unpaid', 'settling', 'settled', 'refund-received', 'additional-paid', 'journal-drafted', 'payout-exported', 'payout-cancelled'] as const;
export type AdvanceHistoryType = (typeof ADVANCE_HISTORY_TYPES)[number];

export interface AdvanceApproval { readonly by: string; readonly employeeId?: string; readonly at: IsoDateTime; readonly comment?: string; readonly proxy: boolean }
export interface AdvancePayment { readonly paidOn: string; readonly method: AdvancePaymentMethod; readonly by: string; readonly at: IsoDateTime; readonly payoutBatchId?: string }
export interface AdvanceAdditionalPayment { readonly amount: number; readonly status: AdditionalPaymentStatus; readonly payoutBatchId?: string; readonly paidOn?: string }
export interface AdvanceRefund { readonly amount: number; readonly receivedOn?: string; readonly by?: string }

export interface AdvanceSettlement {
  readonly computedAt: IsoDateTime;
  readonly claimIds: readonly string[];
  /** 紐付く申請の `reimbursableAmount` の合計。 */
  readonly claimsTotal: number;
  /** `claimsTotal − amount`。正 = 追加支給、負 = 返金。 */
  readonly difference: number;
  readonly additionalPayment?: AdvanceAdditionalPayment;
  readonly refund?: AdvanceRefund;
  readonly settledOn?: string;
}

export interface AdvanceJournalLink { readonly paymentEntryId?: string; readonly settlementEntryId?: string; readonly warnings: readonly string[] }
export interface AdvanceHistoryEvent { readonly type: AdvanceHistoryType; readonly by?: string; readonly at: IsoDateTime; readonly note?: string; readonly proxy?: boolean }

export interface ExpenseAdvance {
  readonly tenant: TenantScope;
  readonly id: ExpenseAdvanceId;
  readonly employeeId: ExpenseEmployeeId;
  /** 申請時点の写し（従業員マスタが変わっても仮払の表示は変えない）。 */
  readonly employeeSnapshot: { readonly name: string; readonly departmentId?: string };
  readonly purpose: string;
  readonly amount: number;
  readonly neededOn: string;
  readonly plannedSettleBy: string;
  readonly status: AdvanceStatus;
  readonly approval?: AdvanceApproval;
  readonly payment?: AdvancePayment;
  readonly settlement?: AdvanceSettlement;
  readonly journalLink?: AdvanceJournalLink;
  readonly cancel?: { readonly by: string; readonly at: IsoDateTime; readonly note: string };
  readonly submittedBy: string;
  readonly history: readonly AdvanceHistoryEvent[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export type CreateExpenseAdvanceProps = Omit<ExpenseAdvance, 'id' | 'status' | 'history'> & { readonly id?: string; readonly status?: AdvanceStatus; readonly history?: readonly AdvanceHistoryEvent[] };

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function date(value: unknown, label: string): string {
  if (!isIsoDate(value)) throw fail(`${label} must be a date in YYYY-MM-DD`);
  return value;
}

function optionalDate(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : date(value, label);
}

function optionalString(value: unknown, label: string, max = 256): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw fail(`${label} must be a string of at most ${max} characters`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw fail(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

export function createExpenseAdvance(props: CreateExpenseAdvanceProps, makeId?: () => string): ExpenseAdvance {
  if (props === null || typeof props !== 'object') throw fail('expense advance: props are required');
  const tenant = obj(props.tenant, 'expense advance: tenant');
  assertNonEmpty(tenant['tenantId'], 'expense advance: tenant.tenantId', fail);
  assertNonEmpty(tenant['workspaceId'], 'expense advance: tenant.workspaceId', fail);
  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'expense advance: id', fail);
  assertNonEmpty(props.employeeId, 'expense advance: employeeId', fail);
  const snapshot = obj(props.employeeSnapshot, 'expense advance: employeeSnapshot');
  assertNonEmpty(snapshot['name'], 'expense advance: employeeSnapshot.name', fail);
  if (typeof props.purpose !== 'string' || props.purpose.trim() === '' || props.purpose.trim().length > ADVANCE_PURPOSE_MAX) throw fail(`expense advance: purpose must be 1 to ${ADVANCE_PURPOSE_MAX} characters`);
  const amount = integer(props.amount, 'expense advance: amount', 1, ADVANCE_AMOUNT_MAX);
  const neededOn = date(props.neededOn, 'expense advance: neededOn');
  const plannedSettleBy = date(props.plannedSettleBy, 'expense advance: plannedSettleBy');
  if (plannedSettleBy < neededOn) throw fail('expense advance: plannedSettleBy must not be before neededOn');
  const status = props.status ?? 'requested';
  if (!ADVANCE_STATUSES.includes(status)) throw fail(`expense advance: status must be one of ${ADVANCE_STATUSES.join(', ')}`);
  assertNonEmpty(props.submittedBy, 'expense advance: submittedBy', fail);
  assertIsoDateTime(props.createdAt, 'expense advance: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'expense advance: updatedAt', fail);

  let approval: AdvanceApproval | undefined;
  if (props.approval !== undefined) {
    const raw = obj(props.approval, 'expense advance: approval');
    assertNonEmpty(raw['by'], 'expense advance: approval.by', fail);
    assertIsoDateTime(raw['at'], 'expense advance: approval.at', fail);
    if (typeof raw['proxy'] !== 'boolean') throw fail('expense advance: approval.proxy must be a boolean');
    approval = withDefined({ by: raw['by'] as string, employeeId: optionalString(raw['employeeId'], 'expense advance: approval.employeeId', 64), at: raw['at'] as string, comment: optionalString(raw['comment'], 'expense advance: approval.comment', 500), proxy: raw['proxy'] });
  }
  let payment: AdvancePayment | undefined;
  if (props.payment !== undefined) {
    const raw = obj(props.payment, 'expense advance: payment');
    if (!(ADVANCE_PAYMENT_METHODS as readonly unknown[]).includes(raw['method'])) throw fail(`expense advance: payment.method must be one of ${ADVANCE_PAYMENT_METHODS.join(', ')}`);
    assertNonEmpty(raw['by'], 'expense advance: payment.by', fail);
    assertIsoDateTime(raw['at'], 'expense advance: payment.at', fail);
    payment = withDefined({ paidOn: date(raw['paidOn'], 'expense advance: payment.paidOn'), method: raw['method'] as AdvancePaymentMethod, by: raw['by'] as string, at: raw['at'] as string, payoutBatchId: optionalString(raw['payoutBatchId'], 'expense advance: payment.payoutBatchId', 64) });
  }
  let settlement: AdvanceSettlement | undefined;
  if (props.settlement !== undefined) {
    const raw = obj(props.settlement, 'expense advance: settlement');
    assertIsoDateTime(raw['computedAt'], 'expense advance: settlement.computedAt', fail);
    const claimIds = raw['claimIds'];
    if (!Array.isArray(claimIds) || claimIds.length > ADVANCE_MAX_CLAIMS || claimIds.some((entry) => typeof entry !== 'string' || entry === '')) throw fail(`expense advance: settlement.claimIds must be at most ${ADVANCE_MAX_CLAIMS} claim ids`);
    const claimsTotal = integer(raw['claimsTotal'], 'expense advance: settlement.claimsTotal', 0, Number.MAX_SAFE_INTEGER);
    const difference = integer(raw['difference'], 'expense advance: settlement.difference', -ADVANCE_AMOUNT_MAX, Number.MAX_SAFE_INTEGER);
    if (difference !== claimsTotal - amount) throw fail('expense advance: settlement.difference must equal claimsTotal minus amount');
    let additionalPayment: AdvanceAdditionalPayment | undefined;
    if (raw['additionalPayment'] !== undefined) {
      const extra = obj(raw['additionalPayment'], 'expense advance: settlement.additionalPayment');
      if (!(ADDITIONAL_PAYMENT_STATUSES as readonly unknown[]).includes(extra['status'])) throw fail(`expense advance: settlement.additionalPayment.status must be one of ${ADDITIONAL_PAYMENT_STATUSES.join(', ')}`);
      additionalPayment = withDefined({ amount: integer(extra['amount'], 'expense advance: settlement.additionalPayment.amount', 1, Number.MAX_SAFE_INTEGER), status: extra['status'] as AdditionalPaymentStatus, payoutBatchId: optionalString(extra['payoutBatchId'], 'expense advance: settlement.additionalPayment.payoutBatchId', 64), paidOn: optionalDate(extra['paidOn'], 'expense advance: settlement.additionalPayment.paidOn') });
      if (difference <= 0 || additionalPayment.amount !== difference) throw fail('expense advance: an additional payment is the positive difference only');
    }
    let refund: AdvanceRefund | undefined;
    if (raw['refund'] !== undefined) {
      const back = obj(raw['refund'], 'expense advance: settlement.refund');
      refund = withDefined({ amount: integer(back['amount'], 'expense advance: settlement.refund.amount', 1, ADVANCE_AMOUNT_MAX), receivedOn: optionalDate(back['receivedOn'], 'expense advance: settlement.refund.receivedOn'), by: optionalString(back['by'], 'expense advance: settlement.refund.by') });
      if (difference >= 0 || refund.amount !== -difference) throw fail('expense advance: a refund is the negative difference only');
    }
    settlement = withDefined({ computedAt: raw['computedAt'] as string, claimIds: [...claimIds as string[]], claimsTotal, difference, additionalPayment, refund, settledOn: optionalDate(raw['settledOn'], 'expense advance: settlement.settledOn') });
  }
  let journalLink: AdvanceJournalLink | undefined;
  if (props.journalLink !== undefined) {
    const raw = obj(props.journalLink, 'expense advance: journalLink');
    if (!Array.isArray(raw['warnings']) || raw['warnings'].some((warning) => typeof warning !== 'string')) throw fail('expense advance: journalLink.warnings must be an array of strings');
    journalLink = withDefined({ paymentEntryId: optionalString(raw['paymentEntryId'], 'expense advance: journalLink.paymentEntryId', 128), settlementEntryId: optionalString(raw['settlementEntryId'], 'expense advance: journalLink.settlementEntryId', 128), warnings: [...raw['warnings'] as string[]] });
  }
  let cancel: ExpenseAdvance['cancel'];
  if (props.cancel !== undefined) {
    const raw = obj(props.cancel, 'expense advance: cancel');
    assertNonEmpty(raw['by'], 'expense advance: cancel.by', fail);
    assertIsoDateTime(raw['at'], 'expense advance: cancel.at', fail);
    assertNonEmpty(raw['note'], 'expense advance: cancel.note', fail);
    cancel = { by: raw['by'] as string, at: raw['at'] as string, note: raw['note'] as string };
  }

  // 状態ごとに要る記録（保存済みの値の整合。遷移の順序そのものは B の遷移関数が守る）。
  if (['approved', 'paid', 'settling', 'settled'].includes(status) && approval === undefined) throw fail(`expense advance: an ${status} advance must have an approval`);
  if (['paid', 'settling', 'settled'].includes(status) && payment === undefined) throw fail(`expense advance: a ${status} advance must have a payment`);
  if (['settling', 'settled'].includes(status) && settlement === undefined) throw fail(`expense advance: a ${status} advance must have a settlement`);
  if (status === 'settled' && settlement?.settledOn === undefined) throw fail('expense advance: a settled advance must have settlement.settledOn');
  if (status === 'cancelled' && cancel === undefined) throw fail('expense advance: a cancelled advance must have a cancel note');

  const history = (props.history ?? []).map((entry, index) => {
    const raw = obj(entry, `expense advance: history[${index}]`);
    if (!(ADVANCE_HISTORY_TYPES as readonly unknown[]).includes(raw['type'])) throw fail(`expense advance: history[${index}].type must be one of ${ADVANCE_HISTORY_TYPES.join(', ')}`);
    assertIsoDateTime(raw['at'], `expense advance: history[${index}].at`, fail);
    return withDefined({ type: raw['type'] as AdvanceHistoryType, by: optionalString(raw['by'], `expense advance: history[${index}].by`), at: raw['at'] as string, note: optionalString(raw['note'], `expense advance: history[${index}].note`, 1000), proxy: typeof raw['proxy'] === 'boolean' ? raw['proxy'] : undefined });
  }).slice(-ADVANCE_HISTORY_MAX);

  return withDefined({
    tenant: { tenantId: tenant['tenantId'] as string, workspaceId: tenant['workspaceId'] as string },
    id,
    employeeId: props.employeeId,
    employeeSnapshot: withDefined({ name: snapshot['name'] as string, departmentId: optionalString(snapshot['departmentId'], 'expense advance: employeeSnapshot.departmentId', 64) }),
    purpose: props.purpose.trim(),
    amount,
    neededOn,
    plannedSettleBy,
    status,
    approval,
    payment,
    settlement,
    journalLink,
    cancel,
    submittedBy: props.submittedBy,
    history,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  });
}

/** 期限切れ（支払済み以降で精算されておらず、精算予定日を過ぎた）。台帳の表示に使い、理由コードにはしない。 */
export function isAdvanceOverdue(advance: Pick<ExpenseAdvance, 'status' | 'plannedSettleBy'>, today: string): boolean {
  return (advance.status === 'paid' || advance.status === 'settling') && today > advance.plannedSettleBy;
}
