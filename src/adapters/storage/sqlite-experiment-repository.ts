import { DatabaseSync } from 'node:sqlite';
import { deserializeExperiment, deserializeExperimentCaseResult, serializeExperiment, serializeExperimentCaseResult } from '../../domain/evaluation/experiment-serialization';
import type { ExperimentFilter, ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { interruptExperiment, type Experiment, type ExperimentCaseResult } from '../../domain/evaluation/experiment';
import { ExperimentConflictError, ExperimentNotFoundError } from '../../domain/evaluation/errors';
import type { TenantScope } from '../../domain/tool/ids';

const TABLES = `
CREATE TABLE IF NOT EXISTS experiments (tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, experiment_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (tenant_id, workspace_id, experiment_id));
CREATE INDEX IF NOT EXISTS idx_experiments_scope_created ON experiments (tenant_id, workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS experiment_case_results (tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, experiment_id TEXT NOT NULL, case_id TEXT NOT NULL, repetition INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (tenant_id, workspace_id, experiment_id, case_id, repetition));
`;
const experimentFromJson = (value: unknown): Experiment => deserializeExperiment(JSON.parse(String(value)));
const resultFromJson = (value: unknown): ExperimentCaseResult => deserializeExperimentCaseResult(JSON.parse(String(value)));

export class SqliteExperimentRepository implements ExperimentRepository {
  private readonly db: DatabaseSync;
  constructor(path = ':memory:') { this.db = new DatabaseSync(path); this.db.exec(TABLES); }
  close(): void { this.db.close(); }
  async create(experiment: Experiment): Promise<void> { try { this.db.prepare(`INSERT INTO experiments (tenant_id, workspace_id, experiment_id, status, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?)`).run(experiment.scope.tenantId, experiment.scope.workspaceId, experiment.id, experiment.status, experiment.createdAt, JSON.stringify(serializeExperiment(experiment))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new ExperimentConflictError(`Experiment already exists: ${experiment.id}`); throw error; } }
  async update(experiment: Experiment): Promise<void> { const result = this.db.prepare(`UPDATE experiments SET status=?, record_json=? WHERE tenant_id=? AND workspace_id=? AND experiment_id=?`).run(experiment.status, JSON.stringify(serializeExperiment(experiment)), experiment.scope.tenantId, experiment.scope.workspaceId, experiment.id); if (Number(result.changes) === 0) throw new ExperimentNotFoundError(`Experiment not found: ${experiment.id}`); }
  async find(scope: TenantScope, id: string): Promise<Experiment | null> { const row = this.db.prepare(`SELECT record_json FROM experiments WHERE tenant_id=? AND workspace_id=? AND experiment_id=?`).get(scope.tenantId, scope.workspaceId, id); return row === undefined ? null : experimentFromJson(row['record_json']); }
  async list(scope: TenantScope, filter?: ExperimentFilter): Promise<Experiment[]> { const rows = filter?.status === undefined ? this.db.prepare(`SELECT record_json FROM experiments WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId) : this.db.prepare(`SELECT record_json FROM experiments WHERE tenant_id=? AND workspace_id=? AND status=? ORDER BY created_at DESC`).all(scope.tenantId, scope.workspaceId, filter.status); return rows.map((row) => experimentFromJson(row['record_json'])); }
  async saveCaseResult(result: ExperimentCaseResult): Promise<void> { try { this.db.prepare(`INSERT INTO experiment_case_results (tenant_id, workspace_id, experiment_id, case_id, repetition, record_json) VALUES (?, ?, ?, ?, ?, ?)`).run(result.scope.tenantId, result.scope.workspaceId, result.experimentId, result.caseId, result.repetition, JSON.stringify(serializeExperimentCaseResult(result))); } catch (error) { if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new ExperimentConflictError(`Experiment case result already exists: ${result.experimentId}/${result.caseId}/${result.repetition}`); throw error; } }
  async listCaseResults(scope: TenantScope, experimentId: string): Promise<ExperimentCaseResult[]> { return this.db.prepare(`SELECT record_json FROM experiment_case_results WHERE tenant_id=? AND workspace_id=? AND experiment_id=? ORDER BY repetition,case_id`).all(scope.tenantId, scope.workspaceId, experimentId).map((row) => resultFromJson(row['record_json'])); }
  interruptRunning(finishedAt: string): number { const rows = this.db.prepare(`SELECT record_json FROM experiments WHERE status='running'`).all(); let count = 0; const update = this.db.prepare(`UPDATE experiments SET status=?, record_json=? WHERE tenant_id=? AND workspace_id=? AND experiment_id=?`); for (const row of rows) { const interrupted = interruptExperiment(experimentFromJson(row['record_json']), finishedAt); update.run(interrupted.status, JSON.stringify(serializeExperiment(interrupted)), interrupted.scope.tenantId, interrupted.scope.workspaceId, interrupted.id); count += 1; } return count; }
}
