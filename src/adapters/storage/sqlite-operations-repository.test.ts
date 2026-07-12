import { describe, it } from 'vitest';
import { SqliteOperationsRepository } from './sqlite-operations-repository';
import { operationsRepositoryContract } from './operations-repository.contract';

describe('SqliteOperationsRepository', () => {
  it('operations repository contractを満たす', async () => {
    const repo = new SqliteOperationsRepository(':memory:');
    try { await operationsRepositoryContract(repo); } finally { repo.close(); }
  });
});

