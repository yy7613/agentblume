import type { Experiment, ExperimentCaseResult, ExperimentStatus } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { ExperimentNotFoundError } from '../../domain/evaluation/errors';
import type { ExperimentId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/tool/ids';

export class QueryExperimentsUseCase {
  constructor(private readonly repo: ExperimentRepository) {}
  list(scope: TenantScope, status?: ExperimentStatus): Promise<Experiment[]> { return this.repo.list(scope, status === undefined ? undefined : { status }); }
  async results(scope: TenantScope, experimentId: ExperimentId): Promise<ExperimentCaseResult[]> { await this.get(scope, experimentId); return this.repo.listCaseResults(scope, experimentId); }
  async get(scope: TenantScope, id: ExperimentId): Promise<Experiment> { const value = await this.repo.find(scope, id); if (value === null) throw new ExperimentNotFoundError(`Experiment not found: ${id}`); return value; }
}
