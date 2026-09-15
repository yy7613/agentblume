/**
 * ドメイン: 入金消込（docs/22-receivables.md §10）のノード登録。
 *
 * 業務のノードは業務ごとの登録関数にまとめ、`index.ts` はそれを呼ぶだけにする（ADR-0039）。
 */
import type { NodeRegistry } from '../registry';
import { receivablesInvoiceDraftNode } from './receivables-invoice-draft';
import { receivablesMatchCandidatesNode } from './receivables-match-candidates';
import { receivablesOutstandingNode } from './receivables-outstanding';

export function registerReceivablesNodes(registry: NodeRegistry): void {
  registry.register(receivablesOutstandingNode);
  registry.register(receivablesMatchCandidatesNode);
  registry.register(receivablesInvoiceDraftNode);
}
