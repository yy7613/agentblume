import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { Skill } from './skill';
export interface SkillSummary { readonly internalId: string; readonly displayName: string; readonly publishName: string; readonly latestVersion: SemVer; readonly state: PublishState }
export interface SkillRepository {
  save(skill: Skill): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<Skill | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<Skill | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<SkillSummary[]>;
}
