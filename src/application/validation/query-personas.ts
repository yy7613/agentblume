import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';
import { PersonaNotFoundError } from '../../domain/validation/errors';
import type { PersonaId } from '../../domain/validation/ids';
import type { Persona } from '../../domain/validation/persona';
import type { PersonaRepository, PersonaSummary } from '../../domain/validation/persona-repository';

export class QueryPersonasUseCase {
  constructor(private readonly repo: PersonaRepository) {}

  list(scope: TenantScope): Promise<PersonaSummary[]> { return this.repo.list(scope); }

  versions(scope: TenantScope, internalId: PersonaId): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }

  async get(scope: TenantScope, internalId: PersonaId, version?: SemVer): Promise<Persona> {
    const persona = version === undefined
      ? await this.repo.findLatest(scope, internalId)
      : await this.repo.findVersion(scope, internalId, version);
    if (persona === null) {
      throw new PersonaNotFoundError(`Persona not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    }
    return persona;
  }
}

/**
 * 保存済みPersonaの論理削除。repository.delete が false(未存在/削除済み)なら PersonaNotFoundError。
 * findVersion は削除後も返るため、既存の参照Scenarioは壊れない。
 */
export class DeletePersonaUseCase {
  constructor(private readonly repo: PersonaRepository) {}
  async execute(scope: TenantScope, internalId: PersonaId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new PersonaNotFoundError(`DeletePersona: persona not found: ${internalId}`);
  }
}
