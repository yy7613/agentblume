import { deserializeExperiment, deserializeExperimentCaseResult, serializeExperiment, serializeExperimentCaseResult, type SerializedExperiment, type SerializedExperimentCaseResult } from '../../domain/evaluation/experiment-serialization';
import type { ExperimentFilter, ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { interruptExperiment, type Experiment, type ExperimentCaseResult } from '../../domain/evaluation/experiment';
import { ExperimentConflictError, ExperimentNotFoundError } from '../../domain/evaluation/errors';
import { tenantKey, type TenantScope } from '../../domain/tool/ids';

const experimentKey = (scope: TenantScope, id: string): string => `${tenantKey(scope)} ${id}`;
const resultKey = (result: ExperimentCaseResult): string => `${experimentKey(result.scope, result.experimentId)} ${result.caseId} ${result.repetition}`;

export class InMemoryExperimentRepository implements ExperimentRepository {
  private readonly experiments = new Map<string, SerializedExperiment>();
  private readonly results = new Map<string, SerializedExperimentCaseResult>();

  async create(experiment: Experiment): Promise<void> { const key = experimentKey(experiment.scope, experiment.id); if (this.experiments.has(key)) throw new ExperimentConflictError(`Experiment already exists: ${experiment.id}`); this.experiments.set(key, serializeExperiment(experiment)); }
  async update(experiment: Experiment): Promise<void> { const key = experimentKey(experiment.scope, experiment.id); if (!this.experiments.has(key)) throw new ExperimentNotFoundError(`Experiment not found: ${experiment.id}`); this.experiments.set(key, serializeExperiment(experiment)); }
  async find(scope: TenantScope, id: string): Promise<Experiment | null> { const value = this.experiments.get(experimentKey(scope, id)); return value === undefined ? null : deserializeExperiment(value); }
  async list(scope: TenantScope, filter?: ExperimentFilter): Promise<Experiment[]> { return [...this.experiments.values()].filter((value) => tenantKey(value.scope) === tenantKey(scope) && (filter?.status === undefined || value.status === filter.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(deserializeExperiment); }
  async saveCaseResult(result: ExperimentCaseResult): Promise<void> { const key = resultKey(result); if (this.results.has(key)) throw new ExperimentConflictError(`Experiment case result already exists: ${result.experimentId}/${result.caseId}/${result.repetition}`); this.results.set(key, serializeExperimentCaseResult(result)); }
  async listCaseResults(scope: TenantScope, experimentId: string): Promise<ExperimentCaseResult[]> { return [...this.results.values()].filter((value) => tenantKey(value.scope) === tenantKey(scope) && value.experimentId === experimentId).sort((a, b) => a.repetition - b.repetition || a.caseId.localeCompare(b.caseId)).map(deserializeExperimentCaseResult); }
  interruptRunning(finishedAt: string): number { let count = 0; for (const [key, value] of this.experiments) { const experiment = deserializeExperiment(value); if (experiment.status !== 'running') continue; this.experiments.set(key, serializeExperiment(interruptExperiment(experiment, finishedAt))); count += 1; } return count; }
}
