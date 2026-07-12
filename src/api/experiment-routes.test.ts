import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 't', workspaceId: 'w' };
async function waitForTerminal(server: FastifyInstance, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = (await server.inject({ method: 'GET', url: `/experiments/${id}`, query: scope })).json().experiment as Record<string, unknown>;
    if (!['queued', 'running'].includes(String(body['status']))) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('experiment did not finish');
}

describe('experiment routes', () => {
  let app: App; let server: FastifyInstance; let model: ScriptedModelProvider;
  beforeEach(() => { model = new ScriptedModelProvider(); app = createApp({ profile: 'test', modelProvider: model }); server = buildServer(app); });
  afterEach(async () => { await server.close(); app.close(); });

  it('202で作成しworkerがturn caseを実行・採点・永続化する', async () => {
    expect((await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'agent', workingName: 'a', displayName: 'Agent', publishName: 'agent', owner: 'o', kind: 'normal', systemPrompt: 'Answer.', skills: [], tools: [] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: { scope, internalId: 'set', workingName: 's', displayName: 'Set', publishName: 'set', owner: 'o', cases: [{ id: 'case', kind: 'turn', input: 'hello sales', reference: 'hello sales', tags: [], source: 'manual' }] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: { scope, internalId: 'profile', workingName: 'p', displayName: 'Profile', publishName: 'profile', owner: 'o', metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] } })).statusCode).toBe(201);
    model.enqueue({ message: { role: 'assistant', content: 'hello sales' }, finishReason: 'stop', usage: { totalTokens: 4 } });
    const created = await server.inject({ method: 'POST', url: '/experiments', payload: { scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' }, repetitions: 1 } });
    expect(created.statusCode).toBe(202);
    const id = created.json().experiment.id as string;
    expect(await waitForTerminal(server, id)).toMatchObject({ status: 'completed', progress: { completed: 1, total: 1 }, snapshot: { provider: 'scripted', model: 'scripted' } });
    const results = (await server.inject({ method: 'GET', url: `/experiments/${id}/results`, query: scope })).json().results;
    expect(results).toMatchObject([{ caseId: 'case', status: 'succeeded', output: 'hello sales', usage: { totalTokens: 4 }, scores: [{ metric: 'coverage' }] }]);
    expect((await server.inject({ method: 'GET', url: '/experiments', query: { ...scope, status: 'completed' } })).json().experiments).toHaveLength(1);
  });

  it('未存在は404、不正versionは400', async () => {
    const missing = await server.inject({ method: 'GET', url: '/experiments/missing', query: scope });
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe('EXPERIMENT_NOT_FOUND');
    expect((await server.inject({ method: 'GET', url: '/experiments/missing/results', query: scope })).statusCode).toBe(404);
    const invalid = await server.inject({ method: 'POST', url: '/experiments', payload: { scope, target: { agentId: 'a', version: 'bad' }, dataset: { id: 's', version: '1.0.0' }, evaluatorProfile: { id: 'p', version: '1.0.0' } } });
    expect(invalid.statusCode).toBe(400);
  });
});
