import { randomUUID } from 'node:crypto';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { AgentId } from '../../domain/agent/ids';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository, JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import type { EvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import type { EvaluatorProfile, JudgeEvaluatorMetricDefinition } from '../../domain/evaluation/evaluator-profile';
import { createExperiment, type Experiment, type ExperimentModelSnapshot } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { EvaluationDomainError, JudgeModelNotConfiguredError, JudgeRubricNotFoundError, JudgeTraceUnavailableError } from '../../domain/evaluation/errors';
import type { DatasetId, EvaluatorProfileId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';
import { logSwallowed, type LoggerPort } from '../operations/logger';
import type { ExperimentWorkerPort } from './experiment-worker';
import type { JudgeReadiness } from './judge-readiness';

export interface CreateExperimentInput {
  readonly scope: TenantScope;
  readonly target: { readonly agentId: AgentId; readonly version: SemVer };
  readonly dataset: { readonly id: DatasetId; readonly version: SemVer };
  readonly evaluatorProfile: { readonly id: EvaluatorProfileId; readonly version: SemVer };
  readonly repetitions?: number;
  /** 事例ごとの判定サンプル数（1〜5、既定 1）。 */
  readonly judgeSamples?: number;
}

/**
 * judge 指標つきの実験を「走らせても必ず失敗する」状態で起票しないための任意配線。
 * どちらも省略可（省略時はガードしない）なので、既存の呼び出し元はそのまま動く。
 */
export interface CreateExperimentJudgeGuards {
  /** 起票時点の judge 設定状態。解決に失敗したら設定済み扱いにして起票は止めない（原因は logger へ）。 */
  readonly judgeReadiness?: () => Promise<JudgeReadiness>;
  /** 指標が参照するルーブリックを読み、`tracePolicy` と事例種別の矛盾を起票時に見つける。 */
  readonly rubrics?: JudgeRubricRepository;
  readonly logger?: LoggerPort;
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
    private readonly guards: CreateExperimentJudgeGuards = {},
  ) {}

  async execute(input: CreateExperimentInput): Promise<Experiment> {
    const dataset = await this.datasets.findVersion(input.scope, input.dataset.id, input.dataset.version);
    if (dataset === null) throw new EvaluationDomainError(`CreateExperiment: dataset not found: ${input.dataset.id}@${input.dataset.version.toString()}`);
    const profile = await this.profiles.findVersion(input.scope, input.evaluatorProfile.id, input.evaluatorProfile.version);
    if (profile === null) throw new EvaluationDomainError(`CreateExperiment: evaluator profile not found: ${input.evaluatorProfile.id}@${input.evaluatorProfile.version.toString()}`);
    const agent = await this.agents.findVersion(input.scope, input.target.agentId, input.target.version);
    if (agent === null) throw new EvaluationDomainError(`CreateExperiment: target agent not found: ${input.target.agentId}@${input.target.version.toString()}`);
    if (agent.kind === 'pseudo-user') throw new EvaluationDomainError('CreateExperiment: pseudo-user agent cannot be an experiment target');
    await this.guardJudgeMetrics(input, dataset, profile);
    const repetitions = input.repetitions ?? 1;
    const experiment = createExperiment({
      id: this.makeId(), scope: input.scope, target: input.target, dataset: input.dataset, evaluatorProfile: input.evaluatorProfile,
      repetitions, ...(input.judgeSamples !== undefined ? { judgeSamples: input.judgeSamples } : {}), status: 'queued', snapshot: await this.resolveSnapshot(), progress: { completed: 0, total: dataset.cases.length * repetitions }, createdAt: this.now().toISOString(),
    });
    await this.experiments.create(experiment);
    this.worker.enqueue(input.scope, experiment.id);
    return experiment;
  }

  /**
   * judge 指標があるときだけ効くガード。「走らせれば必ず全事例が判定失敗になる」組み合わせを起票時に弾き、
   * 原因（judge 未設定 / tracePolicy と scenario 事例の矛盾）と直し方を利用者へ返す。
   * code 指標だけのプロファイルには一切関与しない。
   */
  private async guardJudgeMetrics(input: CreateExperimentInput, dataset: EvaluationDataset, profile: EvaluatorProfile): Promise<void> {
    const judgeMetrics = profile.metrics.filter((metric): metric is JudgeEvaluatorMetricDefinition => metric.kind === 'judge');
    if (judgeMetrics.length === 0) return;
    if (!(await this.judgeConfigured())) throw new JudgeModelNotConfiguredError(`CreateExperiment: evaluator profile '${input.evaluatorProfile.id}@${input.evaluatorProfile.version.toString()}' has judge metrics but no judge model is configured`);
    const rubrics = this.guards.rubrics;
    if (rubrics === undefined) return;
    const hasScenarioCase = dataset.cases.some((entry) => entry.kind === 'scenario');
    for (const metric of judgeMetrics) {
      const ref = { id: metric.rubric.id, version: metric.rubric.version.toString() };
      const rubric = await rubrics.findVersion(input.scope, metric.rubric.id, metric.rubric.version);
      if (rubric === null) throw new JudgeRubricNotFoundError(`CreateExperiment: judge rubric not found: ${ref.id}@${ref.version}`);
      if (rubric.tracePolicy === 'required' && hasScenarioCase) {
        throw new JudgeTraceUnavailableError(`CreateExperiment: judge rubric '${ref.id}@${ref.version}' requires a tool trace, but dataset '${input.dataset.id}@${input.dataset.version.toString()}' contains scenario cases which never produce one; set tracePolicy to 'optional'`, ref);
      }
    }
  }

  /** 判定器の解決が壊れていても起票は止めない（resolveSnapshot と同じ方針）。ただし無音にはしない。 */
  private async judgeConfigured(): Promise<boolean> {
    const resolve = this.guards.judgeReadiness;
    if (resolve === undefined) return true;
    try { return (await resolve()).configured; }
    catch (error) { logSwallowed(this.guards.logger, 'judge readiness could not be resolved; creating the experiment without the guard', error); return true; }
  }

  /** 指紋の解決失敗で起票を止めない（Run側と同じ方針）。壊れていることはレコードに残す。 */
  private async resolveSnapshot(): Promise<ExperimentModelSnapshot> {
    try { return await this.snapshot(); }
    catch { return UNRESOLVED_SNAPSHOT; }
  }
}
