import { describe, expect, it } from 'vitest';
import { FakeWikiRepository } from './memory-repositories.fixtures';
import { QueryWikiSpacesUseCase, SaveWikiSpaceUseCase } from './wiki-spaces';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('Wiki space use cases', () => {
  it('作成・改訂・一覧・取得をscope内で行う', async () => {
    const repo = new FakeWikiRepository(); let day = 10;
    const save = new SaveWikiSpaceUseCase(repo, () => new Date(`2026-07-${day++}T00:00:00.000Z`));
    const query = new QueryWikiSpacesUseCase(repo);
    await save.execute({ scope, id: 'customer-a', name: 'Customer A', description: 'A' });
    const revised = await save.execute({ scope, id: 'customer-a', name: 'Customer A knowledge', description: 'A2' });
    expect(revised.createdAt).toBe('2026-07-10T00:00:00.000Z'); expect(revised.updatedAt).toBe('2026-07-11T00:00:00.000Z');
    await expect(query.list(scope)).resolves.toEqual([expect.objectContaining({ id: 'customer-a', name: 'Customer A knowledge' })]);
    await expect(query.get(scope, 'customer-a')).resolves.toMatchObject({ description: 'A2' });
    await expect(query.get(scope, 'ghost')).rejects.toThrow(/wiki not found/);
  });
});
