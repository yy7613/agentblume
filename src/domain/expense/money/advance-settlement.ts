/**
 * ドメイン: 仮払の精算の事前計算と、申請との紐付けの整合（docs/21 §20.1.4 / §20.2.7。UC4。純関数）。
 *
 * 差額 = 紐付く申請の支払う額（`reimbursableAmount`）の合計 − 仮払額。正なら追加支給、負なら返金、0 ならそのまま精算済み。
 * 他の申請の支払額と返金は**相殺しない**（誰のどのお金かが帳簿と振込の両方で追えなくなるため。ADR-0043 §7）。
 * 精算できない理由は最初の 1 件で止めず全部集め、画面が直す場所を並べられるようにする。
 */
import { ADVANCE_MAX_CLAIMS, type ExpenseAdvance } from '../advance';
import type { ExpenseBlockingReason } from '../errors';

/** 精算の計算に使う、紐付く申請の要約。 */
export interface AdvanceClaimRef {
  readonly id: string;
  readonly status: string;
  readonly reimbursableAmount: number;
  readonly employeeId?: string;
  readonly claimantName?: string;
  readonly journalLinked?: 'none' | 'partial' | 'complete';
}

export type AdvanceSettlementDirection = 'additional' | 'refund' | 'even';

export interface AdvanceSettlementPreview {
  readonly claims: readonly AdvanceClaimRef[];
  readonly claimsTotal: number;
  readonly difference: number;
  readonly direction: AdvanceSettlementDirection;
  /** 精算できない理由（空なら精算できる）。 */
  readonly blockers: readonly ExpenseBlockingReason[];
}

const SETTLEABLE_CLAIM_STATUSES: ReadonlySet<string> = new Set(['approved', 'settled']);

export function directionOf(difference: number): AdvanceSettlementDirection {
  return difference > 0 ? 'additional' : difference < 0 ? 'refund' : 'even';
}

/** 精算の事前計算（状態を変えない）。 */
export function previewAdvanceSettlement(advance: Pick<ExpenseAdvance, 'id' | 'amount' | 'status' | 'employeeId'>, claims: readonly AdvanceClaimRef[]): AdvanceSettlementPreview {
  const blockers: ExpenseBlockingReason[] = [];
  if (advance.status !== 'paid') blockers.push({ code: 'advance-not-paid', params: { advanceId: advance.id, advanceStatus: advance.status } });
  if (claims.length > ADVANCE_MAX_CLAIMS) blockers.push({ code: 'advance-too-many-claims', params: { advanceId: advance.id, count: claims.length, max: ADVANCE_MAX_CLAIMS } });
  for (const claim of claims) {
    if (!SETTLEABLE_CLAIM_STATUSES.has(claim.status)) blockers.push({ code: 'advance-claim-not-approved', params: { claimId: claim.id, status: claim.status } });
    if (claim.employeeId !== advance.employeeId) blockers.push({ code: 'advance-employee-mismatch', params: { claimId: claim.id, advanceId: advance.id } });
  }
  const claimsTotal = claims.reduce((sum, claim) => sum + claim.reimbursableAmount, 0);
  const difference = claimsTotal - advance.amount;
  return { claims: [...claims], claimsTotal, difference, direction: directionOf(difference), blockers };
}

/** 申請へ仮払を紐付けられない理由（§20.1.4: 申請者と仮払の従業員が同じ・仮払が支払済み・1 仮払 = 最大 20 申請）。 */
export function advanceLinkBlockers(
  claim: { readonly id: string; readonly employeeId?: string },
  advance: Pick<ExpenseAdvance, 'id' | 'employeeId' | 'status' | 'settlement' | 'employeeSnapshot'>,
  linkedClaimIds: readonly string[],
): readonly ExpenseBlockingReason[] {
  const blockers: ExpenseBlockingReason[] = [];
  if (claim.employeeId !== advance.employeeId) {
    blockers.push({ code: 'advance-employee-mismatch', params: { advanceId: advance.id, advanceEmployee: advance.employeeSnapshot.name, employeeId: advance.employeeId } });
  }
  if (advance.status === 'settling' || advance.status === 'settled') {
    blockers.push({ code: 'advance-already-settled', params: { advanceId: advance.id, settledOn: advance.settlement?.settledOn ?? advance.settlement?.computedAt.slice(0, 10) ?? '' } });
  } else if (advance.status !== 'paid') {
    blockers.push({ code: 'advance-not-paid', params: { advanceId: advance.id, advanceStatus: advance.status } });
  }
  const others = linkedClaimIds.filter((id) => id !== claim.id);
  if (others.length >= ADVANCE_MAX_CLAIMS) blockers.push({ code: 'advance-too-many-claims', params: { advanceId: advance.id, count: others.length, max: ADVANCE_MAX_CLAIMS } });
  return blockers;
}
