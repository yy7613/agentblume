/**
 * ドメイン: 「お金の流れ」の検査関数（contributor。docs/21 §20.3.2 / §20.3.3 / §20.3.5 / §20.4.1 / §20.4.4）。
 *
 * 出してよいコードは `MONEY_REASON_CODES`（仮払の 3 コード・`card-charge-claimed` / `corporate-payment-unmatched`）。
 * 事実（`MoneyCheckFacts`）が無ければ何も出さない（仮払もカードも使わない会社は MVP と同じ判定）。
 *
 * - 仮払: `advance-employee-mismatch` / `advance-already-settled` が出たら `advance-not-paid` を出さない。
 * - カード: 申請の中の明細とカード利用を 1 対 1 で割り当てる（他の申請に照合済みのカード利用は provider が渡さない）。
 *   取引日と金額が揃わない明細は飛ばす。弱い一致の `card-charge-claimed` は規程の重さに関係なく要確認。
 *   `corporate-payment-unmatched` は、明細の取引日が申請者のカード（保有者が空のカードは全員分）の取込範囲に入るときだけ出す。
 *
 * 文言の差し込み値の名前は §20.13.6 の一覧に合わせ、画面の導線が行を開けるよう `advanceId` / `cardTransactionId` も入れる。
 */
import { daysBetween } from '../business-date';
import type { CheckedClaim, ExpenseCheckContributor, ItemEvaluation, ReasonDraft } from '../check-extensions';
import type { ExpensePolicy } from '../policy';
import { MONEY_REASON_CODES } from '../reason-codes';
import { usableAmount } from '../receipt-facts';
import { payeeKeyOf } from '../duplicates';
import { cardItemKey, dateInRanges, matchCardTransactions, type CardMatchAssignment } from './card-matching';
import type { MoneyAdvanceFact, MoneyCardFacts } from './check-facts';

export type { MoneyCheckFacts } from './check-facts';

/** 仮払が「支払済み」とみなせる状態（申請を紐付けて精算へ進める）。 */
const PAID_STATUSES: ReadonlySet<string> = new Set(['paid']);
/** 精算に入った状態（新しい申請を足せない）。 */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['settling', 'settled']);

/** 紐付けた仮払の理由（申請の理由）。 */
export function advanceReasons(claim: Pick<CheckedClaim, 'id' | 'claimant' | 'advanceId'>, advance: MoneyAdvanceFact | undefined): readonly ReasonDraft[] {
  if (claim.advanceId === undefined || advance === undefined || advance.id !== claim.advanceId) return [];
  const base = { advanceId: advance.id };
  if (claim.claimant?.employeeId !== advance.employeeId) {
    return [{ code: 'advance-employee-mismatch', params: { ...base, advanceEmployee: advance.employeeName, employeeId: advance.employeeId } }];
  }
  if (CLOSED_STATUSES.has(advance.status) && !advance.settledClaimIds.includes(claim.id)) {
    return [{ code: 'advance-already-settled', params: { ...base, settledOn: advance.settledOn ?? '' } }];
  }
  if (!PAID_STATUSES.has(advance.status) && !CLOSED_STATUSES.has(advance.status)) {
    return [{ code: 'advance-not-paid', params: { ...base, advanceStatus: advance.status } }];
  }
  return [];
}

interface ClaimCardOutcome {
  readonly byItem: ReadonlyMap<string, CardMatchAssignment>;
}

/** 同じ事実 × 同じ申請の割り当ては 1 回だけ計算する（明細ごとに呼ばれるため）。 */
const outcomeCache = new WeakMap<MoneyCardFacts, WeakMap<object, ClaimCardOutcome>>();

/** 申請の中の明細とカード利用の割り当て（手動の紐付けを先に確定し、残りを自動で割り当てる）。 */
export function claimCardAssignments(claim: Pick<CheckedClaim, 'id' | 'items' | 'claimant'>, policy: Pick<ExpensePolicy, 'card'>, facts: MoneyCardFacts): ReadonlyMap<string, CardMatchAssignment> {
  let perFacts = outcomeCache.get(facts);
  if (perFacts === undefined) {
    perFacts = new WeakMap();
    outcomeCache.set(facts, perFacts);
  }
  const cached = perFacts.get(claim);
  if (cached !== undefined) return cached.byItem;

  const employeeId = claim.claimant?.employeeId;
  const items = claim.items.flatMap((item) => {
    const amount = usableAmount(item.facts);
    const transactionDate = item.facts.transactionDate;
    if (amount === undefined || transactionDate === undefined) return [];
    const payeeKey = payeeKeyOf(item.facts.payeeName);
    return [{
      claimId: claim.id, itemId: item.id, transactionDate, amount, corporate: item.facts.corporatePayment === true,
      ...(employeeId === undefined ? {} : { employeeId }), ...(payeeKey === undefined ? {} : { payeeKey }),
    }];
  });
  const byItem = new Map<string, CardMatchAssignment>();
  const manualTransactions = new Set<string>();
  for (const transaction of facts.transactions) {
    if (transaction.manualItemId === undefined) continue;
    const item = items.find((entry) => entry.itemId === transaction.manualItemId);
    if (item === undefined || byItem.has(item.itemId)) continue;
    manualTransactions.add(transaction.id);
    byItem.set(item.itemId, {
      transactionId: transaction.id, claimId: claim.id, itemId: item.itemId, kind: item.corporate ? 'corporate-item' : 'reimbursement-item', strength: 'strong',
      dateDiffDays: daysBetween(item.transactionDate, transaction.usedOn), amountDiff: transaction.amount - item.amount,
    });
  }
  const assignments = matchCardTransactions({
    transactions: facts.transactions.filter((transaction) => transaction.manualItemId === undefined && !manualTransactions.has(transaction.id)),
    items: items.filter((item) => !byItem.has(item.itemId)),
    cards: facts.cards,
    tolerance: policy.card,
  });
  for (const assignment of assignments) byItem.set(assignment.itemId, assignment);
  perFacts.set(claim, { byItem });
  return byItem;
}

function coverageText(ranges: readonly { readonly from: string; readonly to: string }[]): string {
  return ranges.map((range) => `${range.from}〜${range.to}`).join('、');
}

/** 明細のカードの理由。 */
export function cardReasons(evaluation: ItemEvaluation, policy: ExpensePolicy, facts: MoneyCardFacts | undefined, claim: CheckedClaim | undefined): readonly ReasonDraft[] {
  if (facts === undefined || claim === undefined) return [];
  if (evaluation.amount === undefined || evaluation.date === undefined) return [];
  const { item } = evaluation;
  const corporate = item.facts.corporatePayment === true;
  const assignment = claimCardAssignments(claim, policy, facts).get(item.id);
  if (!corporate) {
    if (assignment === undefined) return [];
    const transaction = facts.transactions.find((entry) => entry.id === assignment.transactionId);
    const card = facts.cards.find((entry) => entry.id === transaction?.cardId);
    const weak = assignment.strength === 'weak';
    return [{
      code: 'card-charge-claimed',
      params: {
        cardLabel: card?.label ?? transaction?.cardId ?? '', usedOn: transaction?.usedOn ?? '', merchant: transaction?.merchantRaw ?? '',
        cardAmount: transaction?.amount ?? 0, weak, dateDiffDays: assignment.dateDiffDays, cardTransactionId: assignment.transactionId,
      },
      ...(weak ? { forcedSeverity: 'review' as const } : {}),
    }];
  }
  if (!policy.card.acceptCorporatePaymentItems || assignment !== undefined) return [];
  const employeeId = claim.claimant?.employeeId;
  const cardIds = new Set(facts.cards.filter((card) => card.holderEmployeeId === undefined || card.holderEmployeeId === employeeId).map((card) => card.id));
  const ranges = facts.coverage.filter((range) => cardIds.has(range.cardId));
  if (!dateInRanges(evaluation.date, ranges)) return [];
  const containing = ranges.filter((range) => range.from <= (evaluation.date as string) && (evaluation.date as string) <= range.to);
  const unique = [...new Map(containing.map((range) => [`${range.from}|${range.to}`, range])).values()];
  return [{ code: 'corporate-payment-unmatched', params: { coverage: coverageText(unique) } }];
}

export const moneyContributor: ExpenseCheckContributor = {
  id: 'money',
  codes: MONEY_REASON_CODES,
  claimReasons: (claim, _policy, extensions) => advanceReasons(claim, extensions.money?.advance),
  itemReasons: (evaluation, policy, extensions, claim) => cardReasons(evaluation, policy, extensions.money?.card, claim),
};
