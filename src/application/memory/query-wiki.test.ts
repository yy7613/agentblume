import { describe, expect, it } from 'vitest';
import { FakeWikiRepository } from './memory-repositories.fixtures';
import { WikiPageNotFoundError } from '../../domain/memory/errors';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { QueryWikiUseCase } from './query-wiki';

const scope = { tenantId: 'local', workspaceId: 'default' };

async function make() {
  const wiki = new FakeWikiRepository();
  await wiki.save(createWikiPage({ id: 'a', tenant: scope, title: 'Cohort SQL', tags: ['sql'], body: 'age filter', updatedAt: '2026-07-01T00:00:00.000Z' }));
  await wiki.save(createWikiPage({ id: 'b', tenant: scope, title: 'ETL', tags: ['etl'], body: 'joins', updatedAt: '2026-07-02T00:00:00.000Z' }));
  return new QueryWikiUseCase(wiki);
}

describe('QueryWikiUseCase', () => {
  it('get は本文を返し、未存在は WikiPageNotFoundError', async () => {
    const q = await make();
    expect((await q.get(scope, 'a')).body).toBe('age filter');
    await expect(q.get(scope, 'zzz')).rejects.toBeInstanceOf(WikiPageNotFoundError);
  });

  it('list は updatedAt DESC の要約', async () => {
    const q = await make();
    expect((await q.list(scope)).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('search はキーワード一致、既定 limit=10', async () => {
    const q = await make();
    expect((await q.search(scope, 'cohort')).map((s) => s.id)).toEqual(['a']);
    expect((await q.search(scope, 'etl')).map((s) => s.id)).toEqual(['b']);
  });
});
