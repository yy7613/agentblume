import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import type { TelemetryPort } from '../application/operations/telemetry';
import { createApp, type App } from '../composition/root';
import { SemVer } from '../domain/tool/semver';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('LLMOps operations API', () => {
  let model: ScriptedModelProvider; let app: App; let server: FastifyInstance;
  beforeEach(async () => {
    model = new ScriptedModelProvider(); app = createApp({ profile: 'test', modelProvider: model }); server = buildServer(app);
    await app.saveAgent.execute({ scope, internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer.', tools: [] });
  });
  afterEach(async () => { await server.close(); app.close(); });

  it('Run観測、Feedback、時系列、retentionを縦断し匿名集計を保持する', async () => {
    model.enqueue({ message: { role: 'assistant', content: 'answer' }, finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'agent', version: '1.0.0' }, message: 'hello', mode: 'preview' } });
    expect(response.statusCode).toBe(200);
    const run = response.json().run;
    expect(run).toMatchObject({ purpose: 'interactive', model: { provider: 'scripted', model: 'scripted' }, latency: { totalMs: expect.any(Number), modelMs: expect.any(Number), toolMs: 0 }, estimatedCost: { kind: 'estimated', amount: 0.0002, currency: 'USD' } });

    const saved = await server.inject({ method: 'PUT', url: `/runs/${run.runId}/feedback`, payload: { scope, thumb: 'down', rating: 2, comment: 'incorrect answer', issueTags: ['incorrect'] } });
    expect(saved.statusCode).toBe(200); expect(saved.json().feedback).toMatchObject({ runId: run.runId, agent: { internalId: 'agent', version: '1.0.0' }, thumb: 'down' });
    const updated = await server.inject({ method: 'PUT', url: `/runs/${run.runId}/feedback`, payload: { scope, thumb: 'up', comment: '  ', issueTags: ['helpful', 'helpful'] } });
    expect(updated.json().feedback).toMatchObject({ id: saved.json().feedback.id, thumb: 'up', issueTags: ['helpful'], createdAt: saved.json().feedback.createdAt });
    expect(updated.json().feedback.rating).toBeUndefined(); expect(updated.json().feedback.comment).toBeUndefined();
    const status = await server.inject({ method: 'GET', url: '/operations/status?tenantId=tenant&workspaceId=workspace&days=30' });
    expect(status.json().status.summary).toMatchObject({ runCount: 1, failureRate: 0, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 1 });

    const defaults = await server.inject({ method: 'GET', url: '/operations/retention?tenantId=tenant&workspaceId=workspace' });
    expect(defaults.json().policy).toMatchObject({ payloadDays: 30, traceDays: 14, aggregateDays: 365 });
    const malformed = await server.inject({ method: 'PUT', url: '/operations/retention', payload: { scope, payloadDays: -1 } });
    expect(malformed.statusCode).toBe(400);
    await server.inject({ method: 'PUT', url: '/operations/retention', payload: { scope, payloadDays: 0, traceDays: 0, aggregateDays: 365 } });
    const applied = await server.inject({ method: 'POST', url: '/operations/retention/apply', payload: { scope } });
    expect(applied.json().result).toMatchObject({ deleted: 1, feedbackDeleted: 1, aggregateBucketsDeleted: 0 });
    const trace = await server.inject({ method: 'GET', url: `/runs/${run.runId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(trace.statusCode).toBe(404);
    const feedback = await server.inject({ method: 'GET', url: `/runs/${run.runId}/feedback?tenantId=tenant&workspaceId=workspace` });
    expect(feedback.json()).toEqual({ feedback: null });
    const aggregate = await server.inject({ method: 'GET', url: '/operations/status?tenantId=tenant&workspaceId=workspace&days=30' });
    expect(aggregate.json().status.summary.runCount).toBe(1);
  });

  it('Telemetry adapter停止と未知model価格をRun失敗へ伝播させない', async () => {
    await server.close(); app.close();
    const failingTelemetry: TelemetryPort = { startSpan: () => { throw new Error('exporter unavailable'); } };
    model = new ScriptedModelProvider();
    app = createApp({ profile: 'test', modelProvider: model, telemetry: failingTelemetry, modelSnapshot: { provider: 'unknown', model: 'unknown', modelConfigHash: 'hash' } }); server = buildServer(app);
    await app.saveAgent.execute({ scope, internalId: 'agent-2', workingName: 'agent', displayName: 'Agent', publishName: 'agent_2', owner: 'owner', kind: 'normal', systemPrompt: 'Answer.', tools: [] });
    model.enqueue({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'agent-2', version: SemVer.parse('1.0.0').toString() }, message: 'hello', mode: 'preview' } });
    expect(response.statusCode).toBe(200); expect(response.json().run.estimatedCost).toBeUndefined();
  });
});
