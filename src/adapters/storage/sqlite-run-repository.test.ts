import { describe, it } from 'vitest';
import { runRepositoryContract } from './run-repository.contract';
import { SqliteRunRepository } from './sqlite-run-repository';

describe('SqliteRunRepository', () => {
  it('RunRepository contractを満たす', async () => {
    const repo = new SqliteRunRepository(':memory:');
    try { await runRepositoryContract(repo); }
    finally { repo.close(); }
  });
});
