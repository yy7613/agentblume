import { describe, it } from 'vitest';
import { scenarioRunRepositoryContract } from './scenario-run-repository.contract';
import { SqliteScenarioRunRepository } from './sqlite-scenario-run-repository';

describe('SqliteScenarioRunRepository', () => {
  it('ScenarioRunRepository contractを満たす', async () => {
    const repo = new SqliteScenarioRunRepository(':memory:');
    try { await scenarioRunRepositoryContract(repo); } finally { repo.close(); }
  });
});
