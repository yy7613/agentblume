/**
 * application層: カード利用と明細の照合の保存（`POST /expense/card-transactions/match`。docs/21 §20.3.5。UC5）。
 *
 * 期間のカード利用と、その期間 ± 許容日数の明細を同じ純関数（`matchCardTransactions`）で 1 対 1 に割り当てて保存する。
 * 対象外の印と手動の紐付けは上書きしない。期間の外のカード利用に照合済みの明細は、ここで別の利用に取り直さない。
 * 判定は保存を待たずに同じ関数で決まる（`check-money.ts`）ので、ここは台帳とツールの表示のための保存。
 */
import { createExpenseCardTransaction, type ExpenseCardTransaction } from '../../../domain/expense/card';
import { cardItemKey, matchCardTransactions } from '../../../domain/expense/money/card-matching';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';
import { addDays } from './check-facts';

export const CARD_MATCH_TRANSACTION_LIMIT = 20_000;

export interface CardMatchRunResult {
  /** 照合済みになったカード利用（自動）。 */
  readonly matched: number;
  /** そのうち立替の明細と一致した（二重計上の疑い）もの。 */
  readonly reimbursementMatches: number;
  readonly unmatched: number;
  /** 対象外・手動の紐付けとして保ったもの。 */
  readonly kept: number;
}

function sameMatch(left: ExpenseCardTransaction, right: ExpenseCardTransaction): boolean {
  const key = (transaction: ExpenseCardTransaction): string => (transaction.match === undefined
    ? transaction.status
    : `${transaction.status}|${transaction.match.claimId}|${transaction.match.itemId}|${transaction.match.kind}|${transaction.match.strength}|${transaction.match.dateDiffDays}|${transaction.match.amountDiff}`);
  return key(left) === key(right);
}

export class MatchCardTransactionsUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, range: { readonly from?: string; readonly to?: string }, by: string): Promise<CardMatchRunResult> {
    const { cards } = this.deps.repositories;
    const inRange = await cards.listTransactions(scope, { limit: CARD_MATCH_TRANSACTION_LIMIT, ...(range.from === undefined ? {} : { from: range.from }), ...(range.to === undefined ? {} : { to: range.to }) });
    const kept = inRange.filter((transaction) => transaction.status === 'excluded' || transaction.match?.manual === true);
    const rematchable = inRange.filter((transaction) => transaction.status !== 'excluded' && transaction.match?.manual !== true);
    if (rematchable.length === 0) return { matched: 0, reimbursementMatches: 0, unmatched: 0, kept: kept.length };

    const [{ policy }, settings, allMatched] = await Promise.all([
      loadExpensePolicy(this.deps.repositories.policies, scope),
      this.deps.settings.load(scope, 'cards'),
      cards.listTransactions(scope, { status: 'matched', limit: CARD_MATCH_TRANSACTION_LIMIT }),
    ]);
    const rematchableIds = new Set(rematchable.map((transaction) => transaction.id));
    // 取り直さない照合（手動の紐付け・期間の外のカード利用の照合）が持っている明細は、割り当ての候補から外す。
    const takenItems = new Set(allMatched.filter((transaction) => !rematchableIds.has(transaction.id) && transaction.match !== undefined)
      .map((transaction) => cardItemKey(transaction.match?.claimId as string, transaction.match?.itemId as string)));
    const dates = rematchable.map((transaction) => transaction.usedOn).sort();
    const tolerance = policy.card.dateToleranceDays;
    const items = (await this.deps.repositories.claims.findCardCandidates(scope, {
      from: addDays(dates[0] as string, -tolerance), to: addDays(dates[dates.length - 1] as string, tolerance), amounts: [],
    })).filter((item) => !takenItems.has(cardItemKey(item.claimId, item.itemId)));

    const assignments = matchCardTransactions({
      transactions: rematchable,
      items: items.map((item) => ({ ...item })),
      cards: settings.value.cards,
      tolerance: policy.card,
    });
    const byTransaction = new Map(assignments.map((assignment) => [assignment.transactionId, assignment]));
    const at = this.deps.now().toISOString();
    const changed: ExpenseCardTransaction[] = [];
    for (const transaction of rematchable) {
      const assignment = byTransaction.get(transaction.id);
      const { match: _match, ...rest } = transaction;
      const next = createExpenseCardTransaction(assignment === undefined
        ? { ...rest, status: 'unmatched', updatedAt: at }
        : {
          ...rest, status: 'matched', updatedAt: at,
          match: { claimId: assignment.claimId, itemId: assignment.itemId, kind: assignment.kind, strength: assignment.strength, dateDiffDays: assignment.dateDiffDays, amountDiff: assignment.amountDiff, manual: false, at, by },
        });
      if (!sameMatch(transaction, next)) changed.push(next);
    }
    if (changed.length > 0) await cards.saveTransactions(changed);
    return {
      matched: assignments.length,
      reimbursementMatches: assignments.filter((assignment) => assignment.kind === 'reimbursement-item').length,
      unmatched: rematchable.length - assignments.length,
      kept: kept.length,
    };
  }
}
