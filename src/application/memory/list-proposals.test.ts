import { describe, expect, it } from 'vitest';
import { FakeMemoryProposalRepository } from './memory-repositories.fixtures';
import { MemoryProposalNotFoundError } from '../../domain/memory/errors';
import { createMemoryProposal } from '../../domain/memory/memory-proposal';
import { ListProposalsUseCase } from './list-proposals';

const scope = { tenantId: 'local', workspaceId: 'default' };

async function make() {
  const repo = new FakeMemoryProposalRepository();
  await repo.save(createMemoryProposal({ id: 'm1', tenant: scope, target: { kind: 'wiki', pageId: 'p', isNewPage: true, title: 'T', tags: [], body: 'B' }, summary: 's1', createdAt: '2026-07-01T00:00:00.000Z' }));
  await repo.save(createMemoryProposal({ id: 'm2', tenant: scope, target: { kind: 'skill', skillId: 'x', instructions: 'I' }, summary: 's2', createdAt: '2026-07-02T00:00:00.000Z' }));
  return new ListProposalsUseCase(repo);
}

describe('ListProposalsUseCase', () => {
  it('list は createdAt DESC、state で絞れる', async () => {
    const uc = await make();
    expect((await uc.list(scope)).map((p) => p.id)).toEqual(['m2', 'm1']);
    expect((await uc.list(scope, 'draft')).length).toBe(2);
  });

  it('get 未存在は MemoryProposalNotFoundError', async () => {
    const uc = await make();
    expect((await uc.get(scope, 'm1')).summary).toBe('s1');
    await expect(uc.get(scope, 'nope')).rejects.toBeInstanceOf(MemoryProposalNotFoundError);
  });
});
