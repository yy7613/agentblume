/**
 * application層: `expense_card_transactions` の行の供給（docs/21 §20.11.3）。
 *
 * 照合は保存済みの結果を出す（ツールで照合し直さない）。カード番号は下 4 桁だけ。
 */
import type { Row } from '../../../domain/data/types';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { CardTransactionsUseCase, ExpenseCardTransactionView } from './card-transactions';

export function cardTransactionRow(transaction: ExpenseCardTransactionView): Row {
  return {
    transaction_id: transaction.id,
    card_id: transaction.cardId,
    card_label: transaction.cardLabel,
    card_last4: transaction.cardLast4,
    holder: transaction.holder ?? null,
    used_on: transaction.usedOn,
    merchant: transaction.merchantRaw,
    amount: transaction.amount,
    status: transaction.status,
    match_kind: transaction.match?.kind ?? null,
    match_strength: transaction.match?.strength ?? null,
    claim_id: transaction.match?.claimId ?? null,
    item_id: transaction.match?.itemId ?? null,
    claimant: transaction.claimant ?? null,
    claim_status: transaction.claimStatus ?? null,
    date_diff_days: transaction.match?.dateDiffDays ?? null,
    exclusion_reason: transaction.exclusion?.reason ?? null,
    import_file: transaction.importFile,
    updated_at: transaction.updatedAt,
  };
}

export class ExpenseCardTransactionRowsProvider {
  constructor(private readonly transactions: CardTransactionsUseCase) {}

  async rows(scope: TenantScope, limit?: number): Promise<readonly Row[]> {
    return (await this.transactions.list(scope, { ...(limit === undefined ? {} : { limit }) })).map(cardTransactionRow);
  }
}
