import { describe, it } from 'vitest';
import { InMemoryPersonaRepository } from './in-memory-persona-repository';
import { personaRepositoryContract } from './persona-repository.contract';

describe('InMemoryPersonaRepository', () => {
  it('PersonaRepository contractを満たす', async () => personaRepositoryContract(new InMemoryPersonaRepository()));
});
