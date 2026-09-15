/**
 * ドメイン: 仮払（ExpenseAdvance）の遷移（docs/21 §20.2.7。UC4。純関数）。
 *
 * requested → approved → paid → settling → settled（差額 0 は paid → settled）/ requested・approved → cancelled / paid → approved（支払取消）。
 * 拒否は `ExpenseTransitionError`（409）で、画面が並べる `blockingReasons` と次の一手 `nextStep` を付ける。
 * 保存済みの値の整合は `createExpenseAdvance` が見るので、遷移はすべて最後にそこを通す。
 */
import { isIsoDate } from '../../journal/document';
import { assertIsoDateTime } from '../../shared/time';
import {
  createExpenseAdvance, type AdvanceHistoryEvent, type AdvancePaymentMethod, type AdvanceStatus,
  type CreateExpenseAdvanceProps, type ExpenseAdvance,
} from '../advance';
import { ExpenseDomainError, ExpenseTransitionError, type ExpenseBlockingReason } from '../errors';
import type { AdvanceSettlementPreview } from './advance-settlement';

const STATUS_LABELS: Readonly<Record<AdvanceStatus, string>> = {
  requested: '申請中', approved: '承認済み', paid: '支払済み', settling: '精算中', settled: '精算済み', cancelled: '取消',
};

export function advanceStatusLabel(status: AdvanceStatus): string {
  return STATUS_LABELS[status];
}

function rebuild(advance: ExpenseAdvance, patch: Partial<CreateExpenseAdvanceProps>, event: AdvanceHistoryEvent, remove: readonly (keyof ExpenseAdvance)[] = []): ExpenseAdvance {
  const base: Record<string, unknown> = { ...advance };
  for (const key of remove) delete base[key];
  return createExpenseAdvance({ ...(base as unknown as CreateExpenseAdvanceProps), ...patch, history: [...advance.history, event], updatedAt: event.at });
}

function requireStatus(advance: ExpenseAdvance, allowed: readonly AdvanceStatus[], action: string, nextStep: string): void {
  if (allowed.includes(advance.status)) return;
  throw new ExpenseTransitionError(`${action}: advance ${advance.id} is ${advance.status} (allowed: ${allowed.join(', ')})`, {
    nextStep: `${nextStep}（現在の状態: ${advanceStatusLabel(advance.status)}）`,
    blockingReasons: [{ code: 'advance-status', params: { advanceId: advance.id, advanceStatus: advance.status } }],
  });
}

function requireDate(value: unknown, label: string): string {
  if (!isIsoDate(value)) throw new ExpenseDomainError(`${label} must be a date in YYYY-MM-DD`, undefined, { field: label.split(': ').pop() as string });
  return value;
}

function requireNote(note: unknown, action: string, nextStep: string): string {
  if (typeof note !== 'string' || note.trim() === '' || note.trim().length > 500) {
    throw new ExpenseTransitionError(`${action}: a note of 1 to 500 characters is required`, { nextStep });
  }
  return note.trim();
}

export interface NewAdvanceInput {
  readonly tenant: ExpenseAdvance['tenant'];
  readonly id: string;
  readonly employee: { readonly id: string; readonly name: string; readonly departmentId?: string; readonly enabled: boolean };
  readonly purpose: string;
  readonly amount: number;
  readonly neededOn: string;
  readonly plannedSettleBy: string;
  readonly by: string;
  readonly at: string;
}

/** 仮払を申請する（従業員マスタの有効な従業員にだけ出せる）。 */
export function requestAdvance(input: NewAdvanceInput): ExpenseAdvance {
  assertIsoDateTime(input.at, 'requestAdvance: at', (message) => new ExpenseDomainError(message));
  if (!input.employee.enabled) {
    throw new ExpenseDomainError(`expense advance: employee ${input.employee.id} is disabled`, undefined, { field: 'employeeId' });
  }
  return createExpenseAdvance({
    tenant: input.tenant, id: input.id, employeeId: input.employee.id,
    employeeSnapshot: { name: input.employee.name, ...(input.employee.departmentId === undefined ? {} : { departmentId: input.employee.departmentId }) },
    purpose: input.purpose, amount: input.amount, neededOn: input.neededOn, plannedSettleBy: input.plannedSettleBy,
    status: 'requested', submittedBy: input.by, history: [{ type: 'requested', by: input.by, at: input.at }], createdAt: input.at, updatedAt: input.at,
  });
}

export interface AdvancePatch {
  readonly purpose: string;
  readonly amount: number;
  readonly neededOn: string;
  readonly plannedSettleBy: string;
}

/** 申請中の仮払を直す（承認後は直せない）。 */
export function editAdvance(advance: ExpenseAdvance, patch: AdvancePatch, by: string, at: string): ExpenseAdvance {
  requireStatus(advance, ['requested'], 'editAdvance', '承認後の仮払は編集できません。取り消して申請し直してください');
  // 値の検証（金額の範囲・目的の長さ・日付の前後）は createExpenseAdvance が行う。
  return rebuild(advance, { purpose: patch.purpose, amount: patch.amount, neededOn: patch.neededOn, plannedSettleBy: patch.plannedSettleBy }, { type: 'edited', by, at });
}

export interface AdvanceApprover {
  readonly subject: string;
  readonly employeeId?: string;
}

/** 仮払の承認（1 段。approve 権限は api の認可が見る。申請者本人の従業員は承認できない）。 */
export function approveAdvance(advance: ExpenseAdvance, approver: AdvanceApprover, at: string, comment?: string): ExpenseAdvance {
  requireStatus(advance, ['requested'], 'approveAdvance', '申請中の仮払だけを承認できます');
  if (approver.employeeId !== undefined && approver.employeeId === advance.employeeId) {
    throw new ExpenseTransitionError(`approveAdvance: the employee of advance ${advance.id} cannot approve it`, {
      nextStep: '仮払を受け取る本人は承認できません。別の承認者に依頼してください',
      blockingReasons: [{ code: 'approval-claimant-self', params: { advanceId: advance.id } }],
    });
  }
  const trimmed = typeof comment === 'string' && comment.trim() !== '' ? comment.trim() : undefined;
  return rebuild(advance, {
    status: 'approved',
    approval: { by: approver.subject, ...(approver.employeeId === undefined ? {} : { employeeId: approver.employeeId }), at, ...(trimmed === undefined ? {} : { comment: trimmed }), proxy: false },
  }, { type: 'approved', by: approver.subject, at, ...(trimmed === undefined ? {} : { note: trimmed }) });
}

/** 取消（支払前だけ）。 */
export function cancelAdvance(advance: ExpenseAdvance, note: string, by: string, at: string): ExpenseAdvance {
  requireStatus(advance, ['requested', 'approved'], 'cancelAdvance', '支払済みの仮払は取り消せません。先に「支払取消」を行ってください');
  const text = requireNote(note, 'cancelAdvance', '取り消す理由を書いてください');
  return rebuild(advance, { status: 'cancelled', cancel: { by, at, note: text } }, { type: 'cancelled', by, at, note: text });
}

/** 支払済みにする（振込データを使わない支払。現金・手作業の振込）。 */
export function markAdvancePaid(advance: ExpenseAdvance, payment: { readonly paidOn: string; readonly method: AdvancePaymentMethod; readonly payoutBatchId?: string }, by: string, at: string): ExpenseAdvance {
  requireStatus(advance, ['approved'], 'markAdvancePaid', '承認済みの仮払だけを支払済みにできます');
  const paidOn = requireDate(payment.paidOn, 'markAdvancePaid: paidOn');
  return rebuild(advance, {
    status: 'paid',
    payment: { paidOn, method: payment.method, by, at, ...(payment.payoutBatchId === undefined ? {} : { payoutBatchId: payment.payoutBatchId }) },
  }, { type: 'paid', by, at, note: `${paidOn} ${payment.method}` });
}

/** 支払取消（申請の紐付け・支払の仕訳下書き・振込バッチが無いときだけ）。 */
export function unpayAdvance(advance: ExpenseAdvance, note: string, by: string, at: string, linkedClaimIds: readonly string[]): ExpenseAdvance {
  requireStatus(advance, ['paid'], 'unpayAdvance', '支払済みの仮払だけを支払取消できます');
  const blockers: ExpenseBlockingReason[] = [];
  if (linkedClaimIds.length > 0) blockers.push({ code: 'advance-has-claims', params: { advanceId: advance.id, count: linkedClaimIds.length, claimIds: linkedClaimIds.join('、') } });
  if (advance.journalLink?.paymentEntryId !== undefined) blockers.push({ code: 'advance-journal-drafted', params: { advanceId: advance.id, entryId: advance.journalLink.paymentEntryId } });
  if (advance.payment?.payoutBatchId !== undefined) blockers.push({ code: 'advance-in-payout', params: { advanceId: advance.id, batchId: advance.payment.payoutBatchId } });
  if (blockers.length > 0) {
    throw new ExpenseTransitionError(`unpayAdvance: advance ${advance.id} cannot be unpaid`, {
      nextStep: '紐付いた申請の紐付けを外し、支払の仕訳下書きや振込データが無いことを確かめてから支払取消してください',
      blockingReasons: blockers,
    });
  }
  const text = requireNote(note, 'unpayAdvance', '支払を取り消す理由を書いてください');
  return rebuild(advance, { status: 'approved' }, { type: 'unpaid', by, at, note: text }, ['payment']);
}

/** 精算する（事前計算の結果で差額の向きを決める。精算できない理由があれば拒否）。 */
export function settleAdvance(advance: ExpenseAdvance, preview: AdvanceSettlementPreview, today: string, by: string, at: string): ExpenseAdvance {
  requireStatus(advance, ['paid'], 'settleAdvance', '支払済みの仮払だけを精算できます');
  if (preview.blockers.length > 0) {
    throw new ExpenseTransitionError(`settleAdvance: advance ${advance.id} cannot be settled yet`, {
      nextStep: '紐付いた申請をすべて承認してから精算してください',
      blockingReasons: preview.blockers,
    });
  }
  const { difference, claimsTotal } = preview;
  const claimIds = preview.claims.map((claim) => claim.id);
  const base = { computedAt: at, claimIds, claimsTotal, difference };
  if (difference === 0) {
    return rebuild(advance, { status: 'settled', settlement: { ...base, settledOn: today } }, { type: 'settled', by, at, note: `${claimIds.length} claims, difference 0` });
  }
  const settlement = difference > 0 ? { ...base, additionalPayment: { amount: difference, status: 'pending' as const } } : { ...base, refund: { amount: -difference } };
  return rebuild(advance, { status: 'settling', settlement }, { type: 'settling', by, at, note: `${claimIds.length} claims, difference ${difference}` });
}

/** 返金の受領を記録して精算済みにする（差額が負のとき）。 */
export function receiveAdvanceRefund(advance: ExpenseAdvance, receivedOn: string, by: string, at: string): ExpenseAdvance {
  requireStatus(advance, ['settling'], 'receiveAdvanceRefund', '精算中の仮払だけで返金を受け取れます');
  const settlement = advance.settlement;
  if (settlement?.refund === undefined) {
    throw new ExpenseTransitionError(`receiveAdvanceRefund: advance ${advance.id} has no refund`, { nextStep: 'この仮払は返金ではなく追加支給です。「追加支給を支払済み」を押してください' });
  }
  const date = requireDate(receivedOn, 'receiveAdvanceRefund: receivedOn');
  return rebuild(advance, {
    status: 'settled',
    settlement: { ...settlement, refund: { amount: settlement.refund.amount, receivedOn: date, by }, settledOn: date },
  }, { type: 'refund-received', by, at, note: `${date} ${settlement.refund.amount}` });
}

/** 追加支給を振込データに入れた印（支払待ち → exported + 振込バッチ）。同じバッチなら冪等。 */
export function markAdditionalPaymentExported(advance: ExpenseAdvance, batchId: string, at: string): ExpenseAdvance {
  const settlement = advance.settlement;
  const extra = settlement?.additionalPayment;
  if (advance.status !== 'settling' || settlement === undefined || extra === undefined) {
    throw new ExpenseTransitionError(`markAdditionalPaymentExported: advance ${advance.id} has no pending additional payment`, { nextStep: '精算中で追加支給が支払待ちの仮払だけを振込データに入れられます' });
  }
  if (extra.status === 'exported' && extra.payoutBatchId === batchId) return advance;
  if (extra.status !== 'pending') {
    throw new ExpenseTransitionError(`markAdditionalPaymentExported: the additional payment of advance ${advance.id} is ${extra.status}`, { nextStep: `追加支給は既に振込データ ${extra.payoutBatchId ?? ''} に入っているか支払済みです` });
  }
  return rebuild(advance, { settlement: { ...settlement, additionalPayment: { amount: extra.amount, status: 'exported', payoutBatchId: batchId } } }, { type: 'payout-exported', at, note: batchId });
}

/** 振込バッチの取消で追加支給の印を外す（そのバッチの印でなければ何もしない）。 */
export function clearAdditionalPaymentExport(advance: ExpenseAdvance, batchId: string, at: string): ExpenseAdvance {
  const settlement = advance.settlement;
  const extra = settlement?.additionalPayment;
  if (settlement === undefined || extra === undefined || extra.status !== 'exported' || extra.payoutBatchId !== batchId) return advance;
  return rebuild(advance, { settlement: { ...settlement, additionalPayment: { amount: extra.amount, status: 'pending' } } }, { type: 'payout-cancelled', at, note: batchId });
}

/** 追加支給を支払済みにして精算済みにする（差額が正のとき。振込データの確定なら `payoutBatchId` を付ける）。 */
export function payAdvanceAdditional(advance: ExpenseAdvance, payment: { readonly paidOn: string; readonly method: AdvancePaymentMethod; readonly payoutBatchId?: string }, by: string, at: string): ExpenseAdvance {
  requireStatus(advance, ['settling'], 'payAdvanceAdditional', '精算中の仮払だけで追加支給を記録できます');
  const settlement = advance.settlement;
  if (settlement?.additionalPayment === undefined) {
    throw new ExpenseTransitionError(`payAdvanceAdditional: advance ${advance.id} has no additional payment`, { nextStep: 'この仮払は追加支給ではなく返金です。「返金を受け取った」を押してください' });
  }
  const date = requireDate(payment.paidOn, 'payAdvanceAdditional: paidOn');
  return rebuild(advance, {
    status: 'settled',
    settlement: {
      ...settlement,
      additionalPayment: { amount: settlement.additionalPayment.amount, status: 'paid', paidOn: date, ...(payment.payoutBatchId ?? settlement.additionalPayment.payoutBatchId) === undefined ? {} : { payoutBatchId: (payment.payoutBatchId ?? settlement.additionalPayment.payoutBatchId) as string } },
      settledOn: date,
    },
  }, { type: 'additional-paid', by, at, note: `${date} ${payment.method} ${settlement.additionalPayment.amount}` });
}

/** 仕訳下書きの作成を記録する。 */
export function withAdvanceJournalEntry(advance: ExpenseAdvance, stage: 'payment' | 'settlement', entryId: string, warnings: readonly string[], by: string, at: string): ExpenseAdvance {
  const current = advance.journalLink ?? { warnings: [] };
  const journalLink = { ...current, ...(stage === 'payment' ? { paymentEntryId: entryId } : { settlementEntryId: entryId }), warnings: [...current.warnings, ...warnings] };
  return rebuild(advance, { journalLink }, { type: 'journal-drafted', by, at, note: `${stage}: ${entryId}` });
}
