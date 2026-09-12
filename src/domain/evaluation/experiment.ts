import type { AgentId } from '../agent/ids';
import type { RunId } from '../run/ids';
import type { RunUsage } from '../run/run';
import { assertNonEmpty } from '../shared/assert';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../shared/tenant-scope';
import { SemVer } from '../tool/semver';
import type { EvaluationScore } from './evaluation';
import { createEvaluationResult } from './evaluation';
import { EvaluationDomainError } from './errors';
import type { EvaluationCaseId, ExperimentId, MetricId } from './ids';

export const EXPERIMENT_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const EXPERIMENT_CASE_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export type ExperimentCaseStatus = (typeof EXPERIMENT_CASE_STATUSES)[number];

export interface ExperimentArtifactRef { readonly id: string; readonly version: SemVer }
export interface ExperimentModelSnapshot { readonly provider: string; readonly model: string; readonly modelConfigHash: string; readonly sourceRevision?: string }
export interface ExperimentProgress { readonly completed: number; readonly total: number }
export interface ExperimentError { readonly code: string; readonly message: string }
/** 基準別の判定。score は基準の levels のいずれか、null は判定不能（CANNOT_ASSESS）で理由だけを持つ。 */
export interface JudgeCriterionVerdictRecord { readonly id: string; readonly score: number | null; readonly reason: string }
/** 自己一貫性サンプル間の合成スコアのばらつき。stddev は母標準偏差。 */
export interface JudgeDispersion { readonly min: number; readonly max: number; readonly stddev: number }
/** 判定契約の指紋。どのプロンプト版・ルーブリック版で判定したかを残し、判定者の更新をドリフトとして検知する土台。 */
export interface JudgeContract { readonly promptHash: string; readonly rubricId: string; readonly rubricVersion: string }
export interface JudgeEvaluationRecord {
  readonly scorer: 'llm-as-judge';
  readonly metricId: MetricId;
  readonly rubric: ExperimentArtifactRef;
  readonly required: boolean;
  readonly model: ExperimentModelSnapshot;
  readonly status: 'succeeded' | 'failed';
  readonly score?: number;
  readonly reason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  // 以下は基準別判定（P1〜P4）で加わった任意項目。古いレコードには無い。
  readonly criteria?: readonly JudgeCriterionVerdictRecord[];
  readonly samples?: number;
  readonly dispersion?: JudgeDispersion;
  readonly uncertain?: boolean;
  readonly usage?: RunUsage;
  readonly contract?: JudgeContract;
}

export interface Experiment {
  readonly id: ExperimentId;
  readonly scope: TenantScope;
  readonly target: { readonly agentId: AgentId; readonly version: SemVer };
  readonly dataset: ExperimentArtifactRef;
  readonly evaluatorProfile: ExperimentArtifactRef;
  readonly repetitions: number;
  /** 事例ごとの判定サンプル数（1〜5）。2 以上で中央値を score に、ばらつきを dispersion に記録する。 */
  readonly judgeSamples: number;
  readonly status: ExperimentStatus;
  readonly snapshot: ExperimentModelSnapshot;
  readonly progress: ExperimentProgress;
  readonly createdAt: IsoDateTime;
  readonly startedAt?: IsoDateTime;
  readonly finishedAt?: IsoDateTime;
  readonly error?: ExperimentError;
}

export interface ExperimentCaseResult {
  readonly experimentId: ExperimentId;
  readonly scope: TenantScope;
  readonly caseId: EvaluationCaseId;
  readonly caseKind: 'turn' | 'scenario';
  readonly repetition: number;
  readonly status: ExperimentCaseStatus;
  readonly runIds: readonly RunId[];
  readonly output?: string;
  readonly scores: readonly EvaluationScore[];
  readonly latencyMs: number;
  readonly usage: RunUsage;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly judgeEvaluations?: readonly JudgeEvaluationRecord[];
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, field, (m) => new EvaluationDomainError(m));
}
function validateRef(ref: ExperimentArtifactRef, field: string): ExperimentArtifactRef {
  nonEmpty(ref?.id, `${field}.id`);
  if (!(ref.version instanceof SemVer)) throw new EvaluationDomainError(`${field}.version must be a SemVer instance`);
  return { id: ref.id, version: ref.version };
}
function validateProgress(progress: ExperimentProgress): ExperimentProgress {
  if (!Number.isInteger(progress.completed) || progress.completed < 0 || !Number.isInteger(progress.total) || progress.total < 1 || progress.completed > progress.total) throw new EvaluationDomainError('Experiment: progress must be integers with 0 <= completed <= total');
  return { ...progress };
}

/** judgeSamples は後付けの項目なので省略可（既定 1。古い永続 JSON も 1 として読む）。 */
export type ExperimentProps = Omit<Experiment, 'judgeSamples'> & { readonly judgeSamples?: number };

export function createExperiment(props: ExperimentProps): Experiment {
  nonEmpty(props.id, 'Experiment: id'); nonEmpty(props.scope?.tenantId, 'Experiment: scope.tenantId'); nonEmpty(props.scope?.workspaceId, 'Experiment: scope.workspaceId');
  nonEmpty(props.target?.agentId, 'Experiment: target.agentId');
  if (!(props.target.version instanceof SemVer)) throw new EvaluationDomainError('Experiment: target.version must be a SemVer instance');
  if (!Number.isInteger(props.repetitions) || props.repetitions < 1 || props.repetitions > 10) throw new EvaluationDomainError('Experiment: repetitions must be an integer between 1 and 10');
  const judgeSamples = props.judgeSamples ?? 1;
  if (!Number.isInteger(judgeSamples) || judgeSamples < 1 || judgeSamples > 5) throw new EvaluationDomainError('Experiment: judgeSamples must be an integer between 1 and 5');
  if (!(EXPERIMENT_STATUSES as readonly unknown[]).includes(props.status)) throw new EvaluationDomainError(`Experiment: invalid status: ${String(props.status)}`);
  nonEmpty(props.snapshot?.provider, 'Experiment: snapshot.provider'); nonEmpty(props.snapshot.model, 'Experiment: snapshot.model'); nonEmpty(props.snapshot.modelConfigHash, 'Experiment: snapshot.modelConfigHash'); nonEmpty(props.createdAt, 'Experiment: createdAt');
  return {
    id: props.id, scope: { ...props.scope }, target: { agentId: props.target.agentId, version: props.target.version },
    dataset: validateRef(props.dataset, 'Experiment: dataset'), evaluatorProfile: validateRef(props.evaluatorProfile, 'Experiment: evaluatorProfile'),
    repetitions: props.repetitions, judgeSamples, status: props.status, snapshot: { ...props.snapshot }, progress: validateProgress(props.progress), createdAt: props.createdAt,
    ...(props.startedAt !== undefined ? { startedAt: props.startedAt } : {}), ...(props.finishedAt !== undefined ? { finishedAt: props.finishedAt } : {}), ...(props.error !== undefined ? { error: { ...props.error } } : {}),
  };
}

function requireStatus(experiment: Experiment, allowed: readonly ExperimentStatus[], action: string): void {
  if (!allowed.includes(experiment.status)) throw new EvaluationDomainError(`${action}: experiment '${experiment.id}' is ${experiment.status}`);
}

export function startExperiment(experiment: Experiment, startedAt: IsoDateTime): Experiment { requireStatus(experiment, ['queued'], 'startExperiment'); nonEmpty(startedAt, 'startExperiment: startedAt'); return { ...experiment, status: 'running', startedAt, error: undefined }; }
export function advanceExperiment(experiment: Experiment): Experiment { requireStatus(experiment, ['running'], 'advanceExperiment'); return { ...experiment, progress: validateProgress({ completed: experiment.progress.completed + 1, total: experiment.progress.total }) }; }
export function completeExperiment(experiment: Experiment, finishedAt: IsoDateTime): Experiment { requireStatus(experiment, ['running'], 'completeExperiment'); nonEmpty(finishedAt, 'completeExperiment: finishedAt'); if (experiment.progress.completed !== experiment.progress.total) throw new EvaluationDomainError('completeExperiment: progress is incomplete'); return { ...experiment, status: 'completed', finishedAt }; }
export function failExperiment(experiment: Experiment, error: ExperimentError, finishedAt: IsoDateTime): Experiment { requireStatus(experiment, ['queued', 'running'], 'failExperiment'); nonEmpty(error.code, 'failExperiment: error.code'); nonEmpty(error.message, 'failExperiment: error.message'); nonEmpty(finishedAt, 'failExperiment: finishedAt'); return { ...experiment, status: 'failed', error: { ...error }, finishedAt }; }
export function cancelExperiment(experiment: Experiment, finishedAt: IsoDateTime): Experiment { requireStatus(experiment, ['queued', 'running'], 'cancelExperiment'); nonEmpty(finishedAt, 'cancelExperiment: finishedAt'); return { ...experiment, status: 'cancelled', finishedAt }; }
export function interruptExperiment(experiment: Experiment, finishedAt: IsoDateTime): Experiment { requireStatus(experiment, ['running'], 'interruptExperiment'); nonEmpty(finishedAt, 'interruptExperiment: finishedAt'); return { ...experiment, status: 'interrupted', finishedAt, error: { code: 'PROCESS_INTERRUPTED', message: 'Experiment process stopped before completion' } }; }
export function resumeExperiment(experiment: Experiment): Experiment { requireStatus(experiment, ['interrupted', 'failed'], 'resumeExperiment'); const { finishedAt: _finishedAt, error: _error, ...rest } = experiment; return { ...rest, status: 'queued' }; }

type JudgeDetails = Pick<JudgeEvaluationRecord, 'criteria' | 'samples' | 'dispersion' | 'uncertain' | 'usage' | 'contract'>;
/**
 * 基準別判定・自己一貫性・判定契約の任意項目を検証して防御的に複製する。
 * 失敗レコードにも contract / usage は残り得る（呼び出し前に契約は決まっている）ので status では分岐しない。
 */
function validateJudgeDetails(record: JudgeEvaluationRecord, field: string): JudgeDetails {
  const details: { -readonly [K in keyof JudgeDetails]?: JudgeDetails[K] } = {};
  if (record.criteria !== undefined) {
    const ids = new Set<string>();
    details.criteria = record.criteria.map((criterion, index): JudgeCriterionVerdictRecord => {
      nonEmpty(criterion?.id, `${field}.criteria.${index}.id`); nonEmpty(criterion.reason, `${field}.criteria.${index}.reason`);
      if (ids.has(criterion.id)) throw new EvaluationDomainError(`${field}.criteria has duplicate id: ${criterion.id}`); ids.add(criterion.id);
      if (criterion.score !== null && (!Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > 1)) throw new EvaluationDomainError(`${field}.criteria.${index}.score must be null or between 0 and 1`);
      return { id: criterion.id, score: criterion.score, reason: criterion.reason };
    });
  }
  if (record.samples !== undefined) { if (!Number.isInteger(record.samples) || record.samples < 1) throw new EvaluationDomainError(`${field}.samples must be a positive integer`); details.samples = record.samples; }
  if (record.dispersion !== undefined) {
    const { min, max, stddev } = record.dispersion;
    if (![min, max, stddev].every(Number.isFinite) || min > max || stddev < 0) throw new EvaluationDomainError(`${field}.dispersion must satisfy min <= max and stddev >= 0`);
    details.dispersion = { min, max, stddev };
  }
  if (record.uncertain !== undefined) { if (typeof record.uncertain !== 'boolean') throw new EvaluationDomainError(`${field}.uncertain must be boolean`); details.uncertain = record.uncertain; }
  if (record.usage !== undefined) details.usage = { ...record.usage };
  if (record.contract !== undefined) { nonEmpty(record.contract.promptHash, `${field}.contract.promptHash`); nonEmpty(record.contract.rubricId, `${field}.contract.rubricId`); nonEmpty(record.contract.rubricVersion, `${field}.contract.rubricVersion`); details.contract = { ...record.contract }; }
  return details;
}

export function createExperimentCaseResult(props: ExperimentCaseResult): ExperimentCaseResult {
  nonEmpty(props.experimentId, 'ExperimentCaseResult: experimentId'); nonEmpty(props.scope?.tenantId, 'ExperimentCaseResult: scope.tenantId'); nonEmpty(props.scope?.workspaceId, 'ExperimentCaseResult: scope.workspaceId'); nonEmpty(props.caseId, 'ExperimentCaseResult: caseId');
  if (props.caseKind !== 'turn' && props.caseKind !== 'scenario') throw new EvaluationDomainError('ExperimentCaseResult: invalid caseKind');
  if (!Number.isInteger(props.repetition) || props.repetition < 1) throw new EvaluationDomainError('ExperimentCaseResult: repetition must be a positive integer');
  if (!(EXPERIMENT_CASE_STATUSES as readonly unknown[]).includes(props.status)) throw new EvaluationDomainError('ExperimentCaseResult: invalid status');
  if (!Number.isFinite(props.latencyMs) || props.latencyMs < 0) throw new EvaluationDomainError('ExperimentCaseResult: latencyMs must be non-negative');
  const runIds = props.runIds.map((id, index) => { nonEmpty(id, `ExperimentCaseResult: runIds.${index}`); return id; });
  const scores = createEvaluationResult(props.scores).scores;
  if (props.status === 'failed' && props.error === undefined) throw new EvaluationDomainError('ExperimentCaseResult: failed result requires error');
  const judgeEvaluations = props.judgeEvaluations?.map((record, index): JudgeEvaluationRecord => {
    if (record.scorer !== 'llm-as-judge') throw new EvaluationDomainError(`ExperimentCaseResult: judgeEvaluations.${index}.scorer is invalid`);
    nonEmpty(record.metricId, `ExperimentCaseResult: judgeEvaluations.${index}.metricId`); validateRef(record.rubric, `ExperimentCaseResult: judgeEvaluations.${index}.rubric`);
    nonEmpty(record.model?.provider, `ExperimentCaseResult: judgeEvaluations.${index}.model.provider`); nonEmpty(record.model.model, `ExperimentCaseResult: judgeEvaluations.${index}.model.model`); nonEmpty(record.model.modelConfigHash, `ExperimentCaseResult: judgeEvaluations.${index}.model.modelConfigHash`);
    if (typeof record.required !== 'boolean') throw new EvaluationDomainError(`ExperimentCaseResult: judgeEvaluations.${index}.required must be boolean`);
    if (record.status === 'succeeded') {
      if (!Number.isFinite(record.score) || (record.score ?? -1) < 0 || (record.score ?? 2) > 1) throw new EvaluationDomainError(`ExperimentCaseResult: judgeEvaluations.${index}.score must be between 0 and 1`);
      nonEmpty(record.reason, `ExperimentCaseResult: judgeEvaluations.${index}.reason`);
    } else if (record.status === 'failed') {
      if (record.error === undefined) throw new EvaluationDomainError(`ExperimentCaseResult: judgeEvaluations.${index}.failed record requires error`);
      if (record.score !== undefined) throw new EvaluationDomainError(`ExperimentCaseResult: judgeEvaluations.${index}.failed record must not contain a score`);
      nonEmpty(record.error.code, `ExperimentCaseResult: judgeEvaluations.${index}.error.code`); nonEmpty(record.error.message, `ExperimentCaseResult: judgeEvaluations.${index}.error.message`);
    } else throw new EvaluationDomainError(`ExperimentCaseResult: judgeEvaluations.${index}.status is invalid`);
    return { ...record, rubric: { ...record.rubric }, model: { ...record.model }, ...(record.error !== undefined ? { error: { ...record.error } } : {}), ...validateJudgeDetails(record, `ExperimentCaseResult: judgeEvaluations.${index}`) };
  });
  return { experimentId: props.experimentId, scope: { ...props.scope }, caseId: props.caseId, caseKind: props.caseKind, repetition: props.repetition, status: props.status, runIds, ...(props.output !== undefined ? { output: props.output } : {}), scores, latencyMs: props.latencyMs, usage: { ...props.usage }, ...(props.error !== undefined ? { error: { ...props.error } } : {}), ...(judgeEvaluations !== undefined ? { judgeEvaluations } : {}) };
}
