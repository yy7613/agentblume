import type { ExperimentModelSnapshot, JudgeContract, JudgeCriterionVerdictRecord, JudgeDispersion } from '../../domain/evaluation/experiment';
import type { JudgeRubric } from '../../domain/evaluation/judge-rubric';
import type { RunUsage } from '../../domain/run/run';

/** 判定者へ渡すツール呼び出し 1 件。resultSummary は出力プレビューの JSON か成果物参照の要約。 */
export interface JudgeTraceToolCall { readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; readonly resultSummary: string }
export interface JudgeTrace { readonly toolCalls: readonly JudgeTraceToolCall[] }
/** 判定対象の最終応答より前の会話（シナリオ事例）。最終応答そのものは output として別に渡す。 */
export interface JudgeHistoryMessage { readonly role: 'user' | 'assistant'; readonly content: string }

export interface JudgeEvaluationInput {
  readonly rubric: JudgeRubric;
  readonly input: string;
  readonly output: string;
  readonly reference?: string;
  /** rubric.tracePolicy が forbidden でなければ untrusted data として判定者に見せる。 */
  readonly trace?: JudgeTrace;
  readonly history?: readonly JudgeHistoryMessage[];
  /** 自己一貫性のサンプル数（1〜5、既定 1）。2 以上で中央値とばらつきを返す。 */
  readonly samples?: number;
}
export type JudgeCriterionVerdict = JudgeCriterionVerdictRecord;
export interface JudgeEvaluationResult {
  /** 重み付き合成スコア（samples > 1 なら中央値）。 */
  readonly score: number;
  readonly reason: string;
  readonly model: ExperimentModelSnapshot;
  readonly criteria: readonly JudgeCriterionVerdict[];
  /** 実際に判定を得られたサンプル数。 */
  readonly samples: number;
  readonly dispersion: JudgeDispersion;
  readonly uncertain: boolean;
  /** 修復呼び出し・全サンプル分の合計。 */
  readonly usage: RunUsage;
  readonly contract: JudgeContract;
}
export interface JudgePairwiseInput { readonly rubric: JudgeRubric; readonly seed: string; readonly input: string; readonly candidate: string; readonly baseline: string; readonly reference?: string }
export interface JudgePairwiseResult { readonly winner: 'candidate' | 'baseline' | 'tie'; readonly candidateScore: number; readonly baselineScore: number; readonly reason: string; readonly presentationOrder: 'candidate-first' | 'baseline-first'; readonly model: ExperimentModelSnapshot }

export interface JudgeEvaluatorPort {
  snapshot(): ExperimentModelSnapshot;
  evaluate(input: JudgeEvaluationInput, signal?: AbortSignal): Promise<JudgeEvaluationResult>;
  compare(input: JudgePairwiseInput, signal?: AbortSignal): Promise<JudgePairwiseResult>;
}
