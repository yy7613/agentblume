import { validateEvaluationMetadata, evaluationNonEmpty, type EvaluationAssetMetadata } from './asset-metadata';
import { EvaluationDomainError } from './errors';
import type { JudgeRubricId, MetricId } from './ids';
import { SemVer } from '../tool/semver';

export const CODE_SCORERS = ['keyword-coverage', 'completeness', 'tone-consistency', 'content-similarity'] as const;
export type CodeScorer = (typeof CODE_SCORERS)[number];

export interface CodeEvaluatorMetricDefinition {
  readonly id: MetricId;
  readonly kind: 'code';
  readonly weight: number;
  readonly required: boolean;
  readonly scorer: CodeScorer;
}

export interface JudgeEvaluatorMetricDefinition {
  readonly id: MetricId;
  readonly kind: 'judge';
  readonly weight: number;
  readonly required: boolean;
  readonly rubric: { readonly id: JudgeRubricId; readonly version: SemVer };
}

export type EvaluatorMetricDefinition = CodeEvaluatorMetricDefinition | JudgeEvaluatorMetricDefinition;

export interface EvaluatorProfile {
  readonly metadata: EvaluationAssetMetadata;
  readonly metrics: readonly EvaluatorMetricDefinition[];
}

export function createEvaluatorProfile(props: EvaluatorProfile): EvaluatorProfile {
  const metadata = validateEvaluationMetadata(props.metadata, 'createEvaluatorProfile');
  if (!Array.isArray(props.metrics) || props.metrics.length === 0) {
    throw new EvaluationDomainError('createEvaluatorProfile: metrics must contain at least one metric');
  }
  const ids = new Set<string>();
  const metrics = props.metrics.map((metric, index) => {
    evaluationNonEmpty(metric?.id, `createEvaluatorProfile: metrics.${index}.id`);
    if (ids.has(metric.id)) throw new EvaluationDomainError(`createEvaluatorProfile: duplicate metric id: ${metric.id}`);
    ids.add(metric.id);
    if (!Number.isFinite(metric.weight) || metric.weight <= 0) {
      throw new EvaluationDomainError(`createEvaluatorProfile: metrics.${index}.weight must be a positive finite number`);
    }
    if (typeof metric.required !== 'boolean') {
      throw new EvaluationDomainError(`createEvaluatorProfile: metrics.${index}.required must be a boolean`);
    }
    if (metric.kind === 'code') {
      if (!(CODE_SCORERS as readonly unknown[]).includes(metric.scorer)) throw new EvaluationDomainError(`createEvaluatorProfile: unknown scorer: ${String(metric.scorer)}`);
      return { id: metric.id, kind: 'code' as const, weight: metric.weight, required: metric.required, scorer: metric.scorer };
    }
    if (metric.kind === 'judge') {
      evaluationNonEmpty(metric.rubric?.id, `createEvaluatorProfile: metrics.${index}.rubric.id`);
      if (!(metric.rubric.version instanceof SemVer)) throw new EvaluationDomainError(`createEvaluatorProfile: metrics.${index}.rubric.version must be a SemVer instance`);
      return { id: metric.id, kind: 'judge' as const, weight: metric.weight, required: metric.required, rubric: { id: metric.rubric.id, version: metric.rubric.version } };
    }
    throw new EvaluationDomainError(`createEvaluatorProfile: metrics.${index}.kind is invalid`);
  });
  return { metadata, metrics };
}
