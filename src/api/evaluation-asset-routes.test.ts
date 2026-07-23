import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const datasetBody = { scope, internalId: 'quality', workingName: 'draft', displayName: 'Quality', publishName: 'quality', owner: 'owner', cases: [{ id: 'case-1', kind: 'turn', input: 'Summarize sales', reference: 'Sales were 42.', expectedTools: ['sales'], tags: ['critical'], source: 'manual' }], bump: 'patch' };

describe('evaluation asset routes', () => {
  let app: App; let server: FastifyInstance;
  beforeEach(() => { app = createApp({ profile: 'test' }); server = buildServer(app); });
  afterEach(async () => { await server.close(); app.close(); });

  it('Dataset save/list/get/versions/export/importを提供する', async () => {
    const saved = await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: datasetBody });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().dataset).toMatchObject({ metadata: { internalId: 'quality', version: '1.0.0' }, cases: [{ id: 'case-1' }] });
    expect((await server.inject({ method: 'GET', url: '/evaluation-datasets', query: scope })).json().datasets[0]).toMatchObject({ internalId: 'quality', latestVersion: '1.0.0', caseCount: 1 });
    expect((await server.inject({ method: 'GET', url: '/evaluation-datasets/quality', query: scope })).json().dataset.metadata.version).toBe('1.0.0');
    expect((await server.inject({ method: 'GET', url: '/evaluation-datasets/quality/versions', query: scope })).json().versions).toEqual(['1.0.0']);
    const exported = await server.inject({ method: 'GET', url: '/evaluation-datasets/quality/export', query: { ...scope, format: 'json' } });
    expect(exported.json().content).toContain('"case-1"');
    const imported = await server.inject({ method: 'POST', url: '/evaluation-datasets/import', payload: { scope, format: 'json', content: exported.json().content } });
    expect(imported.json().cases).toMatchObject([{ id: 'case-1', source: 'import' }]);
  });

  it('EvaluatorProfileを版管理しunknown資産は404にする', async () => {
    const body = { scope, internalId: 'default', workingName: 'draft', displayName: 'Default', publishName: 'default', owner: 'owner', metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] };
    expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: body })).statusCode).toBe(201);
    expect((await server.inject({ method: 'GET', url: '/evaluator-profiles', query: scope })).json().profiles[0]).toMatchObject({ internalId: 'default', metricCount: 1 });
    expect((await server.inject({ method: 'GET', url: '/evaluator-profiles/default', query: scope })).json().profile.metadata.version).toBe('1.0.0');
    const missing = await server.inject({ method: 'GET', url: '/evaluation-datasets/missing', query: scope });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('EVALUATION_DATASET_NOT_FOUND');
  });

  it('不正scorerと不正SemVerを400にする', async () => {
    const badProfile = await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: { scope, internalId: 'x', workingName: 'x', displayName: 'x', publishName: 'x', owner: 'x', metrics: [{ id: 'x', kind: 'code', scorer: 'made-up', weight: 1, required: true }] } });
    expect(badProfile.statusCode).toBe(400);
    const badDataset = await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: { ...datasetBody, cases: [{ id: 's', kind: 'scenario', scenario: { id: 's', version: 'bad' }, tags: [] }] } });
    expect(badDataset.statusCode).toBe(400);
  });

  it('JudgeRubricを版管理しjudge metricから固定参照する', async () => {
    const rubricBody = { scope, internalId: 'quality-rubric', workingName: 'draft', displayName: 'Quality rubric', publishName: 'quality_rubric', owner: 'owner', instructions: 'Judge correctness.', referencePolicy: 'required', criteria: [{ id: 'accuracy', label: 'Accuracy', description: 'Factual correctness', weight: 1, levels: [{ score: 0, label: 'Wrong', description: 'Incorrect' }, { score: 1, label: 'Correct', description: 'Fully correct' }] }] };
    const saved = await server.inject({ method: 'POST', url: '/judge-rubrics', payload: rubricBody }); expect(saved.statusCode).toBe(201); expect(saved.json().rubric).toMatchObject({ metadata: { version: '1.0.0' }, reasonRequired: true });
    expect((await server.inject({ method: 'GET', url: '/judge-rubrics', query: scope })).json().rubrics[0]).toMatchObject({ internalId: 'quality-rubric', criterionCount: 1 });
    expect((await server.inject({ method: 'GET', url: '/judge-rubrics/quality-rubric/versions', query: scope })).json().versions).toEqual(['1.0.0']);
    expect((await server.inject({ method: 'GET', url: '/judge-rubrics/quality-rubric', query: scope })).json().rubric.referencePolicy).toBe('required');
    const profile = await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: { scope, internalId: 'judge-profile', workingName: 'draft', displayName: 'Judge', publishName: 'judge', owner: 'owner', metrics: [{ id: 'quality', kind: 'judge', rubric: { id: 'quality-rubric', version: '1.0.0' }, weight: 1, required: true }] } });
    expect(profile.statusCode).toBe(201); expect(profile.json().profile.metrics[0]).toMatchObject({ kind: 'judge', rubric: { version: '1.0.0' } });
    expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: { scope, internalId: 'bad', workingName: 'bad', displayName: 'bad', publishName: 'bad', owner: 'owner', metrics: [{ id: 'quality', kind: 'judge', rubric: { id: 'missing', version: '1.0.0' }, weight: 1, required: false }] } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: '/judge-rubrics/missing', query: scope })).statusCode).toBe(404);
  });

  it('EvaluationDatasetを論理削除できる(listから除外、GETはfindLatestのため404、pinned versionはfindVersionで残る)', async () => {
    const saved = await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: datasetBody });
    expect(saved.statusCode).toBe(201);

    const deleted = await server.inject({ method: 'DELETE', url: '/evaluation-datasets/quality', query: scope });
    expect(deleted.statusCode).toBe(204);

    expect((await server.inject({ method: 'GET', url: '/evaluation-datasets', query: scope })).json().datasets).toEqual([]);
    const getLatest = await server.inject({ method: 'GET', url: '/evaluation-datasets/quality', query: scope });
    expect(getLatest.statusCode).toBe(404);
    expect(getLatest.json().error).toMatchObject({ code: 'EVALUATION_DATASET_NOT_FOUND' });
    const getPinned = await server.inject({ method: 'GET', url: '/evaluation-datasets/quality', query: { ...scope, version: '1.0.0' } });
    expect(getPinned.statusCode).toBe(200);

    expect((await server.inject({ method: 'DELETE', url: '/evaluation-datasets/quality', query: scope })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: '/evaluation-datasets/missing', query: scope })).statusCode).toBe(404);
  });

  it('EvaluatorProfileを論理削除できる(listから除外、GETはfindLatestのため404、pinned versionはfindVersionで残る)', async () => {
    const body = { scope, internalId: 'default', workingName: 'draft', displayName: 'Default', publishName: 'default', owner: 'owner', metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] };
    const saved = await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: body });
    expect(saved.statusCode).toBe(201);

    const deleted = await server.inject({ method: 'DELETE', url: '/evaluator-profiles/default', query: scope });
    expect(deleted.statusCode).toBe(204);

    expect((await server.inject({ method: 'GET', url: '/evaluator-profiles', query: scope })).json().profiles).toEqual([]);
    const getLatest = await server.inject({ method: 'GET', url: '/evaluator-profiles/default', query: scope });
    expect(getLatest.statusCode).toBe(404);
    expect(getLatest.json().error).toMatchObject({ code: 'EVALUATOR_PROFILE_NOT_FOUND' });
    const getPinned = await server.inject({ method: 'GET', url: '/evaluator-profiles/default', query: { ...scope, version: '1.0.0' } });
    expect(getPinned.statusCode).toBe(200);

    expect((await server.inject({ method: 'DELETE', url: '/evaluator-profiles/default', query: scope })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: '/evaluator-profiles/missing', query: scope })).statusCode).toBe(404);
  });

  it('JudgeRubricを論理削除できる(listから除外、GETはfindLatestのため404、pinned versionはfindVersionで残る)', async () => {
    const rubricBody = { scope, internalId: 'quality-rubric', workingName: 'draft', displayName: 'Quality rubric', publishName: 'quality_rubric', owner: 'owner', instructions: 'Judge correctness.', referencePolicy: 'required', criteria: [{ id: 'accuracy', label: 'Accuracy', description: 'Factual correctness', weight: 1, levels: [{ score: 0, label: 'Wrong', description: 'Incorrect' }, { score: 1, label: 'Correct', description: 'Fully correct' }] }] };
    const saved = await server.inject({ method: 'POST', url: '/judge-rubrics', payload: rubricBody });
    expect(saved.statusCode).toBe(201);

    const deleted = await server.inject({ method: 'DELETE', url: '/judge-rubrics/quality-rubric', query: scope });
    expect(deleted.statusCode).toBe(204);

    expect((await server.inject({ method: 'GET', url: '/judge-rubrics', query: scope })).json().rubrics).toEqual([]);
    const getLatest = await server.inject({ method: 'GET', url: '/judge-rubrics/quality-rubric', query: scope });
    expect(getLatest.statusCode).toBe(404);
    expect(getLatest.json().error).toMatchObject({ code: 'JUDGE_RUBRIC_NOT_FOUND' });
    const getPinned = await server.inject({ method: 'GET', url: '/judge-rubrics/quality-rubric', query: { ...scope, version: '1.0.0' } });
    expect(getPinned.statusCode).toBe(200);

    expect((await server.inject({ method: 'DELETE', url: '/judge-rubrics/quality-rubric', query: scope })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: '/judge-rubrics/missing', query: scope })).statusCode).toBe(404);
  });
});
