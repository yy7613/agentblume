/**
 * application層: 記憶提案の一覧・取得（v21 実装契約 §3 / ADR-0016 M2）
 */
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { MemoryProposalNotFoundError } from '../../domain/memory/errors';
import type { MemoryProposalId } from '../../domain/memory/ids';
import type { MemoryProposal, MemoryProposalState } from '../../domain/memory/memory-proposal';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';

export class ListProposalsUseCase {
  constructor(private readonly proposals: MemoryProposalRepository) {}

  async list(scope: TenantScope, state?: MemoryProposalState): Promise<MemoryProposal[]> {
    return this.proposals.list(scope, state);
  }

  async get(scope: TenantScope, id: MemoryProposalId): Promise<MemoryProposal> {
    const proposal = await this.proposals.find(scope, id);
    if (proposal === null) throw new MemoryProposalNotFoundError(`ListProposals: proposal not found: ${id}`);
    return proposal;
  }
}
