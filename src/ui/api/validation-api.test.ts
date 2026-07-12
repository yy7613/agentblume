import { describe, expect, it, vi } from 'vitest';
import { ToolApiClient } from './tool-api';
import type { SaveEvaluationDatasetDto, SaveEvaluatorProfileDto, SaveGatePolicyDto, SaveJudgeRubricDto, SavePersonaDto, SaveScenarioDto } from './types';

const scope = { tenantId: 'tenant a', workspaceId: 'workspace/1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ToolApiClient scenario validation contract', () => {
  it('Persona save・一覧・version固定取得のwire contractを扱う', async () => {
    const persona = { metadata: { internalId: 'novice-user', version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ persona }, 201))
      .mockResolvedValueOnce(jsonResponse({ personas: [{ internalId: 'novice-user', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ persona }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const input: SavePersonaDto = {
      scope, internalId: 'novice/user', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o',
      archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja', bump: 'minor',
    };
    await client.savePersona(input);
    await expect(client.listPersonas(scope)).resolves.toHaveLength(1);
    await client.getPersona('novice/user', scope, '1.0.0');
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/personas', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/personas?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/personas/novice%2Fuser?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('version=1.0.0');
  });

  it('Scenario save・一覧・取得とAgent version列挙のwire contractを扱う', async () => {
    const scenario = { metadata: { internalId: 'sc', version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ scenario }, 201))
      .mockResolvedValueOnce(jsonResponse({ scenarios: [{ internalId: 'sc', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ scenario }))
      .mockResolvedValueOnce(jsonResponse({ versions: ['1.0.0', '1.1.0'] }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const input: SaveScenarioDto = {
      scope, internalId: 'sc', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o',
      target: { agentId: 'agent', version: '1.0.0' }, persona: { personaId: 'novice-user', version: '1.0.0' },
      goal: 'Get the monthly summary', maxUserTurns: 4, expectedTools: ['summary_tool'],
      survey: [{ id: 'q1', textJa: '達成?', textEn: 'Achieved?', kind: 'boolean' }],
    };
    await client.saveScenario(input);
    await expect(client.listScenarios(scope)).resolves.toHaveLength(1);
    await client.getScenario('sc', scope);
    await expect(client.listAgentVersions('agent/1', scope)).resolves.toEqual(['1.0.0', '1.1.0']);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/scenarios', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(fetcher.mock.calls[2]?.[0]).toContain('/scenarios/sc?');
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('version=');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/agents/agent%2F1/versions?');
  });

  it('Scenario実行とScenarioRun一覧・詳細のwire contractを扱う', async () => {
    const run = { id: 'srun-1', status: 'completed' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ runs: [run] }))
      .mockResolvedValueOnce(jsonResponse({ run }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const body = { scope, version: '1.0.0', mode: 'test' as const };
    await expect(client.runScenario('sc/1', body, controller.signal)).resolves.toMatchObject(run);
    await expect(client.listScenarioRuns(scope, 'sc/1')).resolves.toHaveLength(1);
    await client.getScenarioRun('srun/1', scope);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/scenarios/sc%2F1/run', expect.objectContaining({
      method: 'POST', body: JSON.stringify(body), signal: controller.signal,
    }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/scenario-runs?');
    expect(fetcher.mock.calls[1]?.[0]).toContain('scenarioId=sc%2F1');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/scenario-runs/srun%2F1?');
  });

  it('評価DatasetとEvaluatorProfileの保存・一覧・import/export contractを扱う', async () => {
    const dataset = { metadata: { internalId: 'quality', version: '1.0.0' }, cases: [] };
    const profile = { metadata: { internalId: 'default', version: '1.0.0' }, metrics: [] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ dataset }, 201))
      .mockResolvedValueOnce(jsonResponse({ datasets: [{ internalId: 'quality', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ dataset }))
      .mockResolvedValueOnce(jsonResponse({ cases: [{ id: 'a', kind: 'turn', input: 'x', tags: [], source: 'import' }] }))
      .mockResolvedValueOnce(jsonResponse({ format: 'json', content: '{"cases":[]}' }))
      .mockResolvedValueOnce(jsonResponse({ profile }, 201))
      .mockResolvedValueOnce(jsonResponse({ profiles: [{ internalId: 'default', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ profile }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const datasetInput: SaveEvaluationDatasetDto = { scope, internalId: 'quality', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o', cases: [{ id: 'a', kind: 'turn', input: 'x', tags: [], source: 'manual' }] };
    const profileInput: SaveEvaluatorProfileDto = { scope, internalId: 'default', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o', metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] };
    await client.saveEvaluationDataset(datasetInput);
    await client.listEvaluationDatasets(scope);
    await client.getEvaluationDataset('quality/set', scope, '1.0.0');
    await client.importEvaluationCases(scope, 'json', '[]');
    await expect(client.exportEvaluationDataset('quality/set', scope, 'json', '1.0.0')).resolves.toBe('{"cases":[]}');
    await client.saveEvaluatorProfile(profileInput);
    await client.listEvaluatorProfiles(scope);
    await client.getEvaluatorProfile('default/profile', scope, '1.0.0');
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/evaluation-datasets', expect.objectContaining({ method: 'POST', body: JSON.stringify(datasetInput) }));
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/evaluation-datasets/quality%2Fset?');
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope, format: 'json', content: '[]' }) });
    expect(fetcher.mock.calls[4]?.[0]).toContain('/api/evaluation-datasets/quality%2Fset/export?');
    expect(fetcher).toHaveBeenNthCalledWith(6, '/api/evaluator-profiles', expect.objectContaining({ method: 'POST', body: JSON.stringify(profileInput) }));
    expect(fetcher.mock.calls[7]?.[0]).toContain('/api/evaluator-profiles/default%2Fprofile?');
  });

  it('Experiment create/list/detail/results/cancel/resume contractを扱う', async () => {
    const experiment = { id: 'exp/1', status: 'queued' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ experiment }, 202))
      .mockResolvedValueOnce(jsonResponse({ experiments: [experiment] }))
      .mockResolvedValueOnce(jsonResponse({ experiment: { ...experiment, status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ caseId: 'case' }] }))
      .mockResolvedValueOnce(jsonResponse({ experiment: { ...experiment, status: 'cancelled' } }))
      .mockResolvedValueOnce(jsonResponse({ experiment: { ...experiment, status: 'queued' } }))
      .mockResolvedValueOnce(jsonResponse({ versions: ['1.0.0'] }))
      .mockResolvedValueOnce(jsonResponse({ versions: ['2.0.0'] }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const input = { scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '2.0.0' }, repetitions: 2 };
    await client.createExperiment(input); await client.listExperiments(scope, 'running'); await client.getExperiment('exp/1', scope); await client.listExperimentResults('exp/1', scope); await client.cancelExperiment('exp/1', scope); await client.resumeExperiment('exp/1', scope);
    await client.listEvaluationDatasetVersions('set/1', scope); await client.listEvaluatorProfileVersions('profile/1', scope);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/experiments', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('status=running');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/api/experiments/exp%2F1?');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/api/experiments/exp%2F1/results?');
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope }) });
    expect(fetcher.mock.calls[5]?.[0]).toBe('/api/experiments/exp%2F1/resume');
    expect(fetcher.mock.calls[6]?.[0]).toContain('/api/evaluation-datasets/set%2F1/versions?');
    expect(fetcher.mock.calls[7]?.[0]).toContain('/api/evaluator-profiles/profile%2F1/versions?');
  });

  it('JudgeRubric save/list/get/versions contractを扱う', async () => {
    const rubric = { metadata: { internalId: 'rubric', version: '1.0.0' }, criteria: [] }; const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ rubric }, 201)).mockResolvedValueOnce(jsonResponse({ rubrics: [{ internalId: 'rubric' }] })).mockResolvedValueOnce(jsonResponse({ rubric })).mockResolvedValueOnce(jsonResponse({ versions: ['1.0.0'] })); const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const input: SaveJudgeRubricDto = { scope, internalId: 'rubric', workingName: 'draft', displayName: 'Rubric', publishName: 'rubric', owner: 'owner', instructions: 'Judge.', referencePolicy: 'optional', criteria: [{ id: 'q', label: 'Q', description: 'Quality', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] };
    await client.saveJudgeRubric(input); await client.listJudgeRubrics(scope); await client.getJudgeRubric('rubric/1', scope, '1.0.0'); await client.listJudgeRubricVersions('rubric/1', scope);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/judge-rubrics', expect.objectContaining({ body: JSON.stringify(input) })); expect(fetcher.mock.calls[2]?.[0]).toContain('/api/judge-rubrics/rubric%2F1?'); expect(fetcher.mock.calls[3]?.[0]).toContain('/api/judge-rubrics/rubric%2F1/versions?');
  });

  it('比較・品質ゲート・昇格のwire contractを扱う', async () => {
    const policy = { metadata: { internalId: 'release', version: '1.0.0' }, rules: [] }; const report = { id: 'report', status: 'pass' }; const promotion = { id: 'promotion', status: 'pending' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ comparison: { candidateExperimentId: 'candidate' } }))
      .mockResolvedValueOnce(jsonResponse({ policy }, 201))
      .mockResolvedValueOnce(jsonResponse({ policies: [{ internalId: 'release' }] }))
      .mockResolvedValueOnce(jsonResponse({ policy }))
      .mockResolvedValueOnce(jsonResponse({ report }, 201))
      .mockResolvedValueOnce(jsonResponse({ reports: [report] }))
      .mockResolvedValueOnce(jsonResponse({ promotion }, 201))
      .mockResolvedValueOnce(jsonResponse({ promotions: [promotion] }))
      .mockResolvedValueOnce(jsonResponse({ promotion: { ...promotion, status: 'approved' } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const input: SaveGatePolicyDto = { scope, internalId: 'release', workingName: 'Release', displayName: 'Release', publishName: 'release', owner: 'owner', rules: [{ id: 'quality', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }] };
    await client.compareExperiments(scope, 'base/1', 'candidate/1'); await client.saveGatePolicy(input); await client.listGatePolicies(scope); await client.getGatePolicy('release/1', scope, '1.0.0');
    await client.evaluateGate(scope, { id: 'release', version: '1.0.0' }, 'candidate/1', 'base/1'); await client.listGateReports(scope, 'candidate/1'); await client.requestPromotion('agent/1', '2.0.0', scope, 'report', 'alice'); await client.listPromotionRequests(scope, 'agent/1'); await client.decidePromotion('promotion/1', 'approve', scope, 'reviewer');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope, baselineExperimentId: 'base/1', candidateExperimentId: 'candidate/1' }) });
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/gate-policies', expect.objectContaining({ body: JSON.stringify(input) }));
    expect(fetcher.mock.calls[3]?.[0]).toContain('/api/gate-policies/release%2F1?'); expect(fetcher.mock.calls[5]?.[0]).toContain('candidateExperimentId=candidate%2F1');
    expect(fetcher.mock.calls[6]?.[0]).toBe('/api/agents/agent%2F1/versions/2.0.0/promotion-requests'); expect(fetcher.mock.calls[8]?.[0]).toBe('/api/promotion-requests/promotion%2F1/approve');
  });
});
