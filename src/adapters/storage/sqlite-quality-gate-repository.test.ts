import { describe, it } from 'vitest';
import { SqliteQualityGateRepository } from './sqlite-quality-gate-repository';
import { qualityGateRepositoryContract } from './quality-gate-repository.contract';
describe('SqliteQualityGateRepository', () => { it('satisfies the repository contract', async () => { const repo = new SqliteQualityGateRepository(); try { await qualityGateRepositoryContract(repo); } finally { repo.close(); } }); });
