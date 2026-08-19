/**
 * ドメイン: 記憶提案リポジトリ境界（v21 実装契約 §1.5 / ADR-0016）
 *
 * save は id で upsert（draft→approved/rejected の状態遷移を保存）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { MemoryProposalId } from './ids';
import type { MemoryProposal, MemoryProposalState } from './memory-proposal';

export interface MemoryProposalRepository {
  save(proposal: MemoryProposal): Promise<void>;
  find(scope: TenantScope, id: MemoryProposalId): Promise<MemoryProposal | null>;
  /** state 指定時はその状態のみ。createdAt DESC。 */
  list(scope: TenantScope, state?: MemoryProposalState): Promise<MemoryProposal[]>;
}
