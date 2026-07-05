import type { TenantScope } from '../tool/ids';
import type { ScenarioRun } from './scenario-run';

export interface ScenarioRunFilter {
  readonly scenarioId?: string;
}

export interface ScenarioRunRepository {
  /** 一意 id で保存する。重複 id → ValidationDomainError。 */
  save(run: ScenarioRun): Promise<void>;
  find(scope: TenantScope, id: string): Promise<ScenarioRun | null>;
  /** startedAt の新しい順。filter.scenarioId で対象シナリオを絞り込む。 */
  list(scope: TenantScope, filter?: ScenarioRunFilter): Promise<ScenarioRun[]>;
}
