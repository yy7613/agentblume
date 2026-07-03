import { createSkill, type Skill } from '../../domain/skill/skill';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { SkillValidationError } from '../../domain/skill/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';

export interface SaveSkillInput {
  readonly scope: TenantScope; readonly internalId: string; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly owner: string; readonly responsibility: string; readonly activationCondition: string;
  readonly inputDescription: string; readonly outputDescription: string;
  readonly instructions: string;
  readonly tools: readonly { readonly internalId: string; readonly version: SemVer }[];
  readonly bump?: 'major' | 'minor' | 'patch'; readonly state?: PublishState;
}
export class SaveSkillUseCase {
  constructor(private readonly skills: SkillRepository, private readonly tools: ToolRepository) {}
  async execute(input: SaveSkillInput): Promise<Skill> {
    for (const ref of input.tools) if (await this.tools.findVersion(input.scope, ref.internalId, ref.version) === null) throw new SkillValidationError(`SaveSkill: referenced tool not found: ${ref.internalId}@${ref.version.toString()}`);
    const versions = await this.skills.listVersions(input.scope, input.internalId);
    const version = versions.length === 0 ? SemVer.of(1, 0, 0) : versions.reduce((max, item) => item.compare(max) > 0 ? item : max).bump(input.bump ?? 'patch');
    const skill = createSkill({ metadata: { internalId: input.internalId, workingName: input.workingName, displayName: input.displayName, publishName: input.publishName, version, owner: input.owner, state: input.state ?? 'draft', tenant: input.scope }, responsibility: input.responsibility, activationCondition: input.activationCondition, inputDescription: input.inputDescription, outputDescription: input.outputDescription, instructions: input.instructions, tools: input.tools });
    await this.skills.save(skill); return skill;
  }
}
