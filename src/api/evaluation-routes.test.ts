import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
function scoreOf(evaluation: { scores: { metric: string; score: number }[] }, metric: string): number | undefined {
  return evaluation.scores.find((score) => score.metric === metric)?.score;
}

describe('POST /evaluations', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => { app = createApp({ profile: 'test', modelProvider: new ScriptedModelProvider() }); server = buildServer(app); });
  afterEach(async () => { await server.close(); app.close(); });

  it('応答をMastra Evalsで採点し scores/average を返す（良い応答>悪い応答）', async () => {
    const query = 'Give me last month sales summary with total revenue';
    const good = await server.inject({ method: 'POST', url: '/evaluations', payload: { scope, input: query, output: 'Last month sales summary: total revenue was $128,000 across 512 orders.' } });
    expect(good.statusCode).toBe(200);
    const goodEval = good.json().evaluation;
    expect(scoreOf(goodEval, 'keyword-coverage')).toBeDefined();
    expect(goodEval.average).toBeGreaterThan(0);
    const bad = await server.inject({ method: 'POST', url: '/evaluations', payload: { input: query, output: 'I like turtles.' } });
    expect(scoreOf(goodEval, 'keyword-coverage')!).toBeGreaterThan(scoreOf(bad.json().evaluation, 'keyword-coverage') ?? 0);
  });

  it('reference 指定で content-similarity メトリクスが加わる', async () => {
    const response = await server.inject({ method: 'POST', url: '/evaluations', payload: { input: 'q', output: 'total revenue was 128000', reference: 'total revenue was 128000' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().evaluation.scores.some((score: { metric: string }) => score.metric === 'content-similarity')).toBe(true);
  });

  it('空inputは400（EVALUATION_DOMAIN）', async () => {
    const response = await server.inject({ method: 'POST', url: '/evaluations', payload: { input: ' ', output: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('EVALUATION_DOMAIN');
  });
});
