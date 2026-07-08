import { describe, it } from 'vitest';
import { InMemoryMemoryProposalRepository } from './in-memory-memory-proposal-repository';
import { memoryProposalRepositoryContract } from './memory-proposal-repository.contract';

describe('InMemoryMemoryProposalRepository', () => {
  it('MemoryProposalRepository 契約を満たす', async () => {
    await memoryProposalRepositoryContract(new InMemoryMemoryProposalRepository());
  });
});
