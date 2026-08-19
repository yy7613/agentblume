import { randomUUID } from 'node:crypto';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { AgentId } from '../../domain/agent/ids';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { createExperiment, type Experiment, type ExperimentModelSnapshot } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { EvaluationDomainError } from '../../domain/evaluation/errors';
import type { DatasetId, EvaluatorProfileId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';
import type { ExperimentWorkerPort } from './experiment-worker';

export interface CreateExperimentInput {
  readonly scope: TenantScope;
  readonly target: { readonly agentId: AgentId; readonly version: SemVer };
  readonly dataset: { readonly id: DatasetId; readonly version: SemVer };
  readonly evaluatorProfile: { readonly id: EvaluatorProfileId; readonly version: SemVer };
  readonly repetitions?: number;
}

/**
 * モデル設定を解決できなかったときに実験レコードへ残す指紋。
 *
 * 指紋は「どの設定で走ったか」を後から辿るための**観測情報**であり、起票の前提条件ではない。
 * Run 側は解決失敗を握って静的な指紋で実行を続けるため、起票だけが 409 で落ちるのは非対称だった。
 * 起票は通し、ただし「モデル設定が解決できていない」ことがレコードから読み取れるようにする。
 */
const UNRESOLVED_SNAPSHOT: ExperimentModelSnapshot = { provider: 'unresolved', model: 'unresolved', modelConfigHash: 'unresolved' };

export class CreateExperimentUseCase {
  constructor(
    private readonly experiments: ExperimentRepository,
    private readonly datasets: EvaluationDatasetRepository,
    private readonly profiles: EvaluatorProfileRepository,
    private readonly agents: AgentRepository,
    private readonly worker: ExperimentWorkerPort,
    /** 実行時点のモデル設定を返す（UIからの切替に追随できるよう Promise も許す）。 */
    private readonly snapshot: () => ExperimentModelSnapshot | Promise<ExperimentModelSnapshot>,
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
      repetitions, status: 'queued', snapshot: await this.resolveSnapshot(), progress: { completed: 0, total: dataset.cases.length * repetitions }, createdAt: this.now().toISOString(),
    });
    await this.experiments.create(experiment);
    this.worker.enqueue(input.scope, experiment.id);
    return experiment;
  }

  /** 指紋の解決失敗で起票を止めない（Run側と同じ方針）。壊れていることはレコードに残す。 */
  private async resolveSnapshot(): Promise<ExperimentModelSnapshot> {
    try { return await this.snapshot(); }
    catch { return UNRESOLVED_SNAPSHOT; }
  }
}
