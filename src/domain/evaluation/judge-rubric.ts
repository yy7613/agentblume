import { validateEvaluationMetadata, evaluationNonEmpty, type EvaluationAssetMetadata } from './asset-metadata';
import { EvaluationDomainError } from './errors';

export const JUDGE_REFERENCE_POLICIES = ['optional', 'required', 'forbidden'] as const;
export type JudgeReferencePolicy = (typeof JUDGE_REFERENCE_POLICIES)[number];

export interface JudgeScoreLevel {
  readonly score: number;
  readonly label: string;
  readonly description: string;
}

export interface JudgeCriterion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly weight: number;
  readonly levels: readonly JudgeScoreLevel[];
}

export interface JudgeRubric {
  readonly metadata: EvaluationAssetMetadata;
  readonly instructions: string;
  readonly criteria: readonly JudgeCriterion[];
  readonly referencePolicy: JudgeReferencePolicy;
  readonly reasonRequired: true;
}

export function createJudgeRubric(props: JudgeRubric): JudgeRubric {
  const metadata = validateEvaluationMetadata(props.metadata, 'createJudgeRubric');
  evaluationNonEmpty(props.instructions, 'createJudgeRubric: instructions');
  if (!(JUDGE_REFERENCE_POLICIES as readonly unknown[]).includes(props.referencePolicy)) throw new EvaluationDomainError(`createJudgeRubric: invalid referencePolicy: ${String(props.referencePolicy)}`);
  if (props.reasonRequired !== true) throw new EvaluationDomainError('createJudgeRubric: reasonRequired must be true');
  if (!Array.isArray(props.criteria) || props.criteria.length === 0) throw new EvaluationDomainError('createJudgeRubric: criteria must contain at least one criterion');
  const criterionIds = new Set<string>();
  const criteria = props.criteria.map((criterion, index): JudgeCriterion => {
    evaluationNonEmpty(criterion?.id, `createJudgeRubric: criteria.${index}.id`); evaluationNonEmpty(criterion.label, `createJudgeRubric: criteria.${index}.label`); evaluationNonEmpty(criterion.description, `createJudgeRubric: criteria.${index}.description`);
    if (criterionIds.has(criterion.id)) throw new EvaluationDomainError(`createJudgeRubric: duplicate criterion id: ${criterion.id}`); criterionIds.add(criterion.id);
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) throw new EvaluationDomainError(`createJudgeRubric: criteria.${index}.weight must be positive`);
    if (!Array.isArray(criterion.levels) || criterion.levels.length < 2) throw new EvaluationDomainError(`createJudgeRubric: criteria.${index}.levels must contain at least two levels`);
    const scores = new Set<number>();
    const levels = criterion.levels.map((level: JudgeScoreLevel, levelIndex: number): JudgeScoreLevel => {
      if (!Number.isFinite(level.score) || level.score < 0 || level.score > 1) throw new EvaluationDomainError(`createJudgeRubric: criteria.${index}.levels.${levelIndex}.score must be between 0 and 1`);
      if (scores.has(level.score)) throw new EvaluationDomainError(`createJudgeRubric: duplicate score level: ${level.score}`); scores.add(level.score);
      evaluationNonEmpty(level.label, `createJudgeRubric: criteria.${index}.levels.${levelIndex}.label`); evaluationNonEmpty(level.description, `createJudgeRubric: criteria.${index}.levels.${levelIndex}.description`);
      return { ...level };
    }).sort((a: JudgeScoreLevel, b: JudgeScoreLevel) => a.score - b.score);
    if (!scores.has(0) || !scores.has(1)) throw new EvaluationDomainError(`createJudgeRubric: criteria.${index}.levels must define score 0 and 1`);
    return { id: criterion.id, label: criterion.label, description: criterion.description, weight: criterion.weight, levels };
  });
  return { metadata, instructions: props.instructions, criteria, referencePolicy: props.referencePolicy, reasonRequired: true };
}
