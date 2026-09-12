import { afterEach, describe, it } from 'vitest';
import { harnessRunRepositoryCompareAndSetContract, harnessRunRepositoryContract } from './harness-run-repository.contract';
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

  describe('saveIfStatus（compare-and-set）の境界・異常系', () => {
    it('InMemory実装: 期待状態のときだけ書き、未知の run・空の expected・不一致・終端では何も書かない', async () => {
      await harnessRunRepositoryCompareAndSetContract(new InMemoryHarnessRunRepository());
    });

    it('SQLite実装: 期待状態のときだけ書き、未知の run・空の expected・不一致・終端では何も書かない', async () => {
      const repo = new SqliteHarnessRunRepository(); repositories.push(repo);
      await harnessRunRepositoryCompareAndSetContract(repo);
    });
  });
});
