import { describe, it } from 'vitest';
import { InMemoryOperationsRepository } from './in-memory-operations-repository';
import { operationsRepositoryContract } from './operations-repository.contract';

describe('InMemoryOperationsRepository', () => {
  it('operations repository contractを満たす', async () => operationsRepositoryContract(new InMemoryOperationsRepository()));
});

