/**
 * application層: B の行ソース（`expense-summary` / `expense-advances` / `expense-card-transactions`。docs/21 §20.11）。
 *
 * ADR-0039 §1 の規律（書き換えの規律は共通側。ここは「どのノードを・どのスキーマで・設定をどう読んで・どこから行を取るか」だけ）。
 * どれも保存済みのデータを読むだけなので実行文脈に依らない（`requirement: 'none'`）。`expense-summary` はツールの引数
 * （`arguments` の period / group_by / status）で行の作り方を変える（§20.14 G-2）。不正な設定・引数は `DataSourceValidationError`。
 */
import { EXPENSE_ADVANCES_SCHEMA, EXPENSE_ADVANCES_SOURCE_MAX_ROWS } from '../../../domain/etl/nodes/expense-advances-source';
import { EXPENSE_CARD_TRANSACTIONS_SCHEMA, EXPENSE_CARD_TRANSACTIONS_SOURCE_MAX_ROWS } from '../../../domain/etl/nodes/expense-card-transactions-source';
import { EXPENSE_SUMMARY_SCHEMA, EXPENSE_SUMMARY_SOURCE_MAX_ROWS } from '../../../domain/etl/nodes/expense-summary-source';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { DataSourceValidationError } from '../../data-source/manage-data-sources';
import type { RowSourceResolver } from '../../data-source/row-sources';
import type { ExpenseSystemDeps } from '../system-deps';
import { ExpenseAdvanceRowsProvider } from './advance-rows';
import { ExpenseCardTransactionRowsProvider } from './card-rows';
import { CardTransactionsUseCase } from './card-transactions';
import { ManageExpenseAdvancesUseCase } from './manage-advances';
import { SummarizeExpensesUseCase } from './summary';
import { ExpenseSummaryRowsProvider } from './summary-rows';

function limitOf(config: Readonly<Record<string, unknown>>, max: number, label: string): number | undefined {
  const limit = config['limit'];
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) throw new DataSourceValidationError(`${label} source has invalid settings`);
  return limit;
}

/** 引数の誤り（ExpenseDomainError）はモデルが直せるよう、同じ文言で行ソースの検証エラーにする。 */
async function asValidation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ExpenseDomainError) throw new DataSourceValidationError(error.message);
    throw error;
  }
}

export function expenseMoneyRowSources(deps: ExpenseSystemDeps): readonly RowSourceResolver[] {
  const summary = new ExpenseSummaryRowsProvider(new SummarizeExpensesUseCase(deps), deps);
  const advances = new ExpenseAdvanceRowsProvider(new ManageExpenseAdvancesUseCase(deps));
  const cards = new ExpenseCardTransactionRowsProvider(new CardTransactionsUseCase(deps));
  return [
    {
      nodeType: 'expense-summary',
      schema: EXPENSE_SUMMARY_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'expense summary is not available',
      rows: async ({ scope, config, arguments: args }) => {
        const limit = limitOf(config, EXPENSE_SUMMARY_SOURCE_MAX_ROWS, 'expense summary');
        return asValidation(() => summary.rows(scope, args, limit));
      },
    },
    {
      nodeType: 'expense-advances',
      schema: EXPENSE_ADVANCES_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'expense advances are not available',
      rows: async ({ scope, config }) => advances.rows(scope, limitOf(config, EXPENSE_ADVANCES_SOURCE_MAX_ROWS, 'expense advances')),
    },
    {
      nodeType: 'expense-card-transactions',
      schema: EXPENSE_CARD_TRANSACTIONS_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'expense card transactions are not available',
      rows: async ({ scope, config }) => cards.rows(scope, limitOf(config, EXPENSE_CARD_TRANSACTIONS_SOURCE_MAX_ROWS, 'expense card transactions')),
    },
  ];
}
