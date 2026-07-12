/**
 * application層: 記憶提案のレビュー（v21 実装契約 §3 / ADR-0016 M2・M3）
 *
 * approve は draft のみ。承認時に target を実体へ適用してから状態を approved にする:
 *  - wiki  → SaveWikiPage（新規 or 改訂）
 *  - skill → 現行 Skill を流用し instructions だけ差し替えた新 minor バージョンを保存（蒸留）
 * reject は状態遷移のみ（実体は変更しない）。
 */
import type { TenantScope } from '../../domain/tool/ids';
import { MemoryDomainError, MemoryProposalNotFoundError } from '../../domain/memory/errors';
import { decideProposal, type MemoryProposal } from '../../domain/memory/memory-proposal';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { SaveWikiPageUseCase } from './save-wiki-page';
import type { SaveSkillUseCase } from '../skill/save-skill';

export class ReviewProposalUseCase {
  constructor(
    private readonly proposals: MemoryProposalRepository,
    private readonly saveWikiPage: SaveWikiPageUseCase,
    private readonly skills: SkillRepository,
    private readonly saveSkill: SaveSkillUseCase,
  ) {}

  async approve(scope: TenantScope, id: string): Promise<MemoryProposal> {
    const proposal = await this.load(scope, id);
    if (proposal.state !== 'draft') throw new MemoryDomainError(`ReviewProposal: cannot approve a proposal already ${proposal.state}: ${id}`);
    await this.apply(scope, proposal);
    const approved = decideProposal(proposal, 'approved');
    await this.proposals.save(approved);
    return approved;
  }

  async reject(scope: TenantScope, id: string): Promise<MemoryProposal> {
    const proposal = await this.load(scope, id);
    const rejected = decideProposal(proposal, 'rejected');
    await this.proposals.save(rejected);
    return rejected;
  }

  private async apply(scope: TenantScope, proposal: MemoryProposal): Promise<void> {
    const target = proposal.target;
    if (target.kind === 'wiki') {
      await this.saveWikiPage.execute({
        scope,
        id: target.pageId,
        ...(target.wikiId !== undefined ? { wikiId: target.wikiId } : {}),
        title: target.title,
        tags: target.tags,
        body: target.body,
        ...(proposal.sourceRun !== undefined ? { sourceRunId: proposal.sourceRun } : {}),
      });
      return;
    }
    const skill = await this.skills.findLatest(scope, target.skillId);
    if (skill === null) throw new MemoryDomainError(`ReviewProposal: target skill not found: ${target.skillId}`);
    await this.saveSkill.execute({
      scope,
      internalId: skill.metadata.internalId,
      workingName: skill.metadata.workingName,
      displayName: skill.metadata.displayName,
      publishName: skill.metadata.publishName,
      owner: skill.metadata.owner,
      responsibility: skill.responsibility,
      activationCondition: skill.activationCondition,
      inputDescription: skill.inputDescription,
      outputDescription: skill.outputDescription,
      instructions: target.instructions,
      tools: skill.tools.map((tool) => ({ internalId: tool.internalId, version: tool.version })),
      bump: 'minor',
      state: skill.metadata.state,
    });
  }

  private async load(scope: TenantScope, id: string): Promise<MemoryProposal> {
    const proposal = await this.proposals.find(scope, id);
    if (proposal === null) throw new MemoryProposalNotFoundError(`ReviewProposal: proposal not found: ${id}`);
    return proposal;
  }
}
