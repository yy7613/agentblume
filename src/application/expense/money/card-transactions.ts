/**
 * application層: カード利用の台帳（一覧・対象外の印 / 取消・手動の紐付け / 解除。docs/21 §20.2.8 / §20.9.3。UC5）。
 *
 * - 未照合の一覧 = 証憑の出ていないカード利用（申請が無いので理由コードにはしない）。
 * - 対象外（私用の立替済み・年会費など）は理由を必須にし、照合のやり直しで上書きしない。照合済みの利用は先に解除する。
 * - 手動の紐付けは、相手の明細が他のカード利用に照合済みなら断る（1 対 1 を保つ）。
 * 一覧はカードのラベル・保有者名・申請者名・取込ファイル名を足して返す（台帳とツールが同じ形を使う）。
 */
import { createExpenseCardTransaction, type CardTransactionStatus, type ExpenseCardTransaction } from '../../../domain/expense/card';
import { daysBetween } from '../../../domain/expense/business-date';
import { payeeKeyOf } from '../../../domain/expense/duplicates';
import { ExpenseCardTransactionNotFoundError, ExpenseItemNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { cardMatchStrength } from '../../../domain/expense/money/card-matching';
import { usableAmount } from '../../../domain/expense/receipt-facts';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { requireClaim } from '../manage-claims';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';

export type ExpenseCardTransactionView = Omit<ExpenseCardTransaction, 'tenant'> & {
  readonly cardLabel: string;
  readonly cardLast4: string;
  readonly holder?: string;
  readonly claimant?: string;
  readonly claimStatus?: string;
  readonly importFile: string;
};

export interface CardTransactionListOptions {
  readonly status?: CardTransactionStatus;
  readonly cardId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly claimId?: string;
  readonly limit?: number;
}

export const CARD_TRANSACTION_LIST_DEFAULT_LIMIT = 500;

export class CardTransactionsUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  private async require(scope: TenantScope, id: string): Promise<ExpenseCardTransaction> {
    const transaction = await this.deps.repositories.cards.findTransaction(scope, id);
    if (transaction === null) throw new ExpenseCardTransactionNotFoundError(`expense card transaction not found: ${id}`);
    return transaction;
  }

  async list(scope: TenantScope, options: CardTransactionListOptions = {}): Promise<readonly ExpenseCardTransactionView[]> {
    const transactions = await this.deps.repositories.cards.listTransactions(scope, { ...options, limit: options.limit ?? CARD_TRANSACTION_LIST_DEFAULT_LIMIT });
    return this.views(scope, transactions);
  }

  /** 表示用の値を足す（カード・保有者・申請者・取込ファイル）。 */
  async views(scope: TenantScope, transactions: readonly ExpenseCardTransaction[]): Promise<readonly ExpenseCardTransactionView[]> {
    if (transactions.length === 0) return [];
    const { cards } = (await this.deps.settings.load(scope, 'cards')).value;
    const cardById = new Map(cards.map((card) => [card.id, card]));
    const holderIds = [...new Set(cards.flatMap((card) => (card.holderEmployeeId === undefined ? [] : [card.holderEmployeeId])))];
    const claimIds = [...new Set(transactions.flatMap((transaction) => (transaction.match === undefined ? [] : [transaction.match.claimId])))];
    const importIds = [...new Set(transactions.map((transaction) => transaction.importId))];
    const [holders, claims, imports] = await Promise.all([
      holderIds.length === 0 ? Promise.resolve([]) : this.deps.employeeDirectory.findByIds(scope, holderIds),
      claimIds.length === 0 ? Promise.resolve([]) : this.deps.repositories.claims.findByIds(scope, claimIds),
      Promise.all(importIds.map((id) => this.deps.repositories.cards.findImport(scope, id))),
    ]);
    const holderName = new Map(holders.map((employee) => [employee.id, employee.name]));
    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    const importFile = new Map(imports.flatMap((record) => (record === null ? [] : [[record.id, record.fileName] as const])));
    return transactions.map((transaction) => {
      const { tenant: _tenant, ...rest } = transaction;
      const card = cardById.get(transaction.cardId);
      const holder = card?.holderEmployeeId === undefined ? undefined : holderName.get(card.holderEmployeeId);
      const claim = transaction.match === undefined ? undefined : claimById.get(transaction.match.claimId);
      return {
        ...rest,
        cardLabel: card?.label ?? transaction.cardId,
        cardLast4: card?.last4 ?? '',
        importFile: importFile.get(transaction.importId) ?? transaction.importId,
        ...(holder === undefined ? {} : { holder }),
        ...(claim === undefined ? {} : { claimant: claim.claimant.name, claimStatus: claim.status }),
      };
    });
  }

  async exclude(scope: TenantScope, id: string, reason: string, by: string): Promise<ExpenseCardTransactionView> {
    const transaction = await this.require(scope, id);
    if (transaction.status === 'matched') {
      throw new ExpenseTransitionError(`exclude card transaction: ${id} is matched to claim ${transaction.match?.claimId ?? ''}`, {
        nextStep: '照合済みの利用は対象外にできません。先に紐付けを外してください',
        blockingReasons: [{ code: 'card-transaction-matched', params: { cardTransactionId: id, claimId: transaction.match?.claimId ?? null } }],
      });
    }
    if (transaction.status === 'excluded') {
      throw new ExpenseTransitionError(`exclude card transaction: ${id} is already excluded`, { nextStep: 'この利用は既に対象外です。理由を変えるなら対象外を取り消してから付け直してください' });
    }
    const at = this.deps.now().toISOString();
    const next = createExpenseCardTransaction({ ...transaction, status: 'excluded', exclusion: { reason, by, at }, updatedAt: at });
    await this.deps.repositories.cards.saveTransactions([next]);
    return (await this.views(scope, [next]))[0] as ExpenseCardTransactionView;
  }

  async include(scope: TenantScope, id: string): Promise<ExpenseCardTransactionView> {
    const transaction = await this.require(scope, id);
    if (transaction.status !== 'excluded') {
      throw new ExpenseTransitionError(`include card transaction: ${id} is not excluded`, { nextStep: '対象外の印が付いた利用だけを戻せます' });
    }
    const { exclusion: _exclusion, ...rest } = transaction;
    const next = createExpenseCardTransaction({ ...rest, status: 'unmatched', updatedAt: this.deps.now().toISOString() });
    await this.deps.repositories.cards.saveTransactions([next]);
    return (await this.views(scope, [next]))[0] as ExpenseCardTransactionView;
  }

  async link(scope: TenantScope, id: string, target: { readonly claimId: string; readonly itemId: string }, by: string): Promise<ExpenseCardTransactionView> {
    const transaction = await this.require(scope, id);
    if (transaction.status === 'excluded') {
      throw new ExpenseTransitionError(`link card transaction: ${id} is excluded`, { nextStep: '対象外の利用は紐付けられません。先に対象外を取り消してください' });
    }
    const claim = await requireClaim(this.deps.repositories.claims, scope, target.claimId);
    const item = claim.items.find((entry) => entry.id === target.itemId);
    if (item === undefined) throw new ExpenseItemNotFoundError(`expense item not found: ${target.claimId}/${target.itemId}`);
    const others = await this.deps.repositories.cards.listTransactions(scope, { claimId: target.claimId, limit: 2000 });
    const taken = others.find((other) => other.id !== id && other.status === 'matched' && other.match?.itemId === target.itemId);
    if (taken !== undefined) {
      throw new ExpenseTransitionError(`link card transaction: item ${target.itemId} is already matched to ${taken.id}`, {
        nextStep: `この明細は別のカード利用（${taken.usedOn} ${taken.merchantRaw} ${taken.amount} 円）に照合済みです。そちらの紐付けを外してから操作してください`,
        blockingReasons: [{ code: 'card-item-matched', params: { cardTransactionId: taken.id, claimId: target.claimId, itemId: target.itemId } }],
      });
    }
    const { policy } = await loadExpensePolicy(this.deps.repositories.policies, scope);
    const amount = usableAmount(item.facts);
    const at = this.deps.now().toISOString();
    const { exclusion: _exclusion, ...rest } = transaction;
    const next = createExpenseCardTransaction({
      ...rest, status: 'matched', updatedAt: at,
      match: {
        claimId: claim.id, itemId: item.id, kind: item.facts.corporatePayment === true ? 'corporate-item' : 'reimbursement-item',
        strength: cardMatchStrength(transaction.merchantKey, payeeKeyOf(item.facts.payeeName), transaction.amount, policy.card.weakMatchMinAmount) ?? 'weak',
        dateDiffDays: item.facts.transactionDate === undefined ? 0 : daysBetween(item.facts.transactionDate, transaction.usedOn),
        amountDiff: amount === undefined ? 0 : transaction.amount - amount,
        manual: true, at, by,
      },
    });
    await this.deps.repositories.cards.saveTransactions([next]);
    return (await this.views(scope, [next]))[0] as ExpenseCardTransactionView;
  }

  async unlink(scope: TenantScope, id: string): Promise<ExpenseCardTransactionView> {
    const transaction = await this.require(scope, id);
    if (transaction.status !== 'matched') {
      throw new ExpenseTransitionError(`unlink card transaction: ${id} is not matched`, { nextStep: '照合済みの利用だけを解除できます' });
    }
    const { match: _match, ...rest } = transaction;
    const next = createExpenseCardTransaction({ ...rest, status: 'unmatched', updatedAt: this.deps.now().toISOString() });
    await this.deps.repositories.cards.saveTransactions([next]);
    return (await this.views(scope, [next]))[0] as ExpenseCardTransactionView;
  }
}
