/**
 * ドメイン: 経費精算（docs/21-expense.md §13）のノード登録。
 *
 * 業務のノードは業務ごとの登録関数にまとめ、`index.ts` はそれを呼ぶだけにする（ADR-0039）。
 */
import type { NodeRegistry } from '../registry';
import { expenseClaimsSourceNode } from './expense-claims-source';
import { registerExpenseInputNodes } from './expense-input-nodes';
import { registerExpenseMoneyNodes } from './expense-money-nodes';
import { expensePolicySourceNode } from './expense-policy-source';
import { expenseReceiptCheckSourceNode } from './expense-receipt-check';

export function registerExpenseNodes(registry: NodeRegistry): void {
  registry.register(expenseReceiptCheckSourceNode);
  registry.register(expenseClaimsSourceNode);
  registry.register(expensePolicySourceNode);
  // 実用化の系統のノード（docs/21 §20.11。A はノードを持たない）。
  registerExpenseMoneyNodes(registry);
  registerExpenseInputNodes(registry);
}
