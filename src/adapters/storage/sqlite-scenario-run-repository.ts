import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { ValidationDomainError } from '../../domain/validation/errors';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import type { ScenarioRunFilter, ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';
import { deserializeScenarioRun, serializeScenarioRun } from '../../domain/validation/serialization';

const fromJson = (value: unknown): ScenarioRun => deserializeScenarioRun(JSON.parse(String(value)));

export class SqliteScenarioRunRepository extends SqliteRepositoryBase implements ScenarioRunRepository {

  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }


  async save(run: ScenarioRun): Promise<void> {
    try {
      this.db.prepare(`INSERT INTO scenario_runs (tenant_id, workspace_id, run_id, scenario_id, started_at, record_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(run.scope.tenantId, run.scope.workspaceId, run.id, run.scenario.id, run.startedAt, JSON.stringify(serializeScenarioRun(run)));
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ValidationDomainError(`ScenarioRun already exists: ${run.id}`);
      }
      throw error;
    }
  }

  async find(scope: TenantScope, id: string): Promise<ScenarioRun | null> {
    const row = this.db.prepare(`SELECT record_json FROM scenario_runs WHERE tenant_id=? AND workspace_id=? AND run_id=?`).get(scope.tenantId, scope.workspaceId, id);
    return row === undefined ? null : fromJson(row['record_json']);
  }

  async list(scope: TenantScope, filter?: ScenarioRunFilter): Promise<ScenarioRun[]> {
    const rows = filter?.scenarioId === undefined
      ? this.db.prepare(`SELECT record_json FROM scenario_runs WHERE tenant_id=? AND workspace_id=? ORDER BY started_at DESC`).all(scope.tenantId, scope.workspaceId)
      : this.db.prepare(`SELECT record_json FROM scenario_runs WHERE tenant_id=? AND workspace_id=? AND scenario_id=? ORDER BY started_at DESC`).all(scope.tenantId, scope.workspaceId, filter.scenarioId);
    return rows.map((row) => fromJson(row['record_json']));
  }
}
