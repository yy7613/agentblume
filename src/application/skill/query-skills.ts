import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository, SkillSummary } from '../../domain/skill/skill-repository';
import { SkillNotFoundError } from '../../domain/skill/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
export class QuerySkillsUseCase {
  constructor(private readonly repo: SkillRepository) {}
  list(scope: TenantScope): Promise<SkillSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: string, version?: SemVer): Promise<Skill> {
    const skill = version === undefined ? await this.repo.findLatest(scope, internalId) : await this.repo.findVersion(scope, internalId, version);
    if (skill === null) throw new SkillNotFoundError(`Skill not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return skill;
  }
}
