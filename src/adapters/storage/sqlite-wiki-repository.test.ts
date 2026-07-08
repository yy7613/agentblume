import { afterEach, describe, it } from 'vitest';
import { SqliteWikiRepository } from './sqlite-wiki-repository';
import { wikiRepositoryContract } from './wiki-repository.contract';

let repo: SqliteWikiRepository;
afterEach(() => repo?.close());

describe('SqliteWikiRepository', () => {
  it('WikiRepository 契約を満たす（:memory:）', async () => {
    repo = new SqliteWikiRepository();
    await wikiRepositoryContract(repo);
  });
});
