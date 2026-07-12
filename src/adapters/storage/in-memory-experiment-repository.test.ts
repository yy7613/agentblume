import { describe, it } from 'vitest';
import { InMemoryExperimentRepository } from './in-memory-experiment-repository';
import { experimentRepositoryContract } from './experiment-repository.contract';
describe('InMemoryExperimentRepository', () => { it('共有契約を満たす', async () => experimentRepositoryContract(new InMemoryExperimentRepository())); });
