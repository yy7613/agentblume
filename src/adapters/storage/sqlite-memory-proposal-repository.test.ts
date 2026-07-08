import { afterEach, describe, it } from 'vitest';
import { SqliteMemoryProposalRepository } from './sqlite-memory-proposal-repository';
import { memoryProposalRepositoryContract } from './memory-proposal-repository.contract';

let repo: SqliteMemoryProposalRepository;
afterEach(() => repo?.close());

describe('SqliteMemoryProposalRepository', () => {
  it('MemoryProposalRepository 契約を満たす（:memory:）', async () => {
    repo = new SqliteMemoryProposalRepository();
    await memoryProposalRepositoryContract(repo);
  });
});
