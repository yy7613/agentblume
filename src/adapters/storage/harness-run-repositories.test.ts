import { afterEach, describe, it } from 'vitest';
import { harnessRunRepositoryContract } from './harness-run-repository.contract';
import { InMemoryHarnessRunRepository } from './in-memory-harness-run-repository';
import { SqliteHarnessRunRepository } from './sqlite-harness-run-repository';

describe('HarnessRunRepository の共有契約', () => {
  const repositories: SqliteHarnessRunRepository[] = [];
  afterEach(() => { repositories.splice(0).forEach((repository) => repository.close()); });

  it('InMemory実装が契約を満たす', async () => {
    await harnessRunRepositoryContract(new InMemoryHarnessRunRepository());
  });

  it('SQLite実装が契約を満たす', async () => {
    const repo = new SqliteHarnessRunRepository(); repositories.push(repo);
    await harnessRunRepositoryContract(repo);
  });
});
