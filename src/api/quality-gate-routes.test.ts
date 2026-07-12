import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../domain/agent/agent';
import { createEvaluationDataset } from '../domain/evaluation/evaluation-dataset';
import { createExperiment, createExperimentCaseResult, type ExperimentCaseResult } from '../domain/evaluation/experiment';
import { SemVer } from '../domain/tool/semver';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';
import type { FastifyInstance } from 'fastify';
import { createEvaluatorProfile } from '../domain/evaluation/evaluator-profile';
import { createJudgeRubric } from '../domain/evaluation/judge-rubric';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' }; const v1 = SemVer.of(1, 0, 0); const v2 = SemVer.of(2, 0, 0);
const metadata = (id: string, version = v1) => ({ internalId: id, workingName: id, displayName: id, publishName: id.replaceAll('-', '_'), version, owner: 'owner', state: 'draft' as const, tenant: scope });
const experiment = (id: string, agentId: string, version: SemVer) => createExperiment({ id, scope, target: { agentId, version }, dataset: { id: 'set', version: v1 }, evaluatorProfile: { id: 'profile', version: v1 }, repetitions: 1, status: 'completed', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 1, total: 1 }, createdAt: '2026-07-10T00:00:00Z', finishedAt: '2026-07-10T00:00:01Z' });
const result = (experimentId: string, score: number): ExperimentCaseResult => createExperimentCaseResult({ experimentId, scope, caseId: 'critical', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: [`run-${experimentId}`], scores: [{ metric: 'quality', score }], latencyMs: 10, usage: { totalTokens: 10 } });

describe('quality gate routes', () => {
  let app: App; let server: FastifyInstance;
  beforeEach(async () => {
    app = createApp({ profile: 'test' }); server = buildServer(app);
    await app.agentRepo.save(createAgent({ metadata: metadata('agent', v1), kind: 'normal', systemPrompt: 'baseline', tools: [] }));
    await app.agentRepo.save(createAgent({ metadata: metadata('agent', v2), kind: 'normal', systemPrompt: 'candidate', tools: [] }));
    await app.evaluationDatasetRepo.save(createEvaluationDataset({ metadata: metadata('set'), cases: [{ id: 'critical', kind: 'turn', input: 'x', tags: ['critical'], source: 'manual' }] }));
    await app.evaluatorProfileRepo.save(createEvaluatorProfile({ metadata: metadata('profile'), metrics: [{ id: 'quality', kind: 'code', scorer: 'completeness', weight: 1, required: true }] }));
    for (const entry of [experiment('baseline', 'agent', v1), experiment('candidate', 'agent', v2), experiment('degraded', 'agent', v2)]) await app.experimentRepo.create(entry);
    await app.experimentRepo.saveCaseResult(result('baseline', 0.7)); await app.experimentRepo.saveCaseResult(result('candidate', 0.9)); await app.experimentRepo.saveCaseResult(result('degraded', 0.4));
  });
  afterEach(async () => { await server.close(); app.close(); });

  it('比較、gate pass、昇格申請、承認を通してpublishedへ遷移する', async () => {
    const comparison = await server.inject({ method: 'POST', url: '/experiment-comparisons', payload: { scope, baselineExperimentId: 'baseline', candidateExperimentId: 'candidate' } });
    expect(comparison.statusCode).toBe(200); expect(comparison.json().comparison.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'quality', direction: 'improved' })]));
    const saved = await server.inject({ method: 'POST', url: '/gate-policies', payload: { scope, internalId: 'release', workingName: 'Release', displayName: 'Release', publishName: 'release', owner: 'owner', rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }, { id: 'regression', kind: 'max-regression', metric: 'quality', maxRegression: 0 }, { id: 'critical', kind: 'required-case-pass', tags: ['critical'] }] } });
    expect(saved.statusCode).toBe(201); expect(saved.json().policy.metadata.version).toBe('1.0.0');
    expect((await server.inject({ method: 'GET', url: '/gate-policies?tenantId=tenant&workspaceId=workspace' })).json().policies).toHaveLength(1);
    expect((await server.inject({ method: 'GET', url: '/gate-policies/release/versions?tenantId=tenant&workspaceId=workspace' })).json().versions).toEqual(['1.0.0']);
    expect((await server.inject({ method: 'GET', url: '/gate-policies/release?tenantId=tenant&workspaceId=workspace&version=1.0.0' })).statusCode).toBe(200);
    const evaluated = await server.inject({ method: 'POST', url: '/gate-reports', payload: { scope, policy: { id: 'release', version: '1.0.0' }, baselineExperimentId: 'baseline', candidateExperimentId: 'candidate' } });
    expect(evaluated.statusCode).toBe(201); const report = evaluated.json().report; expect(report.status).toBe('pass');
    expect(await app.qualityGateExitCode.execute(scope, 'candidate')).toBe(0);
    expect((await server.inject({ method: 'GET', url: '/gate-reports?tenantId=tenant&workspaceId=workspace&candidateExperimentId=candidate' })).json().reports).toHaveLength(1);
    expect((await server.inject({ method: 'GET', url: `/gate-reports/${report.id}?tenantId=tenant&workspaceId=workspace` })).statusCode).toBe(200);
    const requested = await server.inject({ method: 'POST', url: '/agents/agent/versions/2.0.0/promotion-requests', payload: { scope, gateReportId: report.id, requestedBy: 'alice' } });
    expect(requested.statusCode).toBe(201); const promotion = requested.json().promotion; expect(promotion.status).toBe('pending'); expect((await app.agentRepo.findVersion(scope, 'agent', v2))?.metadata.state).toBe('in-review');
    expect((await server.inject({ method: 'GET', url: '/promotion-requests?tenantId=tenant&workspaceId=workspace&agentId=agent' })).json().promotions).toHaveLength(1);
    const approved = await server.inject({ method: 'POST', url: `/promotion-requests/${promotion.id}/approve`, payload: { scope, decidedBy: 'reviewer' } });
    expect(approved.json().promotion.status).toBe('approved'); expect((await app.agentRepo.findVersion(scope, 'agent', v2))?.metadata.state).toBe('published');
    const relaxed = await app.saveGatePolicy.execute({ scope, internalId: 'relaxed', workingName: 'Relaxed', displayName: 'Relaxed', publishName: 'relaxed', owner: 'owner', rules: [{ id: 'quality', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.5 }] });
    const baselineReport = await server.inject({ method: 'POST', url: '/gate-reports', payload: { scope, policy: { id: 'relaxed', version: relaxed.metadata.version.toString() }, candidateExperimentId: 'baseline' } }); expect(baselineReport.json().report.status).toBe('pass');
    const secondRequest = await server.inject({ method: 'POST', url: '/agents/agent/versions/1.0.0/promotion-requests', payload: { scope, gateReportId: baselineReport.json().report.id, requestedBy: 'alice' } });
    const rejected = await server.inject({ method: 'POST', url: `/promotion-requests/${secondRequest.json().promotion.id}/reject`, payload: { scope, decidedBy: 'reviewer', reason: 'needs work' } });
    expect(rejected.json().promotion).toMatchObject({ status: 'rejected', reason: 'needs work' }); expect((await app.agentRepo.findVersion(scope, 'agent', v1))?.metadata.state).toBe('draft');
    expect((await server.inject({ method: 'GET', url: '/gate-reports?tenantId=tenant&workspaceId=workspace' })).json().reports).toHaveLength(2);
    expect((await server.inject({ method: 'GET', url: '/promotion-requests?tenantId=tenant&workspaceId=workspace' })).json().promotions).toHaveLength(2);
    expect((await server.inject({ method: 'GET', url: '/gate-policies/release?tenantId=tenant&workspaceId=workspace' })).statusCode).toBe(200);
  });

  it('劣化candidateをgateで拒否し、不正入力を安全に扱う', async () => {
    const policy = await app.saveGatePolicy.execute({ scope, internalId: 'strict', workingName: 'Strict', displayName: 'Strict', publishName: 'strict', owner: 'owner', rules: [{ id: 'quality', kind: 'max-regression', metric: 'quality', maxRegression: 0.05 }] });
    const failed = await server.inject({ method: 'POST', url: '/gate-reports', payload: { scope, policy: { id: 'strict', version: policy.metadata.version.toString() }, baselineExperimentId: 'baseline', candidateExperimentId: 'degraded' } });
    expect(failed.json().report.status).toBe('fail'); expect(await app.qualityGateExitCode.execute(scope, 'degraded')).toBe(1); expect(await app.qualityGateExitCode.execute(scope, 'missing')).toBe(2);
    const promotion = await server.inject({ method: 'POST', url: '/agents/agent/versions/2.0.0/promotion-requests', payload: { scope, gateReportId: failed.json().report.id, requestedBy: 'alice' } }); expect(promotion.statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/gate-reports', payload: { scope, policy: { id: 'strict', version: 'bad' }, candidateExperimentId: 'degraded' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: '/gate-reports/missing?tenantId=tenant&workspaceId=workspace' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/gate-policies', payload: { scope, rules: [] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/agents/agent/versions/not-semver/promotion-requests', payload: { scope, gateReportId: failed.json().report.id, requestedBy: 'alice' } })).statusCode).toBe(400);
  });

  it('required Judge障害はgate fail、optional Judge障害は欠損として許可する', async () => {
    await app.judgeRubricRepo.save(createJudgeRubric({ metadata: metadata('rubric'), instructions: 'Judge.', referencePolicy: 'optional', reasonRequired: true, criteria: [{ id: 'q', label: 'Q', description: 'Quality', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] }));
    const gate = await app.saveGatePolicy.execute({ scope, internalId: 'judge-gate', workingName: 'Judge', displayName: 'Judge', publishName: 'judge_gate', owner: 'owner', rules: [{ id: 'success', kind: 'metric-threshold', metric: 'case-success-rate', operator: 'gte', threshold: 1 }] });
    for (const required of [true, false]) {
      const profileId = required ? 'required-profile' : 'optional-profile'; const experimentId = required ? 'required-judge' : 'optional-judge';
      await app.evaluatorProfileRepo.save(createEvaluatorProfile({ metadata: metadata(profileId), metrics: [{ id: 'judge-quality', kind: 'judge', rubric: { id: 'rubric', version: v1 }, weight: 1, required }] }));
      await app.experimentRepo.create(createExperiment({ ...experiment(experimentId, 'agent', v2), evaluatorProfile: { id: profileId, version: v1 } }));
      await app.experimentRepo.saveCaseResult(createExperimentCaseResult({ ...result(experimentId, 1), scores: [], judgeEvaluations: [{ scorer: 'llm-as-judge', metricId: 'judge-quality', rubric: { id: 'rubric', version: v1 }, required, model: { provider: 'judge', model: 'judge-model', modelConfigHash: 'judge-hash' }, status: 'failed', error: { code: 'JUDGE_SCHEMA', message: 'invalid JSON' } }] }));
      const response = await server.inject({ method: 'POST', url: '/gate-reports', payload: { scope, policy: { id: gate.metadata.internalId, version: gate.metadata.version.toString() }, candidateExperimentId: experimentId } });
      expect(response.json().report.status).toBe(required ? 'fail' : 'pass');
    }
  });
});
