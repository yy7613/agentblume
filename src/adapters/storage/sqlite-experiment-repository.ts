import { SqliteRepositoryBase, type SqliteDatabaseSource } from './sqlite-database';
import { deserializeExperiment, deserializeExperimentCaseResult, serializeExperiment, serializeExperimentCaseResult } from '../../domain/evaluation/experiment-serialization';
import type { ExperimentFilter, ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import type { Experiment, ExperimentCaseResult, ExperimentStatus } from '../../domain/evaluation/experiment';
import { ExperimentConflictError, ExperimentNotFoundError } from '../../domain/evaluation/errors';
import type { TenantScope } from '../../domain/tool/ids';

const experimentFromJson = (value: unknown): Experiment => deserializeExperiment(JSON.parse(String(value)));
const resultFromJson = (value: unknown): ExperimentCaseResult => deserializeExperimentCaseResult(JSON.parse(String(value)));

export class SqliteExperimentRepository extends SqliteRepositoryBase implements ExperimentRepository {
  constructor(source: SqliteDatabaseSource = ':memory:') {
    super(source);
  }
  async create(experiment: Experiment): Promise<void> { try { this.db.prepare(`INSERT INTO experiments (tenant_id, workspace_id, experiment_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)`).run(experiment.scope.tenantId, experiment.scope.workspaceId, experiment.id, experiment.status, experiment.createdAt, JSON.stringify(serializeExperiment(experiment))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new ExperimentConflictError(`Experiment already exists: ${experiment.id}`); throw error; } }
  async update(experiment: Experiment): Promise<void> { const result = this.db.prepare(`UPDATE experiments SET status=?, record_json=? WHERE tenant_id=? AND workspace_id=? AND experiment_id=?`).run(experiment.status, JSON.stringify(serializeExperiment(experiment)), experiment.scope.tenantId, experiment.scope.workspaceId, experiment.id); if (Number(result.changes) === 0) throw new ExperimentNotFoundError(`Experiment not found: ${experiment.id}`); }
  async find(scope: TenantScope, id: string): Promise<Experiment | null> { const row = this.db.prepare(`SELECT record_json FROM experiments WHERE tenant_id=? AND workspace_id=? AND experiment_id=?`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : experimentFromJson(row['record_json']); }
  async list(scope: TenantScope, filter?: ExperimentFilter): Promise<Experiment[]> { const rows = filter?.status === undefined ? this.db.prepare(`SELECT record_json FROM experiments WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId) : this.db.prepare(`SELECT record_json FROM experiments WHERE tenant_id=? AND workspace_id=? AND status=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId, filter.status); return rows.map((row) => experimentFromJson(row['record_json'])); }
  async saveCaseResult(result: ExperimentCaseResult): Promise<void> { try { this.db.prepare(`INSERT INTO experiment_case_results (tenant_id, workspace_id, experiment_id, case_id, repetition, record_json) VALUES (?, ?, ?, ?, ?, ?)`).run(result.scope.tenantId, result.scope.workspaceId, result.experimentId, result.caseId, result.repetition, JSON.stringify(serializeExperimentCaseResult(result))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new ExperimentConflictError(`Experiment case result already exists: ${result.experimentId}/${result.caseId}/${result.repetition}`); throw error; } }
  async listCaseResults(scope: TenantScope, experimentId: string): Promise<ExperimentCaseResult[]> { return this.db.prepare(`SELECT record_json FROM experiment_case_results WHERE tenant_id=? AND workspace_id=? AND experiment_id=? ORDER BY repetition,case_id`).all(scope.tenantId, scope.workspaceId, experimentId).map((row) => resultFromJson(row['record_json'])); }
  async listAllByStatus(status: ExperimentStatus): Promise<Experiment[]> { return this.db.prepare(`SELECT record_json FROM experiments WHERE status=? ORDER BY created_at ASC`).all(status).map((row) => experimentFromJson(row['record_json'])); }
}
