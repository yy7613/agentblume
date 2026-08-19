import type { SkillId } from '../../domain/skill/ids';
import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository, SkillSummary } from '../../domain/skill/skill-repository';
import { SkillNotFoundError } from '../../domain/skill/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
export class QuerySkillsUseCase {
  constructor(private readonly repo: SkillRepository) {}
  list(scope: TenantScope): Promise<SkillSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: SkillId): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: SkillId, version?: SemVer): Promise<Skill> {
    const skill = version === undefined ? await this.repo.findLatest(scope, internalId) : await this.repo.findVersion(scope, internalId, version);
    if (skill === null) throw new SkillNotFoundError(`Skill not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return skill;
  }
}

/**
 * 保存済みSkillの論理削除。repository.delete が false（未存在/削除済み）なら SkillNotFoundError。
 * findVersion は削除後も返るため、既存の参照Agentは壊れない。
 */
export class DeleteSkillUseCase {
  constructor(private readonly repo: SkillRepository) {}
  async execute(scope: TenantScope, internalId: SkillId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new SkillNotFoundError(`DeleteSkill: skill not found: ${internalId}`);
  }
}
