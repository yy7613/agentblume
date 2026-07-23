import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { Persona, PersonaArchetype } from './persona';

export interface PersonaSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly archetype: PersonaArchetype;
  readonly state: PublishState;
}

export interface PersonaRepository {
  save(persona: Persona): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<Persona | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<Persona | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<PersonaSummary[]>;
  /**
   * 論理削除。list/findLatestからは除外し、listVersionsは空配列を返す。
   * findVersionは削除後も既存versionを返し続ける（既存の参照Scenarioを壊さないため）。
   * 戻り値は削除前に存在したか（既に削除済み/未存在なら false）。
   */
  delete(scope: TenantScope, internalId: string): Promise<boolean>;
}
