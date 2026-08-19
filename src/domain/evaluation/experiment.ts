import type { AgentId } from '../agent/ids';
import type { RunId } from '../run/ids';
import type { RunUsage } from '../run/run';
import { assertNonEmpty } from '../shared/assert';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../tool/ids';
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
}

export interface Experiment {
  readonly id: ExperimentId;
  readonly scope: TenantScope;
  readonly target: { readonly agentId: AgentId; readonly version: SemVer };
  readonly dataset: ExperimentArtifactRef;
  readonly evaluatorProfile: ExperimentArtifactRef;
  readonly repetitions: number;
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

export function createExperiment(props: Experiment): Experiment {
  nonEmpty(props.id, 'Experiment: id'); nonEmpty(props.scope?.tenantId, 'Experiment: scope.tenantId'); nonEmpty(props.scope?.workspaceId, 'Experiment: scope.workspaceId');
  nonEmpty(props.target?.agentId, 'Experiment: target.agentId');
  if (!(props.target.version instanceof SemVer)) throw new EvaluationDomainError('Experiment: target.version must be a SemVer instance');
  if (!Number.isInteger(props.repetitions) || props.repetitions < 1 || props.repetitions > 10) throw new EvaluationDomainError('Experiment: repetitions must be an integer between 1 and 10');
  if (!(EXPERIMENT_STATUSES as readonly unknown[]).includes(props.status)) throw new EvaluationDomainError(`Experiment: invalid status: ${String(props.status)}`);
  nonEmpty(props.snapshot?.provider, 'Experiment: snapshot.provider'); nonEmpty(props.snapshot.model, 'Experiment: snapshot.model'); nonEmpty(props.snapshot.modelConfigHash, 'Experiment: snapshot.modelConfigHash'); nonEmpty(props.createdAt, 'Experiment: createdAt');
  return {
    id: props.id, scope: { ...props.scope }, target: { agentId: props.target.agentId, version: props.target.version },
    dataset: validateRef(props.dataset, 'Experiment: dataset'), evaluatorProfile: validateRef(props.evaluatorProfile, 'Experiment: evaluatorProfile'),
    repetitions: props.repetitions, status: props.status, snapshot: { ...props.snapshot }, progress: validateProgress(props.progress), createdAt: props.createdAt,
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
    return { ...record, rubric: { ...record.rubric }, model: { ...record.model }, ...(record.error !== undefined ? { error: { ...record.error } } : {}) };
  });
  return { experimentId: props.experimentId, scope: { ...props.scope }, caseId: props.caseId, caseKind: props.caseKind, repetition: props.repetition, status: props.status, runIds, ...(props.output !== undefined ? { output: props.output } : {}), scores, latencyMs: props.latencyMs, usage: { ...props.usage }, ...(props.error !== undefined ? { error: { ...props.error } } : {}), ...(judgeEvaluations !== undefined ? { judgeEvaluations } : {}) };
}
