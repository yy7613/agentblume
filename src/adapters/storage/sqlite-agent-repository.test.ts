import { describe, it } from 'vitest';
import { agentRepositoryContract } from './agent-repository.contract';
import { SqliteAgentRepository } from './sqlite-agent-repository';

describe('SqliteAgentRepository', () => {
  it('AgentRepository contractを満たす', async () => {
    const repo = new SqliteAgentRepository(':memory:');
    try { await agentRepositoryContract(repo); } finally { repo.close(); }
  });
});
