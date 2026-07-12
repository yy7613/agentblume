import { randomUUID } from 'node:crypto';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { createExperiment, type Experiment, type ExperimentModelSnapshot } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { EvaluationDomainError } from '../../domain/evaluation/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { ExperimentWorkerPort } from './experiment-worker';

export interface CreateExperimentInput {
  readonly scope: TenantScope;
  readonly target: { readonly agentId: string; readonly version: SemVer };
  readonly dataset: { readonly id: string; readonly version: SemVer };
  readonly evaluatorProfile: { readonly id: string; readonly version: SemVer };
  readonly repetitions?: number;
}

export class CreateExperimentUseCase {
  constructor(
    private readonly experiments: ExperimentRepository,
    private readonly datasets: EvaluationDatasetRepository,
    private readonly profiles: EvaluatorProfileRepository,
    private readonly agents: AgentRepository,
    private readonly worker: ExperimentWorkerPort,
    private readonly snapshot: () => ExperimentModelSnapshot,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: CreateExperimentInput): Promise<Experiment> {
    const dataset = await this.datasets.findVersion(input.scope, input.dataset.id, input.dataset.version);
    if (dataset === null) throw new EvaluationDomainError(`CreateExperiment: dataset not found: ${input.dataset.id}@${input.dataset.version.toString()}`);
    if (await this.profiles.findVersion(input.scope, input.evaluatorProfile.id, input.evaluatorProfile.version) === null) throw new EvaluationDomainError(`CreateExperiment: evaluator profile not found: ${input.evaluatorProfile.id}@${input.evaluatorProfile.version.toString()}`);
    const agent = await this.agents.findVersion(input.scope, input.target.agentId, input.target.version);
    if (agent === null) throw new EvaluationDomainError(`CreateExperiment: target agent not found: ${input.target.agentId}@${input.target.version.toString()}`);
    if (agent.kind === 'pseudo-user') throw new EvaluationDomainError('CreateExperiment: pseudo-user agent cannot be an experiment target');
    const repetitions = input.repetitions ?? 1;
    const experiment = createExperiment({
      id: this.makeId(), scope: input.scope, target: input.target, dataset: input.dataset, evaluatorProfile: input.evaluatorProfile,
      repetitions, status: 'queued', snapshot: this.snapshot(), progress: { completed: 0, total: dataset.cases.length * repetitions }, createdAt: this.now().toISOString(),
    });
    await this.experiments.create(experiment);
    this.worker.enqueue(input.scope, experiment.id);
    return experiment;
  }
}
