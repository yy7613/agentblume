/**
 * ドメイン: ScenarioRun（結果の記録）（v16 実装契約 §2.4 / docs/11 §6）
 *
 * 生成は application 層のオーケストレータが行い、domain は型と最小整合チェックのみ。
 */
import type { RunId } from '../run/ids';
import type { RunUsage } from '../run/run';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../tool/ids';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';
import type { ScenarioId, ScenarioRunId } from './ids';
import { nonEmpty } from './metadata';
import type { SurveyAnswer } from './survey';

export const SCENARIO_RUN_STATUSES = ['completed', 'max-turns', 'error'] as const;
export type ScenarioRunStatus = (typeof SCENARIO_RUN_STATUSES)[number];

export interface Turn {
  readonly speaker: 'user' | 'agent';
  readonly message: string;
  /** agent ターンのみ: 既存 RunRepository の Run 参照。 */
  readonly runId?: RunId;
}

export interface ExpectedToolHit {
  readonly expected: readonly string[];
  readonly called: readonly string[];
  /** |期待∩実呼び出し| / |期待|。 */
  readonly hitRate: number;
}

export interface ScenarioRunMetrics {
  readonly userTurns: number;
  readonly agentRuns: number;
  readonly totalToolCalls: number;
  readonly expectedToolHit?: ExpectedToolHit;
  readonly durationMs: number;
  readonly usage: RunUsage;
}

export interface ScenarioRunPseudoUserRef {
  readonly type: 'persona' | 'agent';
  readonly id: string;
  readonly version: string;
}

export interface ScenarioRun {
  readonly id: ScenarioRunId;
  readonly scope: TenantScope;
  /** 実行時点の固定参照。 */
  readonly scenario: { readonly id: ScenarioId; readonly version: SemVer };
  /** 使用した疑似ユーザーの参照（persona@version または agent@version）。v18。 */
  readonly pseudoUserRef?: ScenarioRunPseudoUserRef;
  readonly status: ScenarioRunStatus;
  /** 疑似ユーザー申告（未申告は null）。 */
  readonly goalAchieved: boolean | null;
  readonly transcript: readonly Turn[];
  readonly survey: readonly SurveyAnswer[];
  /** 感想（id 'impressions' の回答。無ければ空文字）。 */
  readonly impressions: string;
  readonly metrics: ScenarioRunMetrics;
  readonly startedAt: IsoDateTime;
  readonly finishedAt: IsoDateTime;
}

export type CreateScenarioRunProps = ScenarioRun;

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationDomainError(`createScenarioRun: ${field} must be a non-negative integer`);
  }
  return value;
}

export function createScenarioRun(props: CreateScenarioRunProps): ScenarioRun {
  nonEmpty(props.id, 'createScenarioRun: id');
  nonEmpty(props.scope?.tenantId, 'createScenarioRun: scope.tenantId');
  nonEmpty(props.scope?.workspaceId, 'createScenarioRun: scope.workspaceId');
  nonEmpty(props.scenario?.id, 'createScenarioRun: scenario.id');
  if (!(props.scenario.version instanceof SemVer)) {
    throw new ValidationDomainError('createScenarioRun: scenario.version must be a SemVer instance');
  }
  if (!(SCENARIO_RUN_STATUSES as readonly string[]).includes(props.status)) {
    throw new ValidationDomainError(`createScenarioRun: invalid status: ${String(props.status)}`);
  }
  if (props.goalAchieved !== null && typeof props.goalAchieved !== 'boolean') {
    throw new ValidationDomainError('createScenarioRun: goalAchieved must be a boolean or null');
  }
  const transcript = props.transcript.map((turn, index) => {
    if (turn.speaker !== 'user' && turn.speaker !== 'agent') {
      throw new ValidationDomainError(`createScenarioRun: transcript.${index}: invalid speaker`);
    }
    if (typeof turn.message !== 'string') {
      throw new ValidationDomainError(`createScenarioRun: transcript.${index}: message must be a string`);
    }
    if (turn.runId !== undefined) nonEmpty(turn.runId, `createScenarioRun: transcript.${index}.runId`);
    return { speaker: turn.speaker, message: turn.message, ...(turn.runId !== undefined ? { runId: turn.runId } : {}) };
  });
  const survey = props.survey.map((answer, index) => {
    nonEmpty(answer?.questionId, `createScenarioRun: survey.${index}.questionId`);
    if (!['number', 'boolean', 'string'].includes(typeof answer.value)) {
      throw new ValidationDomainError(`createScenarioRun: survey.${index}.value must be number, boolean, or string`);
    }
    return { questionId: answer.questionId, value: answer.value };
  });
  if (typeof props.impressions !== 'string') {
    throw new ValidationDomainError('createScenarioRun: impressions must be a string');
  }
  const { metrics } = props;
  nonNegativeInteger(metrics.userTurns, 'metrics.userTurns');
  nonNegativeInteger(metrics.agentRuns, 'metrics.agentRuns');
  nonNegativeInteger(metrics.totalToolCalls, 'metrics.totalToolCalls');
  if (!Number.isFinite(metrics.durationMs) || metrics.durationMs < 0) {
    throw new ValidationDomainError('createScenarioRun: metrics.durationMs must be a non-negative number');
  }
  let expectedToolHit: ExpectedToolHit | undefined;
  if (metrics.expectedToolHit !== undefined) {
    const hit = metrics.expectedToolHit;
    if (!Number.isFinite(hit.hitRate) || hit.hitRate < 0 || hit.hitRate > 1) {
      throw new ValidationDomainError('createScenarioRun: metrics.expectedToolHit.hitRate must be between 0 and 1');
    }
    expectedToolHit = { expected: [...hit.expected], called: [...hit.called], hitRate: hit.hitRate };
  }
  nonEmpty(props.startedAt, 'createScenarioRun: startedAt');
  nonEmpty(props.finishedAt, 'createScenarioRun: finishedAt');
  let pseudoUserRef: ScenarioRunPseudoUserRef | undefined;
  if (props.pseudoUserRef !== undefined) {
    if (props.pseudoUserRef.type !== 'persona' && props.pseudoUserRef.type !== 'agent') {
      throw new ValidationDomainError('createScenarioRun: pseudoUserRef.type must be "persona" or "agent"');
    }
    nonEmpty(props.pseudoUserRef.id, 'createScenarioRun: pseudoUserRef.id');
    nonEmpty(props.pseudoUserRef.version, 'createScenarioRun: pseudoUserRef.version');
    pseudoUserRef = { type: props.pseudoUserRef.type, id: props.pseudoUserRef.id, version: props.pseudoUserRef.version };
  }
  return {
    id: props.id,
    scope: { ...props.scope },
    scenario: { id: props.scenario.id, version: props.scenario.version },
    ...(pseudoUserRef !== undefined ? { pseudoUserRef } : {}),
    status: props.status,
    goalAchieved: props.goalAchieved,
    transcript,
    survey,
    impressions: props.impressions,
    metrics: {
      userTurns: metrics.userTurns,
      agentRuns: metrics.agentRuns,
      totalToolCalls: metrics.totalToolCalls,
      ...(expectedToolHit !== undefined ? { expectedToolHit } : {}),
      durationMs: metrics.durationMs,
      usage: { ...metrics.usage },
    },
    startedAt: props.startedAt,
    finishedAt: props.finishedAt,
  };
}
