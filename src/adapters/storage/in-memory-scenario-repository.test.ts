import { describe, it } from 'vitest';
import { InMemoryScenarioRepository } from './in-memory-scenario-repository';
import { scenarioRepositoryContract } from './scenario-repository.contract';

describe('InMemoryScenarioRepository', () => {
  it('ScenarioRepository contractを満たす', async () => scenarioRepositoryContract(new InMemoryScenarioRepository()));
});
