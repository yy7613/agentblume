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
}
