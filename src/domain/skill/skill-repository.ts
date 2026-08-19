import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { SkillId } from './ids';
import type { Skill } from './skill';
export interface SkillSummary { readonly internalId: SkillId; readonly displayName: string; readonly publishName: string; readonly latestVersion: SemVer; readonly state: PublishState }
export interface SkillRepository {
  save(skill: Skill): Promise<void>;
  findVersion(scope: TenantScope, internalId: SkillId, version: SemVer): Promise<Skill | null>;
  findLatest(scope: TenantScope, internalId: SkillId): Promise<Skill | null>;
  listVersions(scope: TenantScope, internalId: SkillId): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<SkillSummary[]>;
  /**
   * 論理削除。list/findLatestからは除外し、listVersionsは空配列を返す。
   * findVersionは削除後も既存versionを返し続ける（既存の参照Agentを壊さないため）。
   * 戻り値は削除前に存在したか（既に削除済み/未存在なら false）。
   */
  delete(scope: TenantScope, internalId: SkillId): Promise<boolean>;
}
