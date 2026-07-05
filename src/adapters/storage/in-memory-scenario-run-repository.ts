import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { ValidationDomainError } from '../../domain/validation/errors';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import type { ScenarioRunFilter, ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';
import { deserializeScenarioRun, serializeScenarioRun, type SerializedScenarioRun } from '../../domain/validation/serialization';

const key = (scope: TenantScope, id: string) => `${tenantKey(scope)} ${id}`;

export class InMemoryScenarioRunRepository implements ScenarioRunRepository {
  private readonly store = new Map<string, SerializedScenarioRun>();

  async save(run: ScenarioRun): Promise<void> {
    const id = key(run.scope, run.id);
    if (this.store.has(id)) throw new ValidationDomainError(`ScenarioRun already exists: ${run.id}`);
    this.store.set(id, serializeScenarioRun(run));
  }

  async find(scope: TenantScope, id: string): Promise<ScenarioRun | null> {
    const value = this.store.get(key(scope, id));
    return value === undefined ? null : deserializeScenarioRun(value);
  }

  async list(scope: TenantScope, filter?: ScenarioRunFilter): Promise<ScenarioRun[]> {
    return [...this.store.values()]
      .filter((value) => tenantKey(value.scope) === tenantKey(scope) && (filter?.scenarioId === undefined || value.scenario.id === filter.scenarioId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(deserializeScenarioRun);
  }
}
