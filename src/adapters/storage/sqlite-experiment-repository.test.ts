import { describe, it } from 'vitest';
import { SqliteExperimentRepository } from './sqlite-experiment-repository';
import { experimentRepositoryContract } from './experiment-repository.contract';
describe('SqliteExperimentRepository', () => { it('共有契約を満たす', async () => { const repo = new SqliteExperimentRepository(); try { await experimentRepositoryContract(repo); } finally { repo.close(); } }); });
