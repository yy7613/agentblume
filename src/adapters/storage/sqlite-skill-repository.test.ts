import { describe, it } from 'vitest';
import { skillRepositoryContract } from './skill-repository.contract';
import { SqliteSkillRepository } from './sqlite-skill-repository';

describe('SqliteSkillRepository', () => {
  it('SkillRepository contractを満たす', async () => {
    const repo = new SqliteSkillRepository(':memory:');
    try { await skillRepositoryContract(repo); } finally { repo.close(); }
  });
});
