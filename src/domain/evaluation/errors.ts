export class EvaluationDomainError extends Error {
  readonly code = 'EVALUATION_DOMAIN';

  constructor(message: string) {
    super(message);
    this.name = 'EvaluationDomainError';
  }
}

export class EvaluationDatasetNotFoundError extends Error {
  readonly code = 'EVALUATION_DATASET_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'EvaluationDatasetNotFoundError';
  }
}

export class EvaluatorProfileNotFoundError extends Error {
  readonly code = 'EVALUATOR_PROFILE_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorProfileNotFoundError';
  }
}

export class EvaluationAssetVersionConflictError extends Error {
  readonly code = 'EVALUATION_VERSION_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'EvaluationAssetVersionConflictError';
  }
}

export class ExperimentNotFoundError extends Error {
  readonly code = 'EXPERIMENT_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'ExperimentNotFoundError';
  }
}

export class ExperimentConflictError extends Error {
  readonly code = 'EXPERIMENT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ExperimentConflictError';
  }
}

export class QualityGateNotFoundError extends Error {
  readonly code = 'QUALITY_GATE_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'QualityGateNotFoundError'; }
}

export class QualityGateConflictError extends Error {
  readonly code = 'QUALITY_GATE_CONFLICT';
  constructor(message: string) { super(message); this.name = 'QualityGateConflictError'; }
}

export class JudgeRubricNotFoundError extends Error {
  readonly code = 'JUDGE_RUBRIC_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'JudgeRubricNotFoundError'; }
}

export class JudgeEvaluationError extends Error {
  readonly code: string;
  constructor(code: 'JUDGE_INPUT' | 'JUDGE_PROVIDER' | 'JUDGE_SCHEMA', message: string, override readonly cause?: unknown) { super(message); this.name = 'JudgeEvaluationError'; this.code = code; }
}
