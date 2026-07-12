import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { createEvaluationDataset } from './evaluation-dataset';
import { createExperiment, createExperimentCaseResult, type ExperimentCaseResult } from './experiment';
import { EvaluationDomainError } from './errors';
import { aggregateExperiment, calculateMetricStats, compareExperiments, createGatePolicy, createPromotionRequest, decidePromotion, evaluateGate } from './quality-gate';
import { deserializeGatePolicy, deserializeGateReport, deserializePromotionRequest, serializeGatePolicy, serializeGateReport, serializePromotionRequest } from './quality-gate-serialization';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' }; const v = SemVer.of(1, 0, 0);
const metadata = { internalId: 'gate', workingName: 'Gate', displayName: 'Gate', publishName: 'gate', version: v, owner: 'owner', state: 'draft' as const, tenant: scope };
const experiment = (id: string, agentId: string) => createExperiment({ id, scope, target: { agentId, version: v }, dataset: { id: 'set', version: v }, evaluatorProfile: { id: 'profile', version: v }, repetitions: 2, status: 'completed', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 4, total: 4 }, createdAt: '2026-07-10T00:00:00.000Z', finishedAt: '2026-07-10T00:00:01.000Z' });
const result = (experimentId: string, caseId: string, repetition: number, score: number, status: ExperimentCaseResult['status'] = 'succeeded') => createExperimentCaseResult({ experimentId, scope, caseId, caseKind: 'turn', repetition, status, runIds: [`run-${experimentId}-${caseId}-${repetition}`], scores: [{ metric: 'quality', score }, { metric: 'goal-achieved', score }], latencyMs: experimentId === 'candidate' ? 80 : 100, usage: { totalTokens: experimentId === 'candidate' ? 8 : 10 }, ...(status === 'failed' ? { error: { code: 'FAILED', message: 'failed', retryable: false } } : {}) });
const results = (id: string, score: number): ExperimentCaseResult[] => [result(id, 'critical', 1, score), result(id, 'critical', 2, score), result(id, 'normal', 1, score), result(id, 'normal', 2, score)];
const dataset = createEvaluationDataset({ metadata: { ...metadata, internalId: 'set' }, cases: [{ id: 'critical', kind: 'turn', input: 'x', tags: ['critical'], source: 'manual' }, { id: 'normal', kind: 'turn', input: 'y', tags: [], source: 'manual' }] });

describe('quality gate domain', () => {
  it('分布統計とexperiment集計を計算する', () => {
    expect(calculateMetricStats([1, 2, 3, 4])).toEqual({ count: 4, mean: 2.5, median: 2.5, p50: 2.5, p95: 3.85, stddev: 1.11803398875, min: 1, max: 4, samples: [1, 2, 3, 4] });
    const aggregate = aggregateExperiment('baseline', [result('baseline', 'critical', 1, 0.5), result('baseline', 'normal', 1, 0, 'failed')]);
    expect(aggregate.metrics['case-success-rate']?.mean).toBe(0.5); expect(aggregate.metrics['failure-rate']?.mean).toBe(0.5); expect(aggregate.metrics['tokens-per-case']?.mean).toBe(10);
    expect(() => calculateMetricStats([])).toThrow(EvaluationDomainError);
  });

  it('同じfixtureをcase/metric単位で比較し改善・悪化・比較不能を表す', () => {
    const comparison = compareExperiments(experiment('baseline', 'agent-v1'), results('baseline', 0.4), experiment('candidate', 'agent-v2'), results('candidate', 0.8));
    expect(comparison.metrics.find((entry) => entry.metric === 'quality')).toMatchObject({ delta: 0.4, direction: 'improved' });
    expect(comparison.metrics.find((entry) => entry.metric === 'latency-ms')).toMatchObject({ delta: -20, direction: 'improved' });
    expect(comparison.cases).toHaveLength(4); expect(comparison.cases.every((entry) => entry.direction === 'improved')).toBe(true);
    const missing = compareExperiments(experiment('baseline', 'a'), results('baseline', 0.4), experiment('candidate', 'b'), results('candidate', 0.4).slice(1));
    expect(missing.cases.some((entry) => entry.direction === 'incomparable')).toBe(true);
    expect(() => compareExperiments({ ...experiment('baseline', 'a'), status: 'failed' }, [], experiment('candidate', 'b'), [])).toThrow(/completed/);
    expect(() => compareExperiments(experiment('baseline', 'a'), [], { ...experiment('candidate', 'b'), repetitions: 1 }, [])).toThrow(/must match/);
  });

  it('閾値・最大回帰・required tagをfail closedで評価する', () => {
    const policy = createGatePolicy({ metadata, reportTtlHours: 24, rules: [
      { id: 'threshold', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.7 },
      { id: 'regression', kind: 'max-regression', metric: 'quality', maxRegression: 0.05 },
      { id: 'required', kind: 'required-case-pass', tags: ['critical'] },
    ] });
    const passed = evaluateGate({ id: 'report-pass', policy, baseline: experiment('baseline', 'v1'), baselineResults: results('baseline', 0.7), candidate: experiment('candidate', 'v2'), candidateResults: results('candidate', 0.9), dataset, now: '2026-07-10T00:00:00Z' });
    expect(passed.status).toBe('pass'); expect(passed.expiresAt).toBe('2026-07-11T00:00:00.000Z');
    const failedResults = results('candidate', 0.5); failedResults[0] = result('candidate', 'critical', 1, 0.5, 'failed');
    const failed = evaluateGate({ id: 'report-fail', policy, baseline: experiment('baseline', 'v1'), baselineResults: results('baseline', 0.7), candidate: experiment('candidate', 'v2'), candidateResults: failedResults, dataset, now: '2026-07-10T00:00:00Z' });
    expect(failed.status).toBe('fail'); expect(failed.ruleResults.every((entry) => !entry.passed)).toBe(true);
    const noBaseline = evaluateGate({ id: 'report-no-base', policy: createGatePolicy({ metadata, reportTtlHours: 1, rules: [{ id: 'missing', kind: 'max-regression', metric: 'quality', maxRegression: 0 }] }), candidate: experiment('candidate', 'v2'), candidateResults: results('candidate', 1), dataset, now: '2026-07-10T00:00:00Z' });
    expect(noBaseline).toMatchObject({ status: 'fail', ruleResults: [{ passed: false }] });
    expect(() => evaluateGate({ id: 'incomplete', policy, candidate: experiment('candidate', 'v2'), candidateResults: results('candidate', 1).slice(1), dataset, now: '2026-07-10T00:00:00Z' })).toThrow(/incomplete/);
    const judgeFailed = results('candidate', 1).map((entry) => createExperimentCaseResult({ ...entry, judgeEvaluations: [{ scorer: 'llm-as-judge', metricId: 'judge-quality', rubric: { id: 'rubric', version: v }, required: true, model: { provider: 'judge', model: 'model', modelConfigHash: 'hash' }, status: 'failed', error: { code: 'JUDGE_SCHEMA', message: 'broken' } }] }));
    expect(evaluateGate({ id: 'judge-fail', policy: createGatePolicy({ metadata, reportTtlHours: 1, rules: [{ id: 'success', kind: 'metric-threshold', metric: 'case-success-rate', operator: 'gte', threshold: 1 }] }), candidate: experiment('candidate', 'v2'), candidateResults: judgeFailed, dataset, requiredJudgeMetrics: ['judge-quality'], now: '2026-07-10T00:00:00Z' })).toMatchObject({ status: 'fail', ruleResults: expect.arrayContaining([expect.objectContaining({ ruleId: 'required-judge:judge-quality', passed: false })]) });
  });

  it('policy/report/promotionを検証して直列化し、decisionを一度だけ許可する', () => {
    const policy = createGatePolicy({ metadata, reportTtlHours: 24, rules: [{ id: 'q', kind: 'metric-threshold', metric: 'quality', operator: 'lte', threshold: 1 }] });
    expect(deserializeGatePolicy(serializeGatePolicy(policy))).toEqual(policy);
    const report = evaluateGate({ id: 'report', policy, candidate: experiment('candidate', 'v2'), candidateResults: results('candidate', 1), dataset, now: '2026-07-10T00:00:00Z' });
    expect(deserializeGateReport(serializeGateReport(report))).toEqual(report);
    const request = createPromotionRequest({ id: 'promotion', scope, agent: { id: 'agent', version: v }, gateReportId: report.id, status: 'pending', requestedBy: 'alice', requestedAt: '2026-07-10T00:00:00Z' });
    expect(deserializePromotionRequest(serializePromotionRequest(request))).toEqual(request);
    const approved = decidePromotion(request, 'approved', 'reviewer', '2026-07-10T01:00:00Z'); expect(approved).toMatchObject({ status: 'approved', decidedBy: 'reviewer' });
    expect(() => decidePromotion(approved, 'rejected', 'reviewer', '2026-07-10T02:00:00Z')).toThrow(/already approved/);
    expect(() => createGatePolicy({ metadata, reportTtlHours: 0, rules: [{ id: 'x', kind: 'required-case-pass', tags: [] }] })).toThrow(/reportTtlHours/);
    expect(() => createGatePolicy({ metadata, reportTtlHours: 1, rules: [{ id: 'x', kind: 'required-case-pass', tags: ['critical', 'critical'] }] })).toThrow(/duplicate/);
    expect(() => createPromotionRequest({ ...request, status: 'approved' })).toThrow(/decidedBy/);
  });
});
