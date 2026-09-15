/**
 * application層: C の行ソース（`expense-fares`。docs/21 §20.11.4）。
 *
 * ADR-0039 §1 の規律（書き換えの規律は共通側の `resolveRowSourceNode`）に従い、ノード型・スキーマ・要件・行の取り方だけを宣言する。
 * 保存済みの設定を読むだけなので実行文脈に依らない（`requirement: 'none'`）。ツールの引数は filter が使うので、ここでは読まない。
 */
import { EXPENSE_FARES_SCHEMA } from '../../../domain/etl/nodes/expense-fares-source';
import { DataSourceValidationError } from '../../data-source/manage-data-sources';
import type { RowSourceResolver } from '../../data-source/row-sources';
import type { ExpenseSystemDeps } from '../system-deps';
import { ExpenseFareRowsProvider } from './fare-rows';

export function expenseInputRowSources(deps: Pick<ExpenseSystemDeps, 'settings'>): readonly RowSourceResolver[] {
  const fares = new ExpenseFareRowsProvider(deps.settings);
  return [
    {
      nodeType: 'expense-fares',
      schema: EXPENSE_FARES_SCHEMA,
      requirement: 'none',
      unavailableMessage: 'expense fares are not available',
      rows: async ({ scope, config }) => {
        if (Object.keys(config).length > 0) throw new DataSourceValidationError('expense fares source has invalid settings: it takes no settings');
        return fares.rows(scope);
      },
    },
  ];
}
