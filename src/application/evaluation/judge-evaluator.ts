import type { ExperimentModelSnapshot } from '../../domain/evaluation/experiment';
import type { JudgeRubric } from '../../domain/evaluation/judge-rubric';

export interface JudgeEvaluationInput { readonly rubric: JudgeRubric; readonly input: string; readonly output: string; readonly reference?: string }
export interface JudgeEvaluationResult { readonly score: number; readonly reason: string; readonly model: ExperimentModelSnapshot }
export interface JudgePairwiseInput { readonly rubric: JudgeRubric; readonly seed: string; readonly input: string; readonly candidate: string; readonly baseline: string; readonly reference?: string }
export interface JudgePairwiseResult { readonly winner: 'candidate' | 'baseline' | 'tie'; readonly candidateScore: number; readonly baselineScore: number; readonly reason: string; readonly presentationOrder: 'candidate-first' | 'baseline-first'; readonly model: ExperimentModelSnapshot }

export interface JudgeEvaluatorPort {
  snapshot(): ExperimentModelSnapshot;
  evaluate(input: JudgeEvaluationInput, signal?: AbortSignal): Promise<JudgeEvaluationResult>;
  compare(input: JudgePairwiseInput, signal?: AbortSignal): Promise<JudgePairwiseResult>;
}
