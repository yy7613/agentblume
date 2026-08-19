import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';
import { ScenarioNotFoundError } from '../../domain/validation/errors';
import type { ScenarioId } from '../../domain/validation/ids';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository, ScenarioSummary } from '../../domain/validation/scenario-repository';

export class QueryScenariosUseCase {
  constructor(private readonly repo: ScenarioRepository) {}

  list(scope: TenantScope): Promise<ScenarioSummary[]> { return this.repo.list(scope); }

  versions(scope: TenantScope, internalId: ScenarioId): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }

  async get(scope: TenantScope, internalId: ScenarioId, version?: SemVer): Promise<Scenario> {
    const scenario = version === undefined
      ? await this.repo.findLatest(scope, internalId)
      : await this.repo.findVersion(scope, internalId, version);
    if (scenario === null) {
      throw new ScenarioNotFoundError(`Scenario not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    }
    return scenario;
  }
}

/**
 * 保存済みScenarioの論理削除。repository.delete が false(未存在/削除済み)なら ScenarioNotFoundError。
 * findVersion は削除後も返るため、既存の参照ScenarioRunは壊れない。
 */
export class DeleteScenarioUseCase {
  constructor(private readonly repo: ScenarioRepository) {}
  async execute(scope: TenantScope, internalId: ScenarioId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new ScenarioNotFoundError(`DeleteScenario: scenario not found: ${internalId}`);
  }
}
