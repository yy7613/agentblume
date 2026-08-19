import type { AgentRepository } from '../../domain/agent/agent-repository';
import { RunFailedError } from '../agent/errors';
import type { RunAgentPreviewUseCase } from '../agent/run-agent-preview';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import type { RunScenarioUseCase } from '../validation/run-scenario';
import type { AgentEvaluatorPort } from './evaluator';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import type { JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { advanceExperiment, cancelExperiment, completeExperiment, createExperimentCaseResult, failExperiment, startExperiment, type Experiment, type ExperimentCaseResult } from '../../domain/evaluation/experiment';
import type { ExperimentRepository } from '../../domain/evaluation/experiment-repository';
import { ExperimentNotFoundError } from '../../domain/evaluation/errors';
import type { ExperimentId } from '../../domain/evaluation/ids';
import type { EvaluationCase, ScenarioEvaluationCase, TurnEvaluationCase } from '../../domain/evaluation/evaluation-dataset';
import type { EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { ScenarioRun } from '../../domain/validation/scenario-run';
import type { TenantScope } from '../../domain/tool/ids';
import type { JudgeEvaluatorPort } from './judge-evaluator';
import { JudgeEvaluationError } from '../../domain/evaluation/errors';
import type { ExperimentModelSnapshot, JudgeEvaluationRecord } from '../../domain/evaluation/experiment';
import type { TelemetryPort } from '../operations/telemetry';
import { safeStartSpan } from '../operations/telemetry';
import { logSwallowed, type LoggerPort } from '../operations/logger';

/**
 * judge スロットの配線。`resolveSnapshot` は「これから実際に使う設定」を**評価の前に**解決する。
 *
 * judge には main の `resolveModel` に相当する事前解決が無く、`evaluator.snapshot()` は
 * 「最後に解決したアダプタ」の同期値を返すだけだった。そのため UI で judge を切り替えた直後の
 * 失敗レコードには env 既定由来の誤った指紋（`{provider:'openai-compatible', model:''}`）が残る。
 * 事前解決を挟むと、失敗レコードの指紋も、`capabilities()` を見るガードも最新設定を見る。
 */
export interface JudgeSlotOptions {
  readonly rubrics: JudgeRubricRepository;
  readonly evaluator: JudgeEvaluatorPort;
  /** 実行時点の judge 設定を解決する。失敗しても評価は止めない（観測情報であり前提条件ではない）。 */
  readonly resolveSnapshot?: () => Promise<ExperimentModelSnapshot>;
}

/** judge 未配線のときに記録へ残す指紋。 */
const UNCONFIGURED_JUDGE: ExperimentModelSnapshot = { provider: 'unconfigured-judge', model: 'unconfigured-judge', modelConfigHash: 'unconfigured-judge' };

type Delay = (ms: number) => Promise<void>;
const defaultDelay: Delay = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorCode(error: unknown): string { return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'EXPERIMENT_CASE_FAILED'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Experiment case failed'; }
function causes(error: unknown): unknown[] { const values: unknown[] = []; let current: unknown = error; for (let depth = 0; depth < 5 && current !== undefined; depth += 1) { values.push(current); current = current instanceof Error && 'cause' in current ? current.cause : undefined; } return values; }
function retryable(error: unknown): boolean { return causes(error).some((item) => item instanceof Error && item.name === 'ModelProviderError' && /timeout|timed out|temporary|temporarily|ECONN|429|502|503|504/i.test(item.message)); }
function runIdFrom(error: unknown): string | undefined { return causes(error).find((item): item is RunFailedError => item instanceof RunFailedError)?.runId; }
export class RunExperimentUseCase {
  constructor(
    private readonly experiments: ExperimentRepository,
    private readonly datasets: EvaluationDatasetRepository,
    private readonly profiles: EvaluatorProfileRepository,
    private readonly agents: AgentRepository,
    private readonly scenarios: ScenarioRepository,
    private readonly runAgent: RunAgentPreviewUseCase,
    private readonly runScenario: RunScenarioUseCase,
    private readonly evaluator: AgentEvaluatorPort,
    private readonly now: () => Date = () => new Date(),
    private readonly delay: Delay = defaultDelay,
    private readonly judgeOptions?: JudgeSlotOptions,
    private readonly telemetry?: TelemetryPort,
    private readonly logger?: LoggerPort,
  ) {}

  async execute(scope: TenantScope, id: ExperimentId, signal?: AbortSignal): Promise<Experiment> {
    let experiment = await this.experiments.find(scope, id);
    if (experiment === null) throw new ExperimentNotFoundError(`Experiment not found: ${id}`);
    try {
      const dataset = await this.datasets.findVersion(scope, experiment.dataset.id, experiment.dataset.version);
      const profile = await this.profiles.findVersion(scope, experiment.evaluatorProfile.id, experiment.evaluatorProfile.version);
      if (dataset === null || profile === null || await this.agents.findVersion(scope, experiment.target.agentId, experiment.target.version) === null) throw new Error('Experiment fixed asset is no longer available');
      const existing = new Set((await this.experiments.listCaseResults(scope, id)).map((result) => `${result.caseId}:${result.repetition}`));
      experiment = startExperiment(experiment, this.now().toISOString()); await this.experiments.update(experiment);
      for (let repetition = 1; repetition <= experiment.repetitions; repetition += 1) {
        for (const entry of dataset.cases) {
          if (existing.has(`${entry.id}:${repetition}`)) continue;
          if (signal?.aborted === true) { experiment = cancelExperiment(experiment, this.now().toISOString()); await this.experiments.update(experiment); return experiment; }
          const result = await this.executeWithRetry(experiment, entry, repetition, profile, signal);
          await this.experiments.saveCaseResult(result);
          experiment = advanceExperiment(experiment); await this.experiments.update(experiment);
          if (result.status === 'cancelled' || Boolean(signal?.aborted)) { experiment = cancelExperiment(experiment, this.now().toISOString()); await this.experiments.update(experiment); return experiment; }
        }
      }
      experiment = completeExperiment(experiment, this.now().toISOString()); await this.experiments.update(experiment); return experiment;
    } catch (error) {
      if (experiment.status === 'running' || experiment.status === 'queued') { experiment = failExperiment(experiment, { code: errorCode(error), message: errorMessage(error) }, this.now().toISOString()); await this.experiments.update(experiment); }
      return experiment;
    }
  }

  private async executeWithRetry(experiment: Experiment, entry: EvaluationCase, repetition: number, profile: EvaluatorProfile, signal?: AbortSignal): Promise<ExperimentCaseResult> {
    const span = safeStartSpan(this.telemetry, 'evaluation.case', { 'experiment.id': experiment.id, 'evaluation.case_id': entry.id, 'evaluation.case_kind': entry.kind, 'evaluation.repetition': repetition }, this.logger); let failure: unknown;
    try { return await this.executeWithRetryInner(experiment, entry, repetition, profile, signal); }
    catch (error) { failure = error; throw error; }
    finally { span.end(failure); }
  }

  private async executeWithRetryInner(experiment: Experiment, entry: EvaluationCase, repetition: number, profile: EvaluatorProfile, signal?: AbortSignal): Promise<ExperimentCaseResult> {
    const started = this.now().getTime(); const failedRunIds: string[] = []; let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = entry.kind === 'turn' ? await this.runTurn(experiment, entry, repetition, profile, signal) : await this.runScenarioCase(experiment, entry, repetition, profile, signal);
        return createExperimentCaseResult({ ...result, runIds: [...failedRunIds, ...result.runIds], latencyMs: Math.max(0, this.now().getTime() - started) });
      } catch (error) {
        lastError = error; const runId = runIdFrom(error); if (runId !== undefined) failedRunIds.push(runId);
        if (signal?.aborted === true) return createExperimentCaseResult({ experimentId: experiment.id, scope: experiment.scope, caseId: entry.id, caseKind: entry.kind, repetition, status: 'cancelled', runIds: failedRunIds, scores: [], latencyMs: Math.max(0, this.now().getTime() - started), usage: {} });
        if (!retryable(error) || attempt === 2) break;
        await this.delay(50 * 2 ** attempt);
      }
    }
    return createExperimentCaseResult({ experimentId: experiment.id, scope: experiment.scope, caseId: entry.id, caseKind: entry.kind, repetition, status: 'failed', runIds: failedRunIds, scores: [], latencyMs: Math.max(0, this.now().getTime() - started), usage: {}, error: { code: errorCode(lastError), message: errorMessage(lastError), retryable: retryable(lastError) } });
  }

  private async runTurn(experiment: Experiment, entry: TurnEvaluationCase, repetition: number, profile: EvaluatorProfile, signal?: AbortSignal): Promise<Omit<ExperimentCaseResult, 'latencyMs'>> {
    const run = await this.runAgent.executeSaved({ scope: experiment.scope, agentId: experiment.target.agentId, version: experiment.target.version, message: entry.input, mode: 'test', purpose: 'evaluation' }, signal);
    const raw = await this.evaluator.evaluate({ input: entry.input, output: run.response, ...(entry.reference !== undefined ? { reference: entry.reference } : {}) });
    const scores = profile.metrics.flatMap((definition) => { if (definition.kind !== 'code') return []; const score = raw.find((item) => item.metric === definition.scorer); return score === undefined ? [] : [{ ...score, metric: definition.id }]; });
    const judged = await this.evaluateJudges(experiment, profile, entry.input, run.response, entry.reference, signal); scores.push(...judged.scores);
    if (entry.expectedTools !== undefined) { const called = new Set(run.trace.filter((event) => event.kind === 'tool-call').map((event) => event.kind === 'tool-call' ? event.name : '')); const hits = entry.expectedTools.filter((name) => called.has(name)).length; scores.push({ metric: 'expected-tool-hit', score: hits / entry.expectedTools.length }); }
    return { experimentId: experiment.id, scope: experiment.scope, caseId: entry.id, caseKind: 'turn', repetition, status: 'succeeded', runIds: [run.runId], output: run.response, scores, usage: { ...run.usage }, ...(judged.records.length > 0 ? { judgeEvaluations: judged.records } : {}) };
  }

  private async runScenarioCase(experiment: Experiment, entry: ScenarioEvaluationCase, repetition: number, profile: EvaluatorProfile, signal?: AbortSignal): Promise<Omit<ExperimentCaseResult, 'latencyMs'>> {
    const definition = await this.scenarios.findVersion(experiment.scope, entry.scenario.id, entry.scenario.version);
    if (definition === null) throw new Error(`Scenario not found: ${entry.scenario.id}@${entry.scenario.version.toString()}`);
    const run = await this.runScenario.execute({ scope: experiment.scope, scenarioId: entry.scenario.id, version: entry.scenario.version, mode: 'test', target: experiment.target }, signal);
    if (signal?.aborted === true) return { experimentId: experiment.id, scope: experiment.scope, caseId: entry.id, caseKind: 'scenario', repetition, status: 'cancelled', runIds: run.transcript.flatMap((turn) => turn.runId === undefined ? [] : [turn.runId]), output: run.impressions, scores: [], usage: { ...run.metrics.usage } };
    const output = run.transcript.filter((turn) => turn.speaker === 'agent').at(-1)?.message ?? run.impressions; const scores = this.scenarioScores(run, definition.survey);
    const judged = run.status === 'error' ? { scores: [], records: [] } : await this.evaluateJudges(experiment, profile, definition.goal, output, undefined, signal); scores.push(...judged.scores);
    return { experimentId: experiment.id, scope: experiment.scope, caseId: entry.id, caseKind: 'scenario', repetition, status: run.status === 'error' ? 'failed' : 'succeeded', runIds: run.transcript.flatMap((turn) => turn.runId === undefined ? [] : [turn.runId]), output, scores, usage: { ...run.metrics.usage }, ...(run.status === 'error' ? { error: { code: 'SCENARIO_RUN_ERROR', message: 'Scenario execution failed', retryable: false } } : {}), ...(judged.records.length > 0 ? { judgeEvaluations: judged.records } : {}) };
  }

  private async evaluateJudges(experiment: Experiment, profile: EvaluatorProfile, input: string, output: string, reference: string | undefined, signal?: AbortSignal): Promise<{ scores: { metric: string; score: number; reason?: string }[]; records: JudgeEvaluationRecord[] }> {
    const scores: { metric: string; score: number; reason?: string }[] = []; const records: JudgeEvaluationRecord[] = [];
    for (const metric of profile.metrics) {
      if (metric.kind !== 'judge') continue;
      // 評価を始める前に指紋を確定させる。ここで解決しておけば失敗レコードにも正しい設定が残る。
      const model = await this.resolveJudgeSnapshot();
      try {
        if (this.judgeOptions === undefined) throw new JudgeEvaluationError('JUDGE_PROVIDER', 'Judge evaluator is not configured');
        const rubric = await this.judgeOptions.rubrics.findVersion(experiment.scope, metric.rubric.id, metric.rubric.version); if (rubric === null) throw new JudgeEvaluationError('JUDGE_INPUT', `Judge rubric not found: ${metric.rubric.id}@${metric.rubric.version.toString()}`);
        const judged = await this.judgeOptions.evaluator.evaluate({ rubric, input, output, ...(reference !== undefined ? { reference } : {}) }, signal);
        scores.push({ metric: metric.id, score: judged.score, reason: judged.reason }); records.push({ scorer: 'llm-as-judge', metricId: metric.id, rubric: metric.rubric, required: metric.required, model: judged.model, status: 'succeeded', score: judged.score, reason: judged.reason });
      } catch (error) {
        records.push({ scorer: 'llm-as-judge', metricId: metric.id, rubric: metric.rubric, required: metric.required, model, status: 'failed', error: { code: errorCode(error), message: errorMessage(error) } });
      }
    }
    return { scores, records };
  }

  /**
   * judge の指紋を「実際に使う設定」で解決する。
   * 事前解決が配線されていない（＝切替不可な配線・明示注入）ときは従来どおり同期値を使う。
   * 解決に失敗しても Run 側と同じく静的な値へ落として評価は続ける。
   */
  private async resolveJudgeSnapshot(): Promise<ExperimentModelSnapshot> {
    const options = this.judgeOptions;
    if (options === undefined) return UNCONFIGURED_JUDGE;
    if (options.resolveSnapshot !== undefined) {
      // 設定が壊れていても評価は続ける。指紋は同期値へフォールバックする。
      // ただし無音にはしない: 記録される指紋が実際に使ったモデルとずれ続けるのは追跡不能な事故になる。
      try { return await options.resolveSnapshot(); }
      catch (error) { logSwallowed(this.logger, 'judge model settings could not be resolved; falling back to the last known snapshot', error); }
    }
    return options.evaluator.snapshot();
  }

  private scenarioScores(run: ScenarioRun, questions: readonly { readonly id: string; readonly kind: string; readonly min?: number; readonly max?: number }[]): { metric: string; score: number }[] {
    const scores = [{ metric: 'scenario-completed', score: run.status === 'completed' ? 1 : 0 }];
    if (run.goalAchieved !== null) scores.push({ metric: 'goal-achieved', score: run.goalAchieved ? 1 : 0 });
    if (run.metrics.expectedToolHit !== undefined) scores.push({ metric: 'expected-tool-hit', score: run.metrics.expectedToolHit.hitRate });
    for (const answer of run.survey) { const question = questions.find((item) => item.id === answer.questionId); if (typeof answer.value === 'boolean') scores.push({ metric: `survey:${answer.questionId}`, score: answer.value ? 1 : 0 }); else if (typeof answer.value === 'number' && question?.kind === 'scale') { const min = question.min ?? 1; const max = question.max ?? 5; scores.push({ metric: `survey:${answer.questionId}`, score: max === min ? 1 : Math.min(1, Math.max(0, (answer.value - min) / (max - min))) }); } }
    return scores;
  }
}
