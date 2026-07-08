import { describe, expect, it } from 'vitest';
import { FakeWikiRepository } from './memory-repositories.fixtures';
import { SaveWikiPageUseCase } from './save-wiki-page';

const scope = { tenantId: 'local', workspaceId: 'default' };

function make() {
  const wiki = new FakeWikiRepository();
  let seq = 0;
  const usecase = new SaveWikiPageUseCase(wiki, () => `id-${(seq += 1)}`, () => new Date('2026-07-08T00:00:00.000Z'));
  return { wiki, usecase };
}

describe('SaveWikiPageUseCase', () => {
  it('id 省略で新規作成（version=1・id 自動採番）', async () => {
    const { usecase } = make();
    const page = await usecase.execute({ scope, title: 'T', tags: ['a'], body: 'B' });
    expect(page.id).toBe('id-1');
    expect(page.version).toBe(1);
  });

  it('既存 id は改訂（version+1・sourceRun 追記）', async () => {
    const { usecase } = make();
    await usecase.execute({ scope, id: 'p', title: 'T', tags: ['a'], body: 'B', sourceRunId: 'run-1' });
    const revised = await usecase.execute({ scope, id: 'p', title: 'T2', tags: ['b'], body: 'B2', sourceRunId: 'run-2' });
    expect(revised.version).toBe(2);
    expect(revised.title).toBe('T2');
    expect(revised.sourceRuns).toEqual(['run-1', 'run-2']);
  });

  it('未知 id 指定は新規作成（その id で version=1）', async () => {
    const { usecase } = make();
    const page = await usecase.execute({ scope, id: 'given', title: 'T', tags: [], body: 'B' });
    expect(page.id).toBe('given');
    expect(page.version).toBe(1);
  });
});
