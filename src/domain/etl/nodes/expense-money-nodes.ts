/**
 * ドメイン: 経費精算「お金の流れ」のノード登録（`expense-summary` / `expense-advances` / `expense-card-transactions`。docs/21 §20.11）。
 *
 * ノード本体は `expense-summary-source.ts` などに置き、ここで登録する。行は application の `expenseMoneyRowSources` が差し込む。
 * export 名と形（`registerExpenseMoneyNodes(registry: NodeRegistry): void`）は骨格が決めたもの。
 */
import type { NodeRegistry } from '../registry';
import { expenseAdvancesSourceNode } from './expense-advances-source';
import { expenseCardTransactionsSourceNode } from './expense-card-transactions-source';
import { expenseSummarySourceNode } from './expense-summary-source';

export function registerExpenseMoneyNodes(registry: NodeRegistry): void {
  registry.register(expenseSummarySourceNode);
  registry.register(expenseAdvancesSourceNode);
  registry.register(expenseCardTransactionsSourceNode);
}
