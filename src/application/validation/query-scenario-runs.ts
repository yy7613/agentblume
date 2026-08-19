import type { TenantScope } from '../../domain/tool/ids';
import { ScenarioRunNotFoundError } from '../../domain/validation/errors';
import type { ScenarioRunId } from '../../domain/validation/ids';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import type { ScenarioRunFilter, ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';

export class QueryScenarioRunsUseCase {
  constructor(private readonly repo: ScenarioRunRepository) {}

  list(scope: TenantScope, filter?: ScenarioRunFilter): Promise<ScenarioRun[]> { return this.repo.list(scope, filter); }

  async get(scope: TenantScope, id: ScenarioRunId): Promise<ScenarioRun> {
    const run = await this.repo.find(scope, id);
    if (run === null) throw new ScenarioRunNotFoundError(`ScenarioRun not found: ${id}`);
    return run;
  }
}
