import { describe, expect, it } from 'vitest';
import { FakeMemoryProposalRepository, FakeSkillRepository, FakeToolRepository, FakeWikiRepository } from './memory-repositories.fixtures';
import { MemoryDomainError, MemoryProposalNotFoundError } from '../../domain/memory/errors';
import { createMemoryProposal, decideProposal, type MemoryProposalTarget } from '../../domain/memory/memory-proposal';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { createSkill } from '../../domain/skill/skill';
import { SemVer } from '../../domain/tool/semver';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveWikiPageUseCase } from './save-wiki-page';
import { ReviewProposalUseCase } from './review-proposal';

const scope = { tenantId: 'local', workspaceId: 'default' };

function make() {
  const proposals = new FakeMemoryProposalRepository();
  const wiki = new FakeWikiRepository();
  const skills = new FakeSkillRepository();
  const tools = new FakeToolRepository();
  const saveWiki = new SaveWikiPageUseCase(wiki, () => 'auto', () => new Date('2026-07-08T00:00:00.000Z'));
  const saveSkill = new SaveSkillUseCase(skills, tools);
  const review = new ReviewProposalUseCase(proposals, saveWiki, skills, saveSkill);
  return { proposals, wiki, skills, review };
}

async function seed(proposals: FakeMemoryProposalRepository, id: string, target: MemoryProposalTarget) {
  const proposal = createMemoryProposal({ id, tenant: scope, target, summary: `s-${id}`, sourceRun: 'run-1', createdAt: '2026-07-08T00:00:00.000Z' });
  await proposals.save(proposal);
  return proposal;
}

describe('ReviewProposalUseCase', () => {
  it('approve(wiki 新規) は Wiki ページを作成し提案を approved にする', async () => {
    const { proposals, wiki, review } = make();
    await seed(proposals, 'm1', { kind: 'wiki', pageId: 'p1', isNewPage: true, title: 'T', tags: ['a'], body: 'B' });
    const result = await review.approve(scope, 'm1');
    expect(result.state).toBe('approved');
    const page = await wiki.find(scope, 'p1');
    expect(page?.title).toBe('T');
    expect(page?.sourceRuns).toEqual(['run-1']);
    expect((await proposals.find(scope, 'm1'))?.state).toBe('approved');
  });

  it('approve(wiki 改訂) は既存ページを version+1 する', async () => {
    const { proposals, wiki, review } = make();
    await wiki.save(createWikiPage({ id: 'p1', tenant: scope, title: 'Old', tags: [], body: 'old', updatedAt: 't' }));
    await seed(proposals, 'm1', { kind: 'wiki', pageId: 'p1', isNewPage: false, title: 'New', tags: [], body: 'new body' });
    await review.approve(scope, 'm1');
    const page = await wiki.find(scope, 'p1');
    expect(page?.version).toBe(2);
    expect(page?.body).toBe('new body');
  });

  it('approve(skill) は現行 Skill を流用し新 minor バージョンを蒸留保存する', async () => {
    const { proposals, skills, review } = make();
    await skills.save(createSkill({
      metadata: { internalId: 'analysis', workingName: 'w', displayName: 'Analysis', publishName: 'analysis', version: SemVer.of(1, 0, 0), owner: 'o', state: 'draft', tenant: scope },
      responsibility: 'r', activationCondition: 'a', inputDescription: 'i', outputDescription: 'o', instructions: 'old steps', tools: [],
    }));
    await seed(proposals, 'm1', { kind: 'skill', skillId: 'analysis', instructions: 'distilled steps' });
    await review.approve(scope, 'm1');
    const latest = await skills.findLatest(scope, 'analysis');
    expect(latest?.metadata.version.toString()).toBe('1.1.0');
    expect(latest?.instructions).toBe('distilled steps');
  });

  it('reject は状態のみ変更し実体を作らない', async () => {
    const { proposals, wiki, review } = make();
    await seed(proposals, 'm1', { kind: 'wiki', pageId: 'p1', isNewPage: true, title: 'T', tags: [], body: 'B' });
    const result = await review.reject(scope, 'm1');
    expect(result.state).toBe('rejected');
    expect(await wiki.find(scope, 'p1')).toBeNull();
  });

  it('決定済みの approve は MemoryDomainError', async () => {
    const { proposals, review } = make();
    const p = await seed(proposals, 'm1', { kind: 'wiki', pageId: 'p1', isNewPage: true, title: 'T', tags: [], body: 'B' });
    await proposals.save(decideProposal(p, 'rejected'));
    await expect(review.approve(scope, 'm1')).rejects.toBeInstanceOf(MemoryDomainError);
  });

  it('approve(skill) で対象 Skill が無ければ MemoryDomainError', async () => {
    const { proposals, review } = make();
    await seed(proposals, 'm1', { kind: 'skill', skillId: 'ghost', instructions: 'x' });
    await expect(review.approve(scope, 'm1')).rejects.toBeInstanceOf(MemoryDomainError);
  });

  it('未存在の提案は MemoryProposalNotFoundError', async () => {
    const { review } = make();
    await expect(review.approve(scope, 'nope')).rejects.toBeInstanceOf(MemoryProposalNotFoundError);
    await expect(review.reject(scope, 'nope')).rejects.toBeInstanceOf(MemoryProposalNotFoundError);
  });
});
