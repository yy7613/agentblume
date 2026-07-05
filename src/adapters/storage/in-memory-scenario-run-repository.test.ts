import { describe, it } from 'vitest';
import { InMemoryScenarioRunRepository } from './in-memory-scenario-run-repository';
import { scenarioRunRepositoryContract } from './scenario-run-repository.contract';

describe('InMemoryScenarioRunRepository', () => {
  it('ScenarioRunRepository contractを満たす', async () => scenarioRunRepositoryContract(new InMemoryScenarioRunRepository()));
});
