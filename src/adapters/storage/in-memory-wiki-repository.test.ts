import { describe, it } from 'vitest';
import { InMemoryWikiRepository } from './in-memory-wiki-repository';
import { wikiRepositoryContract } from './wiki-repository.contract';

describe('InMemoryWikiRepository', () => {
  it('WikiRepository 契約を満たす', async () => {
    await wikiRepositoryContract(new InMemoryWikiRepository());
  });
});
