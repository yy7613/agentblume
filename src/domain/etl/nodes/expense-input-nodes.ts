/**
 * ドメイン: 経費精算「入力と規程」のノード登録（`expense-fares`。docs/21 §20.11.4）。
 *
 * ノード本体は `expense-fares-source.ts` に置き、ここで登録する。
 */
import type { NodeRegistry } from '../registry';
import { expenseFaresSourceNode } from './expense-fares-source';

export function registerExpenseInputNodes(registry: NodeRegistry): void {
  registry.register(expenseFaresSourceNode);
}
