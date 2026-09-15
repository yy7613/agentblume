/**
 * ドメイン: 契約書レビューと期限台帳（docs/23-contract.md §9）のノード登録。
 *
 * 業務のノードは業務ごとの登録関数にまとめ、`index.ts` はそれを呼ぶだけにする（ADR-0039）。
 */
import type { NodeRegistry } from '../registry';
import { contractClausesSourceNode } from './contract-clauses-source';
import { contractDeadlinesSourceNode } from './contract-deadlines-source';
import { contractReviewDraftSourceNode } from './contract-review-draft';

export function registerContractNodes(registry: NodeRegistry): void {
  registry.register(contractReviewDraftSourceNode);
  registry.register(contractDeadlinesSourceNode);
  registry.register(contractClausesSourceNode);
}
