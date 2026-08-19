import { tenantKey, type TenantScope } from '../../domain/shared/tenant-scope';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import type { MemoryProposal, MemoryProposalState } from '../../domain/memory/memory-proposal';
import { deserializeMemoryProposal, serializeMemoryProposal, type SerializedMemoryProposal } from '../../domain/memory/serialization';

const key = (scope: TenantScope, id: string) => `${tenantKey(scope)} ${id}`;

export class InMemoryMemoryProposalRepository implements MemoryProposalRepository {
  private readonly store = new Map<string, SerializedMemoryProposal>();

  async save(proposal: MemoryProposal): Promise<void> {
    this.store.set(key(proposal.tenant, proposal.id), serializeMemoryProposal(proposal));
  }

  async find(scope: TenantScope, id: string): Promise<MemoryProposal | null> {
    const value = this.store.get(key(scope, id));
    return value === undefined ? null : deserializeMemoryProposal(value);
  }

  async list(scope: TenantScope, state?: MemoryProposalState): Promise<MemoryProposal[]> {
    return [...this.store.values()]
      .filter((value) => tenantKey(value.tenant) === tenantKey(scope) && (state === undefined || value.state === state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(deserializeMemoryProposal);
  }
}
