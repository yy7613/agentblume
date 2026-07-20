import { describe, it } from 'vitest';
import { InMemoryFactoryRunRepository } from './in-memory-factory-run-repository';
import { factoryRunRepositoryContract } from './factory-run-repository.contract';
describe('InMemoryFactoryRunRepository', () => { it('共有契約を満たす', async () => factoryRunRepositoryContract(new InMemoryFactoryRunRepository())); });
