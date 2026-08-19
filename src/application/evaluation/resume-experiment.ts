import { resumeExperiment, type Experiment } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { ExperimentNotFoundError } from '../../domain/evaluation/errors';
import type { ExperimentId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExperimentWorkerPort } from './experiment-worker';

export class ResumeExperimentUseCase {
  constructor(private readonly repo: ExperimentRepository, private readonly worker: ExperimentWorkerPort) {}
  async execute(scope: TenantScope, id: ExperimentId): Promise<Experiment> {
    const experiment = await this.repo.find(scope, id);
    if (experiment === null) throw new ExperimentNotFoundError(`Experiment not found: ${id}`);
    const queued = resumeExperiment(experiment);
    await this.repo.update(queued);
    this.worker.enqueue(scope, id);
    return queued;
  }
}
