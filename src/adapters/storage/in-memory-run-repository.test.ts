import { describe, it } from 'vitest';
import { InMemoryRunRepository } from './in-memory-run-repository';
import { runRepositoryContract } from './run-repository.contract';

describe('InMemoryRunRepository', () => {
  it('RunRepository contractを満たす', async () => runRepositoryContract(new InMemoryRunRepository()));
});
