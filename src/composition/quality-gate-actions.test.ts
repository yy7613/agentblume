import { describe, expect, it } from 'vitest';
import { InMemoryAgentRepository } from '../adapters/storage/in-memory-agent-repository';
import { InMemoryEvaluationDatasetRepository } from '../adapters/storage/in-memory-evaluation-dataset-repository';
import { InMemoryExperimentRepository } from '../adapters/storage/in-memory-experiment-repository';
import { InMemoryQualityGateRepository } from '../adapters/storage/in-memory-quality-gate-repository';
import { DecidePromotionUseCase, EvaluateQualityGateUseCase, QualityGateExitCodeUseCase, QueryQualityGatesUseCase, RequestPromotionUseCase, SaveGatePolicyUseCase } from '../application/evaluation/quality-gate-actions';
import { createAgent } from '../domain/agent/agent';
import { createEvaluationDataset } from '../domain/evaluation/evaluation-dataset';
import { createExperiment, createExperimentCaseResult } from '../domain/evaluation/experiment';
import { EvaluationDomainError, QualityGateNotFoundError } from '../domain/evaluation/errors';
import { SemVer } from '../domain/tool/semver';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' }; const v1 = SemVer.of(1, 0, 0); const v2 = SemVer.of(2, 0, 0);
describe('quality gate actions', () => {
  it('policy改訂、report照会、期限・対象版検証、差し戻しを扱う', async () => {
    const gates = new InMemoryQualityGateRepository(); const experiments = new InMemoryExperimentRepository(); const datasets = new InMemoryEvaluationDatasetRepository(); const agents = new InMemoryAgentRepository();
    const metadata = (id: string, version = v1) => ({ internalId: id, workingName: id, displayName: id, publishName: id, version, owner: 'owner', state: 'draft' as const, tenant: scope });
    await datasets.save(createEvaluationDataset({ metadata: metadata('set'), cases: [{ id: 'case', kind: 'turn', input: 'x', tags: [], source: 'manual' }] }));
    await agents.save(createAgent({ metadata: metadata('agent'), kind: 'normal', systemPrompt: 'prompt', tools: [] })); await agents.save(createAgent({ metadata: metadata('agent', v2), kind: 'normal', systemPrompt: 'prompt 2', tools: [] }));
    await experiments.create(createExperiment({ id: 'candidate', scope, target: { agentId: 'agent', version: v1 }, dataset: { id: 'set', version: v1 }, evaluatorProfile: { id: 'profile', version: v1 }, repetitions: 1, status: 'completed', snapshot: { provider: 'test', model: 'model', modelConfigHash: 'hash' }, progress: { completed: 1, total: 1 }, createdAt: '2026-07-10T00:00:00Z', finishedAt: '2026-07-10T00:00:01Z' }));
    await experiments.saveCaseResult(createExperimentCaseResult({ experimentId: 'candidate', scope, caseId: 'case', caseKind: 'turn', repetition: 1, status: 'succeeded', runIds: ['run'], scores: [{ metric: 'quality', score: 0.9 }], latencyMs: 1, usage: {} }));
    const save = new SaveGatePolicyUseCase(gates); const base = { scope, internalId: 'release', workingName: 'Release', displayName: 'Release', publishName: 'release', owner: 'owner', rules: [{ id: 'quality', kind: 'metric-threshold' as const, metric: 'quality', operator: 'gte' as const, threshold: 0.8 }] };
    expect((await save.execute(base)).metadata.version.toString()).toBe('1.0.0'); const policy = await save.execute({ ...base, bump: 'minor' }); expect(policy.metadata.version.toString()).toBe('1.1.0');
    const report = await new EvaluateQualityGateUseCase(gates, experiments, datasets, () => 'report', () => new Date('2026-07-10T00:00:00Z')).execute({ scope, policy: { id: 'release', version: policy.metadata.version }, candidateExperimentId: 'candidate' });
    const query = new QueryQualityGatesUseCase(gates); expect(await query.listPolicies(scope)).toHaveLength(1); expect(await query.policyVersions(scope, 'release')).toHaveLength(2); expect((await query.getPolicy(scope, 'release')).metadata.version.toString()).toBe('1.1.0'); expect(await query.getReport(scope, report.id)).toEqual(report);
    await expect(query.getPolicy(scope, 'missing')).rejects.toBeInstanceOf(QualityGateNotFoundError); await expect(query.getPromotion(scope, 'missing')).rejects.toBeInstanceOf(QualityGateNotFoundError);
    const requestUseCase = new RequestPromotionUseCase(gates, experiments, agents, () => 'promotion', () => new Date('2026-07-10T01:00:00Z'));
    await expect(requestUseCase.execute({ scope, agentId: 'agent', version: v2, gateReportId: report.id, requestedBy: 'alice' })).rejects.toThrow(/does not match/);
    const request = await requestUseCase.execute({ scope, agentId: 'agent', version: v1, gateReportId: report.id, requestedBy: 'alice' }); expect(await query.getPromotion(scope, request.id)).toEqual(request); expect(await query.listPromotions(scope)).toHaveLength(1);
    const rejected = await new DecidePromotionUseCase(gates, agents, () => new Date('2026-07-10T02:00:00Z')).execute({ scope, requestId: request.id, decision: 'rejected', decidedBy: 'reviewer' }); expect(rejected.status).toBe('rejected'); expect((await agents.findVersion(scope, 'agent', v1))?.metadata.state).toBe('draft');
    await expect(new RequestPromotionUseCase(gates, experiments, agents, () => 'late', () => new Date('2026-07-20T00:00:00Z')).execute({ scope, agentId: 'agent', version: v1, gateReportId: report.id, requestedBy: 'alice' })).rejects.toBeInstanceOf(EvaluationDomainError);
    expect(await new QualityGateExitCodeUseCase(gates, experiments, () => new Date('2026-07-20T00:00:00Z')).execute(scope, 'candidate')).toBe(2);
  });
});
