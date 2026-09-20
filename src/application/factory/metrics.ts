/**
 * application層: Agent Factory イテレーションメトリクス集計 `aggregateIterationMetrics`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §5.1）。
 *
 * 副作用のない純関数。`ScenarioRun[]` から `IterationMetrics` を決定的に集計する。
 * すべての比率・平均は分母0を0へガードする（Scenario集合が空、またはアンケート/期待Tool未設定でも例外を投げない）。
 */
import type { IterationMetrics } from '../../domain/factory/factory-run';
import type { ScenarioRun } from '../../domain/validation/scenario-run';

export interface AggregateIterationMetricsInput {
  readonly iteration: number;
  readonly runs: readonly ScenarioRun[];
  /** イテレーション全体の所要時間（呼び出し側が各Runの `metrics.durationMs` 等から算出して渡す）。 */
  readonly durationMs: number;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** `q2`（総合満足度・scale）の回答値のみを対象にする（docs/16 §5.1）。 */
function satisfactionValues(runs: readonly ScenarioRun[]): number[] {
  return runs
    .map((run) => run.survey.find((answer) => answer.questionId === 'q2'))
    .filter((answer): answer is NonNullable<typeof answer> => answer !== undefined && typeof answer.value === 'number')
    .map((answer) => answer.value as number);
}

/**
 * 総合満足度（`q2`）を回収できなかったRunの件数。
 *
 * `avgSatisfaction` は `q2` を持つRunだけを平均するので、アンケートが1件も取れないRunがあっても
 * 平均値には現れない（実測では「全シナリオでアンケート欠測 → avgSatisfaction 0」を
 * 「利用者の満足度が0」と読み違える事故が起きた）。欠測そのものを指標として出す（ADR-0047）。
 */
function surveyMissingCount(runs: readonly ScenarioRun[]): number {
  return runs.filter((run) => !run.survey.some((answer) => answer.questionId === 'q2' && typeof answer.value === 'number')).length;
}

function toolHitRates(runs: readonly ScenarioRun[]): number[] {
  return runs
    .map((run) => run.metrics.expectedToolHit?.hitRate)
    .filter((rate): rate is number => rate !== undefined);
}

/** usageは各トークン種別ごとに、値を持つRunのみ合算する。全Runが未定義の種別はフィールドごと省く。 */
function sumUsage(runs: readonly ScenarioRun[]): IterationMetrics['usage'] {
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;
  for (const run of runs) {
    const usage = run.metrics.usage;
    if (usage.promptTokens !== undefined) promptTokens = (promptTokens ?? 0) + usage.promptTokens;
    if (usage.completionTokens !== undefined) completionTokens = (completionTokens ?? 0) + usage.completionTokens;
    if (usage.totalTokens !== undefined) totalTokens = (totalTokens ?? 0) + usage.totalTokens;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function aggregateIterationMetrics(input: AggregateIterationMetricsInput): IterationMetrics {
  const { iteration, runs, durationMs } = input;
  const scenarioCount = runs.length;
  const goalAchievedRate = scenarioCount === 0 ? 0 : runs.filter((run) => run.goalAchieved === true).length / scenarioCount;
  const avgSatisfaction = average(satisfactionValues(runs));
  const toolHitRate = average(toolHitRates(runs));
  const errorRate = scenarioCount === 0 ? 0 : runs.filter((run) => run.status === 'error').length / scenarioCount;
  const avgUserTurns = average(runs.map((run) => run.metrics.userTurns));
  return {
    iteration,
    goalAchievedRate,
    avgSatisfaction,
    toolHitRate,
    errorRate,
    avgUserTurns,
    scenarioCount,
    surveyMissingCount: surveyMissingCount(runs),
    usage: sumUsage(runs),
    durationMs,
  };
}
