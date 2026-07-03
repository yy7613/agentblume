import { describe, it } from 'vitest';
import { agentRepositoryContract } from './agent-repository.contract';
import { InMemoryAgentRepository } from './in-memory-agent-repository';

describe('InMemoryAgentRepository', () => {
  it('AgentRepository contractを満たす', async () => agentRepositoryContract(new InMemoryAgentRepository()));
});
