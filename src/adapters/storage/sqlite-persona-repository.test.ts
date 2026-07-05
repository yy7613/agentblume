import { describe, it } from 'vitest';
import { personaRepositoryContract } from './persona-repository.contract';
import { SqlitePersonaRepository } from './sqlite-persona-repository';

describe('SqlitePersonaRepository', () => {
  it('PersonaRepository contractを満たす', async () => {
    const repo = new SqlitePersonaRepository(':memory:');
    try { await personaRepositoryContract(repo); } finally { repo.close(); }
  });
});
