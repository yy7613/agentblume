import { expect } from 'vitest';
import type { TenantScope } from '../../domain/tool/ids';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import { createMemoryProposal, decideProposal, type MemoryProposal, type MemoryProposalTarget } from '../../domain/memory/memory-proposal';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const other: TenantScope = { tenantId: 'tenant', workspaceId: 'other' };

function proposal(id: string, target: MemoryProposalTarget, createdAt: string): MemoryProposal {
  return createMemoryProposal({ id, tenant: scope, target, summary: `summary ${id}`, sourceRun: 'run-1', createdAt });
}

export async function memoryProposalRepositoryContract(repo: MemoryProposalRepository): Promise<void> {
  const wiki = proposal('m-wiki', { kind: 'wiki', pageId: 'p1', isNewPage: true, title: 'T', tags: ['a'], body: 'B' }, '2026-07-01T00:00:00.000Z');
  const skill = proposal('m-skill', { kind: 'skill', skillId: 'analysis', instructions: 'Refined.' }, '2026-07-02T00:00:00.000Z');
  await repo.save(wiki);
  await repo.save(skill);

  // find は target 内容まで復元する。
  const found = await repo.find(scope, 'm-wiki');
  expect(found?.target).toMatchObject({ kind: 'wiki', pageId: 'p1', body: 'B' });
  expect(found?.sourceRun).toBe('run-1');
  expect(await repo.find(scope, 'missing')).toBeNull();
  expect(await repo.find(other, 'm-wiki')).toBeNull();

  // list は createdAt DESC。
  expect((await repo.list(scope)).map((p) => p.id)).toEqual(['m-skill', 'm-wiki']);
  expect(await repo.list(other)).toEqual([]);

  // state 遷移を upsert で保存し、state フィルタで絞る。
  await repo.save(decideProposal(skill, 'approved'));
  expect((await repo.list(scope)).length).toBe(2);
  expect((await repo.list(scope, 'draft')).map((p) => p.id)).toEqual(['m-wiki']);
  expect((await repo.list(scope, 'approved')).map((p) => p.id)).toEqual(['m-skill']);
  expect(await repo.list(scope, 'rejected')).toEqual([]);
  expect((await repo.find(scope, 'm-skill'))?.state).toBe('approved');
}
