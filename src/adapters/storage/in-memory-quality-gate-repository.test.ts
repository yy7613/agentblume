import { describe, it } from 'vitest';
import { InMemoryQualityGateRepository } from './in-memory-quality-gate-repository';
import { qualityGateRepositoryContract } from './quality-gate-repository.contract';
describe('InMemoryQualityGateRepository', () => { it('satisfies the repository contract', async () => qualityGateRepositoryContract(new InMemoryQualityGateRepository())); });
