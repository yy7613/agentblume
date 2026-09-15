/**
 * Composition: 経費精算「お金の流れ」（振込データ・仮払・法人カード・集計。UC3〜UC6）の組み立て。
 *
 * `feature` のキーは `expense` で始める（`ExpenseAppFeature` に展開され、api の `ExpenseMoneyRouteDeps` を満たす）。
 * 行ソース（`expenseMoneyRowSources`）はデータソース解決へ登録される。仕訳下書きは `core.journalDrafts` を使う。
 * リポジトリは作り直さず `core.repositories` を使う（test プロファイルで骨格の申請と同じ保管庫を見るため）。
 */
import { DraftAdvanceJournalEntriesUseCase } from '../application/expense/money/advance-journal-drafts';
import { ExpenseCardSettingsUseCase } from '../application/expense/money/card-settings';
import { CardTransactionsUseCase } from '../application/expense/money/card-transactions';
import { MoneyCheckFactsProvider } from '../application/expense/money/check-facts';
import { ImportCardStatementUseCase } from '../application/expense/money/import-card-statement';
import { LinkClaimAdvanceUseCase, ManageExpenseAdvancesUseCase } from '../application/expense/money/manage-advances';
import { ManagePayoutSettingsUseCase } from '../application/expense/money/manage-payout-settings';
import { MatchCardTransactionsUseCase } from '../application/expense/money/match-card-transactions';
import { GetExpenseMoneyReadinessUseCase } from '../application/expense/money/money-readiness';
import { ExpensePayoutsUseCase } from '../application/expense/money/payouts';
import { expenseMoneyRowSources } from '../application/expense/money/row-sources';
import { SettleExpenseAdvanceUseCase } from '../application/expense/money/settle-advance';
import { SummarizeExpensesUseCase } from '../application/expense/money/summary';
import type { ExpenseCoreServices, ExpenseSystemComposition } from './expense-core';

/** App のうち「お金の流れ」の部分。 */
export interface ExpenseMoneyFeature {
  readonly expenseMoneyReadiness: GetExpenseMoneyReadinessUseCase;
  readonly expenseAdvances: ManageExpenseAdvancesUseCase;
  readonly expenseLinkClaimAdvance: LinkClaimAdvanceUseCase;
  readonly expenseSettleAdvance: SettleExpenseAdvanceUseCase;
  readonly expenseAdvanceJournalDrafts: DraftAdvanceJournalEntriesUseCase;
  readonly expenseCardSettings: ExpenseCardSettingsUseCase;
  readonly expenseCardStatements: ImportCardStatementUseCase;
  readonly expenseCardMatching: MatchCardTransactionsUseCase;
  readonly expenseCardTransactions: CardTransactionsUseCase;
  readonly expenseSummary: SummarizeExpensesUseCase;
  readonly expensePayoutSettings: ManagePayoutSettingsUseCase;
  readonly expensePayouts: ExpensePayoutsUseCase;
}

export type ExpenseMoneyComposition = ExpenseSystemComposition<ExpenseMoneyFeature>;

export function composeExpenseMoney(core: ExpenseCoreServices): ExpenseMoneyComposition {
  return {
    feature: {
      expenseMoneyReadiness: new GetExpenseMoneyReadinessUseCase(core),
      expenseAdvances: new ManageExpenseAdvancesUseCase(core),
      expenseLinkClaimAdvance: new LinkClaimAdvanceUseCase(core),
      expenseSettleAdvance: new SettleExpenseAdvanceUseCase(core),
      expenseAdvanceJournalDrafts: new DraftAdvanceJournalEntriesUseCase(core),
      expenseCardSettings: new ExpenseCardSettingsUseCase(core),
      expenseCardStatements: new ImportCardStatementUseCase(core),
      expenseCardMatching: new MatchCardTransactionsUseCase(core),
      expenseCardTransactions: new CardTransactionsUseCase(core),
      expenseSummary: new SummarizeExpensesUseCase(core),
      expensePayoutSettings: new ManagePayoutSettingsUseCase(core),
      expensePayouts: new ExpensePayoutsUseCase(core),
    },
    rowSources: expenseMoneyRowSources(core),
    checkFacts: new MoneyCheckFactsProvider(core),
  };
}
