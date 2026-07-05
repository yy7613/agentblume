import { describe, it } from 'vitest';
import { scenarioRepositoryContract } from './scenario-repository.contract';
import { SqliteScenarioRepository } from './sqlite-scenario-repository';

describe('SqliteScenarioRepository', () => {
  it('ScenarioRepository contractを満たす', async () => {
    const repo = new SqliteScenarioRepository(':memory:');
    try { await scenarioRepositoryContract(repo); } finally { repo.close(); }
  });
});
