import { cancelExperiment, type Experiment } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { ExperimentNotFoundError } from '../../domain/evaluation/errors';
import type { ExperimentId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ExperimentWorkerPort } from './experiment-worker';

export class CancelExperimentUseCase {
  constructor(private readonly repo: ExperimentRepository, private readonly worker: ExperimentWorkerPort, private readonly now: () => Date = () => new Date()) {}
  async execute(scope: TenantScope, id: ExperimentId): Promise<Experiment> {
    const experiment = await this.repo.find(scope, id);
    if (experiment === null) throw new ExperimentNotFoundError(`Experiment not found: ${id}`);
    const cancelled = cancelExperiment(experiment, this.now().toISOString());
    await this.repo.update(cancelled);
    this.worker.cancel(scope, id);
    return cancelled;
  }
}
