import type { AgentId } from '../agent/ids';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../shared/tenant-scope';
import { SemVer } from '../tool/semver';
import { validateEvaluationMetadata, evaluationNonEmpty, type EvaluationAssetMetadata } from './asset-metadata';
import type { EvaluationDataset } from './evaluation-dataset';
import type { Experiment, ExperimentCaseResult } from './experiment';
import { EvaluationDomainError } from './errors';
import type { EvaluationCaseId, ExperimentId, GatePolicyId, GateReportId, GateRuleId, PromotionRequestId } from './ids';

export type MetricPreference = 'higher' | 'lower';
export type ComparisonDirection = 'improved' | 'regressed' | 'unchanged' | 'incomparable';

export interface MetricStats {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly p50: number;
  readonly p95: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  readonly samples: readonly number[];
}

export interface ExperimentAggregate {
  readonly experimentId: ExperimentId;
  readonly caseCount: number;
  readonly metrics: Readonly<Record<string, MetricStats>>;
}

export interface MetricComparison {
  readonly metric: string;
  readonly preference: MetricPreference;
  readonly baseline?: MetricStats;
  readonly candidate?: MetricStats;
  readonly delta?: number;
  readonly direction: ComparisonDirection;
}

export interface CaseComparison {
  readonly caseId: EvaluationCaseId;
  readonly repetition: number;
  readonly baselineStatus?: ExperimentCaseResult['status'];
  readonly candidateStatus?: ExperimentCaseResult['status'];
  readonly baselineScore?: number;
  readonly candidateScore?: number;
  readonly delta?: number;
  readonly direction: ComparisonDirection;
}

export interface ExperimentComparison {
  readonly baselineExperimentId: ExperimentId;
  readonly candidateExperimentId: ExperimentId;
  readonly baseline: ExperimentAggregate;
  readonly candidate: ExperimentAggregate;
  readonly metrics: readonly MetricComparison[];
  readonly cases: readonly CaseComparison[];
}

const LOWER_IS_BETTER = new Set(['failure-rate', 'latency-ms', 'tokens-per-case']);
export function metricPreference(metric: string): MetricPreference { return LOWER_IS_BETTER.has(metric) ? 'lower' : 'higher'; }

function round(value: number): number { return Number(value.toFixed(12)); }
function quantile(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  const low = sorted[lower] ?? 0; const high = sorted[upper] ?? low;
  return round(low + (high - low) * (index - lower));
}

export function calculateMetricStats(values: readonly number[]): MetricStats {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new EvaluationDomainError('calculateMetricStats: values must contain finite numbers');
  const samples = [...values].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return { count: samples.length, mean: round(mean), median: quantile(samples, 0.5), p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), stddev: round(Math.sqrt(variance)), min: samples[0] ?? 0, max: samples.at(-1) ?? 0, samples };
}

export function aggregateExperiment(experimentId: ExperimentId, results: readonly ExperimentCaseResult[]): ExperimentAggregate {
  evaluationNonEmpty(experimentId, 'aggregateExperiment: experimentId');
  const values = new Map<string, number[]>();
  const add = (metric: string, value: number): void => { const current = values.get(metric) ?? []; current.push(value); values.set(metric, current); };
  for (const result of results) {
    add('case-success-rate', result.status === 'succeeded' ? 1 : 0);
    add('failure-rate', result.status === 'failed' ? 1 : 0);
    add('latency-ms', result.latencyMs);
    if (result.usage.totalTokens !== undefined) add('tokens-per-case', result.usage.totalTokens);
    for (const score of result.scores) add(score.metric, score.score);
  }
  return { experimentId, caseCount: results.length, metrics: Object.fromEntries([...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([metric, samples]) => [metric, calculateMetricStats(samples)])) };
}

function sameRef(left: Experiment['dataset'], right: Experiment['dataset']): boolean { return left.id === right.id && left.version.compare(right.version) === 0; }
function compareNumber(baseline: number, candidate: number, preference: MetricPreference): ComparisonDirection {
  const delta = candidate - baseline;
  if (Math.abs(delta) < 1e-12) return 'unchanged';
  return preference === 'higher' ? (delta > 0 ? 'improved' : 'regressed') : (delta < 0 ? 'improved' : 'regressed');
}
function averageScore(result: ExperimentCaseResult): number | undefined { return result.scores.length === 0 ? undefined : result.scores.reduce((sum, score) => sum + score.score, 0) / result.scores.length; }

export function compareExperiments(
  baseline: Experiment,
  baselineResults: readonly ExperimentCaseResult[],
  candidate: Experiment,
  candidateResults: readonly ExperimentCaseResult[],
): ExperimentComparison {
  if (baseline.status !== 'completed' || candidate.status !== 'completed') throw new EvaluationDomainError('compareExperiments: both experiments must be completed');
  if (!sameRef(baseline.dataset, candidate.dataset) || !sameRef(baseline.evaluatorProfile, candidate.evaluatorProfile) || baseline.repetitions !== candidate.repetitions) {
    throw new EvaluationDomainError('compareExperiments: dataset, evaluator profile, and repetitions must match');
  }
  const baselineAggregate = aggregateExperiment(baseline.id, baselineResults); const candidateAggregate = aggregateExperiment(candidate.id, candidateResults);
  const metricNames = new Set([...Object.keys(baselineAggregate.metrics), ...Object.keys(candidateAggregate.metrics)]);
  const metrics = [...metricNames].sort().map((metric): MetricComparison => {
    const baselineMetric = baselineAggregate.metrics[metric]; const candidateMetric = candidateAggregate.metrics[metric]; const preference = metricPreference(metric);
    if (baselineMetric === undefined || candidateMetric === undefined) return { metric, preference, ...(baselineMetric !== undefined ? { baseline: baselineMetric } : {}), ...(candidateMetric !== undefined ? { candidate: candidateMetric } : {}), direction: 'incomparable' };
    return { metric, preference, baseline: baselineMetric, candidate: candidateMetric, delta: round(candidateMetric.mean - baselineMetric.mean), direction: compareNumber(baselineMetric.mean, candidateMetric.mean, preference) };
  });
  const baselineByKey = new Map(baselineResults.map((result) => [`${result.caseId}\0${result.repetition}`, result]));
  const candidateByKey = new Map(candidateResults.map((result) => [`${result.caseId}\0${result.repetition}`, result]));
  const keys = new Set([...baselineByKey.keys(), ...candidateByKey.keys()]);
  const cases = [...keys].sort().map((key): CaseComparison => {
    const baselineResult = baselineByKey.get(key); const candidateResult = candidateByKey.get(key); const [caseId = '', rawRepetition = '0'] = key.split('\0');
    if (baselineResult === undefined || candidateResult === undefined) return { caseId, repetition: Number(rawRepetition), ...(baselineResult !== undefined ? { baselineStatus: baselineResult.status } : {}), ...(candidateResult !== undefined ? { candidateStatus: candidateResult.status } : {}), direction: 'incomparable' };
    const baselineScore = averageScore(baselineResult); const candidateScore = averageScore(candidateResult);
    let direction: ComparisonDirection;
    if (baselineResult.status !== candidateResult.status) direction = candidateResult.status === 'succeeded' ? 'improved' : baselineResult.status === 'succeeded' ? 'regressed' : 'incomparable';
    else if (baselineScore === undefined || candidateScore === undefined) direction = baselineResult.status === 'succeeded' ? 'unchanged' : 'incomparable';
    else direction = compareNumber(baselineScore, candidateScore, 'higher');
    return { caseId, repetition: baselineResult.repetition, baselineStatus: baselineResult.status, candidateStatus: candidateResult.status, ...(baselineScore !== undefined ? { baselineScore: round(baselineScore) } : {}), ...(candidateScore !== undefined ? { candidateScore: round(candidateScore) } : {}), ...(baselineScore !== undefined && candidateScore !== undefined ? { delta: round(candidateScore - baselineScore) } : {}), direction };
  });
  return { baselineExperimentId: baseline.id, candidateExperimentId: candidate.id, baseline: baselineAggregate, candidate: candidateAggregate, metrics, cases };
}

export type GateRule =
  | { readonly id: GateRuleId; readonly kind: 'metric-threshold'; readonly metric: string; readonly operator: 'gte' | 'lte'; readonly threshold: number }
  | { readonly id: GateRuleId; readonly kind: 'max-regression'; readonly metric: string; readonly maxRegression: number }
  | { readonly id: GateRuleId; readonly kind: 'required-case-pass'; readonly tags: readonly string[] };

export interface GatePolicy { readonly metadata: EvaluationAssetMetadata & { readonly internalId: GatePolicyId }; readonly rules: readonly GateRule[]; readonly reportTtlHours: number }
export interface GateRuleResult { readonly ruleId: GateRuleId; readonly passed: boolean; readonly observed?: number; readonly message: string }
export interface GateReport {
  readonly id: GateReportId; readonly scope: TenantScope; readonly policy: { readonly id: GatePolicyId; readonly version: SemVer };
  readonly baselineExperimentId?: ExperimentId; readonly candidateExperimentId: ExperimentId; readonly status: 'pass' | 'fail';
  readonly ruleResults: readonly GateRuleResult[]; readonly createdAt: IsoDateTime; readonly expiresAt: IsoDateTime;
}

export function createGatePolicy(props: GatePolicy): GatePolicy {
  const metadata = validateEvaluationMetadata(props.metadata, 'createGatePolicy');
  if (!Array.isArray(props.rules) || props.rules.length === 0) throw new EvaluationDomainError('createGatePolicy: rules must contain at least one rule');
  if (!Number.isInteger(props.reportTtlHours) || props.reportTtlHours < 1 || props.reportTtlHours > 24 * 90) throw new EvaluationDomainError('createGatePolicy: reportTtlHours must be between 1 and 2160');
  const ids = new Set<string>();
  const rules = props.rules.map((rule, index): GateRule => {
    evaluationNonEmpty(rule?.id, `createGatePolicy: rules.${index}.id`); if (ids.has(rule.id)) throw new EvaluationDomainError(`createGatePolicy: duplicate rule id: ${rule.id}`); ids.add(rule.id);
    if (rule.kind === 'metric-threshold') { evaluationNonEmpty(rule.metric, `createGatePolicy: rules.${index}.metric`); if (rule.operator !== 'gte' && rule.operator !== 'lte') throw new EvaluationDomainError(`createGatePolicy: rules.${index}.operator is invalid`); if (!Number.isFinite(rule.threshold)) throw new EvaluationDomainError(`createGatePolicy: rules.${index}.threshold must be finite`); return { ...rule }; }
    if (rule.kind === 'max-regression') { evaluationNonEmpty(rule.metric, `createGatePolicy: rules.${index}.metric`); if (!Number.isFinite(rule.maxRegression) || rule.maxRegression < 0) throw new EvaluationDomainError(`createGatePolicy: rules.${index}.maxRegression must be non-negative`); return { ...rule }; }
    if (rule.kind === 'required-case-pass') { const seen = new Set<string>(); const tags = rule.tags.map((tag: string, tagIndex: number) => { evaluationNonEmpty(tag, `createGatePolicy: rules.${index}.tags.${tagIndex}`); if (seen.has(tag)) throw new EvaluationDomainError(`createGatePolicy: rules.${index}.tags contains duplicate value: ${tag}`); seen.add(tag); return tag; }); return { ...rule, tags }; }
    throw new EvaluationDomainError(`createGatePolicy: rules.${index}.kind is invalid`);
  });
  return { metadata, rules, reportTtlHours: props.reportTtlHours };
}

function ruleResult(rule: GateRule, candidate: ExperimentAggregate, comparison: ExperimentComparison | undefined, results: readonly ExperimentCaseResult[], dataset: EvaluationDataset, repetitions: number): GateRuleResult {
  if (rule.kind === 'metric-threshold') {
    const observed = candidate.metrics[rule.metric]?.mean;
    if (observed === undefined) return { ruleId: rule.id, passed: false, message: `metric '${rule.metric}' is missing` };
    const passed = rule.operator === 'gte' ? observed >= rule.threshold : observed <= rule.threshold;
    return { ruleId: rule.id, passed, observed, message: `${rule.metric} ${observed} ${passed ? 'meets' : 'does not meet'} ${rule.operator} ${rule.threshold}` };
  }
  if (rule.kind === 'max-regression') {
    const metric = comparison?.metrics.find((entry) => entry.metric === rule.metric);
    if (metric?.baseline === undefined || metric.candidate === undefined) return { ruleId: rule.id, passed: false, message: `baseline comparison for metric '${rule.metric}' is missing` };
    const regression = metric.preference === 'higher' ? metric.baseline.mean - metric.candidate.mean : metric.candidate.mean - metric.baseline.mean;
    const observed = Math.max(0, round(regression)); const passed = observed <= rule.maxRegression;
    return { ruleId: rule.id, passed, observed, message: `${rule.metric} regression ${observed} ${passed ? 'is within' : 'exceeds'} ${rule.maxRegression}` };
  }
  const requiredCases = dataset.cases.filter((entry) => rule.tags.every((tag) => entry.tags.includes(tag)));
  if (requiredCases.length === 0) return { ruleId: rule.id, passed: false, message: `no cases match required tags: ${rule.tags.join(', ') || '(all cases)'}` };
  const ids = new Set(requiredCases.map((entry) => entry.id)); const matched = results.filter((result) => ids.has(result.caseId));
  const passed = matched.length === requiredCases.length * repetitions && matched.every((result) => result.status === 'succeeded');
  return { ruleId: rule.id, passed, observed: matched.filter((result) => result.status === 'succeeded').length / Math.max(1, matched.length), message: `${matched.filter((result) => result.status === 'succeeded').length}/${matched.length} required case runs succeeded` };
}

export function evaluateGate(props: { readonly id: string; readonly policy: GatePolicy; readonly candidate: Experiment; readonly candidateResults: readonly ExperimentCaseResult[]; readonly dataset: EvaluationDataset; readonly baseline?: Experiment; readonly baselineResults?: readonly ExperimentCaseResult[]; readonly requiredJudgeMetrics?: readonly string[]; readonly now: string }): GateReport {
  if (props.candidate.status !== 'completed') throw new EvaluationDomainError('evaluateGate: candidate experiment must be completed');
  if (props.candidateResults.length !== props.candidate.progress.total) throw new EvaluationDomainError('evaluateGate: candidate case results are incomplete');
  const candidate = aggregateExperiment(props.candidate.id, props.candidateResults);
  const comparison = props.baseline === undefined ? undefined : compareExperiments(props.baseline, props.baselineResults ?? [], props.candidate, props.candidateResults);
  const requiredJudgeResults = (props.requiredJudgeMetrics ?? []).map((metricId): GateRuleResult => { const passed = props.candidateResults.every((result) => result.judgeEvaluations?.some((record) => record.metricId === metricId && record.required && record.status === 'succeeded') === true); return { ruleId: `required-judge:${metricId}`, passed, message: passed ? `required judge metric '${metricId}' succeeded for every case` : `required judge metric '${metricId}' failed or is missing` }; });
  const ruleResults = [...requiredJudgeResults, ...props.policy.rules.map((rule) => ruleResult(rule, candidate, comparison, props.candidateResults, props.dataset, props.candidate.repetitions))];
  const created = new Date(props.now); if (Number.isNaN(created.valueOf())) throw new EvaluationDomainError('evaluateGate: now must be an ISO timestamp');
  const expiresAt = new Date(created.valueOf() + props.policy.reportTtlHours * 3_600_000).toISOString();
  return createGateReport({ id: props.id, scope: props.candidate.scope, policy: { id: props.policy.metadata.internalId, version: props.policy.metadata.version }, ...(props.baseline !== undefined ? { baselineExperimentId: props.baseline.id } : {}), candidateExperimentId: props.candidate.id, status: ruleResults.every((result) => result.passed) ? 'pass' : 'fail', ruleResults, createdAt: created.toISOString(), expiresAt });
}

export function createGateReport(report: GateReport): GateReport {
  evaluationNonEmpty(report.id, 'createGateReport: id'); evaluationNonEmpty(report.scope?.tenantId, 'createGateReport: scope.tenantId'); evaluationNonEmpty(report.scope?.workspaceId, 'createGateReport: scope.workspaceId'); evaluationNonEmpty(report.policy?.id, 'createGateReport: policy.id');
  if (!(report.policy.version instanceof SemVer)) throw new EvaluationDomainError('createGateReport: policy.version must be a SemVer instance');
  evaluationNonEmpty(report.candidateExperimentId, 'createGateReport: candidateExperimentId'); if (report.status !== 'pass' && report.status !== 'fail') throw new EvaluationDomainError('createGateReport: status is invalid');
  if (report.ruleResults.length === 0) throw new EvaluationDomainError('createGateReport: ruleResults must not be empty');
  report.ruleResults.forEach((result, index) => { evaluationNonEmpty(result.ruleId, `createGateReport: ruleResults.${index}.ruleId`); evaluationNonEmpty(result.message, `createGateReport: ruleResults.${index}.message`); if (typeof result.passed !== 'boolean' || (result.observed !== undefined && !Number.isFinite(result.observed))) throw new EvaluationDomainError(`createGateReport: ruleResults.${index} is invalid`); });
  if (!Number.isFinite(Date.parse(report.createdAt)) || !Number.isFinite(Date.parse(report.expiresAt)) || Date.parse(report.expiresAt) <= Date.parse(report.createdAt)) throw new EvaluationDomainError('createGateReport: timestamps are invalid');
  return { ...report, scope: { ...report.scope }, policy: { ...report.policy }, ruleResults: report.ruleResults.map((result) => ({ ...result })) };
}

export type PromotionStatus = 'pending' | 'approved' | 'rejected';
export interface PromotionRequest {
  readonly id: PromotionRequestId; readonly scope: TenantScope; readonly agent: { readonly id: AgentId; readonly version: SemVer }; readonly gateReportId: GateReportId;
  readonly status: PromotionStatus; readonly requestedBy: string; readonly requestedAt: IsoDateTime; readonly decidedBy?: string; readonly decidedAt?: IsoDateTime; readonly reason?: string;
}
export function createPromotionRequest(request: PromotionRequest): PromotionRequest {
  evaluationNonEmpty(request.id, 'createPromotionRequest: id'); evaluationNonEmpty(request.scope?.tenantId, 'createPromotionRequest: scope.tenantId'); evaluationNonEmpty(request.scope?.workspaceId, 'createPromotionRequest: scope.workspaceId'); evaluationNonEmpty(request.agent?.id, 'createPromotionRequest: agent.id'); if (!(request.agent.version instanceof SemVer)) throw new EvaluationDomainError('createPromotionRequest: agent.version must be a SemVer instance');
  evaluationNonEmpty(request.gateReportId, 'createPromotionRequest: gateReportId'); evaluationNonEmpty(request.requestedBy, 'createPromotionRequest: requestedBy'); if (!Number.isFinite(Date.parse(request.requestedAt))) throw new EvaluationDomainError('createPromotionRequest: requestedAt is invalid');
  if (!['pending', 'approved', 'rejected'].includes(request.status)) throw new EvaluationDomainError('createPromotionRequest: status is invalid');
  if (request.status !== 'pending') { evaluationNonEmpty(request.decidedBy, 'createPromotionRequest: decidedBy'); if (request.decidedAt === undefined || !Number.isFinite(Date.parse(request.decidedAt))) throw new EvaluationDomainError('createPromotionRequest: decidedAt is invalid'); }
  return { ...request, scope: { ...request.scope }, agent: { ...request.agent } };
}
export function decidePromotion(request: PromotionRequest, decision: 'approved' | 'rejected', decidedBy: string, decidedAt: IsoDateTime, reason?: string): PromotionRequest {
  if (request.status !== 'pending') throw new EvaluationDomainError(`decidePromotion: request '${request.id}' is already ${request.status}`);
  evaluationNonEmpty(decidedBy, 'decidePromotion: decidedBy'); if (!Number.isFinite(Date.parse(decidedAt))) throw new EvaluationDomainError('decidePromotion: decidedAt is invalid');
  return createPromotionRequest({ ...request, status: decision, decidedBy, decidedAt, ...(reason !== undefined ? { reason } : {}) });
}
