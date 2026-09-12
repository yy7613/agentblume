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
  constructor(code: 'JUDGE_INPUT' | 'JUDGE_PROVIDER' | 'JUDGE_SCHEMA' | 'JUDGE_UNASSESSABLE', message: string, override readonly cause?: unknown) { super(message); this.name = 'JudgeEvaluationError'; this.code = code; }
}

/**
 * judge 指標を持つ評価プロファイルで実験を起票したが、judge スロットにモデルが設定されていない。
 * 起票を通すと全事例が判定失敗で終わり、利用者は原因（judge 未設定）にも直し方（設定画面）にも辿り着けない。
 */
export class JudgeModelNotConfiguredError extends Error {
  readonly code = 'JUDGE_MODEL_NOT_CONFIGURED';
  constructor(message: string) { super(message); this.name = 'JudgeModelNotConfiguredError'; }
}

/**
 * `tracePolicy: 'required'` のルーブリックを scenario 事例に使おうとした。scenario 事例は
 * ツール呼び出しの軌跡を持たないので、この組み合わせは実行しても必ず JUDGE_INPUT で欠損になる。
 * `rubric` はどのルーブリックを直せばよいかを UI が示すための参照。
 */
export class JudgeTraceUnavailableError extends Error {
  readonly code = 'JUDGE_TRACE_UNAVAILABLE';
  constructor(message: string, readonly rubric: { readonly id: string; readonly version: string }) { super(message); this.name = 'JudgeTraceUnavailableError'; }
}
