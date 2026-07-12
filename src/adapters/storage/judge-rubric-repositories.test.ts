import { describe, it } from 'vitest';
import { InMemoryJudgeRubricRepository } from './in-memory-judge-rubric-repository';
import { SqliteJudgeRubricRepository } from './sqlite-judge-rubric-repository';
import { judgeRubricRepositoryContract } from './judge-rubric-repository.contract';
describe('JudgeRubric repositories', () => {
  it('InMemory contract', async () => judgeRubricRepositoryContract(new InMemoryJudgeRubricRepository()));
  it('SQLite contract', async () => { const repo = new SqliteJudgeRubricRepository(); try { await judgeRubricRepositoryContract(repo); } finally { repo.close(); } });
});
