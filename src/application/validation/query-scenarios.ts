import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import { ScenarioNotFoundError } from '../../domain/validation/errors';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository, ScenarioSummary } from '../../domain/validation/scenario-repository';

export class QueryScenariosUseCase {
  constructor(private readonly repo: ScenarioRepository) {}

  list(scope: TenantScope): Promise<ScenarioSummary[]> { return this.repo.list(scope); }

  versions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }

  async get(scope: TenantScope, internalId: string, version?: SemVer): Promise<Scenario> {
    const scenario = version === undefined
      ? await this.repo.findLatest(scope, internalId)
      : await this.repo.findVersion(scope, internalId, version);
    if (scenario === null) {
      throw new ScenarioNotFoundError(`Scenario not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    }
    return scenario;
  }
}
