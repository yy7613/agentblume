import { describe, it } from 'vitest';
import { InMemorySkillRepository } from './in-memory-skill-repository';
import { skillRepositoryContract } from './skill-repository.contract';

describe('InMemorySkillRepository', () => {
  it('SkillRepository contractを満たす', async () => skillRepositoryContract(new InMemorySkillRepository()));
});
