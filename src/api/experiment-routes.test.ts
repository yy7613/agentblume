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
  let app: App; let server: FastifyInstance; let model: ScriptedModelProvider; let judgeModel: ScriptedModelProvider;
  beforeEach(() => { model = new ScriptedModelProvider(); judgeModel = new ScriptedModelProvider(); app = createApp({ profile: 'test', modelProvider: model, judgeModelProvider: judgeModel }); server = buildServer(app); });
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

  it('境界: judgeSamples は 1〜5 を受け付けて GET で返し、0 / 6 は 400', async () => {
    expect((await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'agent', workingName: 'a', displayName: 'Agent', publishName: 'agent', owner: 'o', kind: 'normal', systemPrompt: 'Answer.', skills: [], tools: [] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: { scope, internalId: 'set', workingName: 's', displayName: 'Set', publishName: 'set', owner: 'o', cases: [{ id: 'case', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: { scope, internalId: 'profile', workingName: 'p', displayName: 'Profile', publishName: 'profile', owner: 'o', metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] } })).statusCode).toBe(201);
    const body = { scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' } };
    for (const judgeSamples of [1, 5]) {
      model.enqueue({ message: { role: 'assistant', content: 'hello' }, finishReason: 'stop' });
      const created = await server.inject({ method: 'POST', url: '/experiments', payload: { ...body, judgeSamples } });
      expect(created.statusCode).toBe(202); expect(created.json().experiment.judgeSamples).toBe(judgeSamples);
      expect(await waitForTerminal(server, created.json().experiment.id as string)).toMatchObject({ judgeSamples });
    }
    model.enqueue({ message: { role: 'assistant', content: 'hello' }, finishReason: 'stop' });
    const defaulted = await server.inject({ method: 'POST', url: '/experiments', payload: body }); expect(defaulted.json().experiment.judgeSamples).toBe(1);
    for (const judgeSamples of [0, 6]) { const rejected = await server.inject({ method: 'POST', url: '/experiments', payload: { ...body, judgeSamples } }); expect(rejected.statusCode).toBe(400); expect(rejected.json().error.message).toContain('judgeSamples'); }
  });

  it('判定レコードの基準別スコア・詳細・派生指標を結果で返す', async () => {
    expect((await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'agent', workingName: 'a', displayName: 'Agent', publishName: 'agent', owner: 'o', kind: 'normal', systemPrompt: 'Answer.', skills: [], tools: [] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: { scope, internalId: 'set', workingName: 's', displayName: 'Set', publishName: 'set', owner: 'o', cases: [{ id: 'case', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/judge-rubrics', payload: { scope, internalId: 'rubric', workingName: 'r', displayName: 'Rubric', publishName: 'rubric', owner: 'o', instructions: 'Judge.', referencePolicy: 'optional', criteria: [{ id: 'accuracy', label: 'A', description: 'A', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }, { id: 'tone', label: 'T', description: 'T', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: { scope, internalId: 'profile', workingName: 'p', displayName: 'Profile', publishName: 'profile', owner: 'o', metrics: [{ id: 'judge', kind: 'judge', rubric: { id: 'rubric', version: '1.0.0' }, weight: 1, required: true }] } })).statusCode).toBe(201);
    model.enqueue({ message: { role: 'assistant', content: 'hello' }, finishReason: 'stop' });
    judgeModel.enqueue({ message: { role: 'assistant', content: JSON.stringify({ criteria: [{ id: 'accuracy', reason: 'right', score: 1 }, { id: 'tone', reason: 'unknown', score: null }], reason: 'fine' }) }, finishReason: 'stop', usage: { totalTokens: 7 } });
    const created = await server.inject({ method: 'POST', url: '/experiments', payload: { scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' } } });
    expect(await waitForTerminal(server, created.json().experiment.id as string)).toMatchObject({ status: 'completed' });
    const results = (await server.inject({ method: 'GET', url: `/experiments/${created.json().experiment.id}/results`, query: scope })).json().results;
    expect(results[0].scores).toEqual([{ metric: 'judge', score: 1, reason: 'fine' }, { metric: 'judge:accuracy', score: 1, reason: 'right' }]);
    expect(results[0].judgeEvaluations[0]).toMatchObject({ status: 'succeeded', score: 1, criteria: [{ id: 'accuracy', score: 1, reason: 'right' }, { id: 'tone', score: null, reason: 'unknown' }], samples: 1, dispersion: { min: 1, max: 1, stddev: 0 }, uncertain: false, usage: { totalTokens: 7 }, contract: { rubricId: 'rubric', rubricVersion: '1.0.0', promptHash: expect.stringMatching(/^[0-9a-f]{16}$/) } });
  });

  describe('起票時の judge ガード', () => {
    const rubricBody = (tracePolicy: string) => ({ scope, internalId: 'rubric', workingName: 'r', displayName: 'Rubric', publishName: 'rubric', owner: 'o', instructions: 'Judge.', referencePolicy: 'optional', tracePolicy, criteria: [{ id: 'accuracy', label: 'A', description: 'A', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] });
    const judgeProfileBody = { scope, internalId: 'profile', workingName: 'p', displayName: 'Profile', publishName: 'profile', owner: 'o', metrics: [{ id: 'judge', kind: 'judge', rubric: { id: 'rubric', version: '1.0.0' }, weight: 1, required: true }] };
    const experimentBody = { scope, target: { agentId: 'agent', version: '1.0.0' }, dataset: { id: 'set', version: '1.0.0' }, evaluatorProfile: { id: 'profile', version: '1.0.0' } };
    async function seedAgentAndScenario(target: FastifyInstance): Promise<void> {
      expect((await target.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'agent', workingName: 'a', displayName: 'Agent', publishName: 'agent', owner: 'o', kind: 'normal', systemPrompt: 'Answer.', skills: [], tools: [] } })).statusCode).toBe(201);
      expect((await target.inject({ method: 'POST', url: '/personas', payload: { scope, internalId: 'persona', workingName: 'p', displayName: 'Persona', publishName: 'persona', owner: 'o', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' } })).statusCode).toBe(201);
      expect((await target.inject({ method: 'POST', url: '/scenarios', payload: { scope, internalId: 'scenario', workingName: 's', displayName: 'Scenario', publishName: 'scenario', owner: 'o', target: { agentId: 'agent', version: '1.0.0' }, persona: { personaId: 'persona', version: '1.0.0' }, goal: 'reach the goal', maxUserTurns: 2, survey: [{ id: 'q1', textJa: 'ok?', textEn: 'ok?', kind: 'boolean' }] } })).statusCode).toBe(201);
    }

    it('異常: judge 未設定で judge 指標つきの実験を起票すると 409 JUDGE_MODEL_NOT_CONFIGURED（実験は作られない）', async () => {
      // 実機の未設定状態: env JUDGE_LM_STUDIO_MODEL 未設定のとき composition が解決する指紋。
      const unconfigured = createApp({ profile: 'test', modelProvider: model, judgeModelProvider: judgeModel, judgeModelSnapshot: { provider: 'lm-studio-judge', model: '', modelConfigHash: 'env' } });
      const target = buildServer(unconfigured);
      try {
        expect((await target.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'agent', workingName: 'a', displayName: 'Agent', publishName: 'agent', owner: 'o', kind: 'normal', systemPrompt: 'Answer.', skills: [], tools: [] } })).statusCode).toBe(201);
        expect((await target.inject({ method: 'POST', url: '/evaluation-datasets', payload: { scope, internalId: 'set', workingName: 's', displayName: 'Set', publishName: 'set', owner: 'o', cases: [{ id: 'case', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] } })).statusCode).toBe(201);
        expect((await target.inject({ method: 'POST', url: '/judge-rubrics', payload: rubricBody('optional') })).statusCode).toBe(201);
        expect((await target.inject({ method: 'POST', url: '/evaluator-profiles', payload: judgeProfileBody })).statusCode).toBe(201);
        const rejected = await target.inject({ method: 'POST', url: '/experiments', payload: experimentBody });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toEqual({ error: { code: 'JUDGE_MODEL_NOT_CONFIGURED', message: "CreateExperiment: evaluator profile 'profile@1.0.0' has judge metrics but no judge model is configured" } });
        expect((await target.inject({ method: 'GET', url: '/experiments', query: scope })).json().experiments).toEqual([]);
        // 機能フラグも同じ判定を返すので、UI は起票前に「judge 未設定」を出せる。
        expect((await target.inject({ method: 'GET', url: '/runtime/capabilities' })).json().judge).toEqual({ configured: false });
      } finally { await target.close(); unconfigured.close(); }
    });

    it('異常: tracePolicy=required のルーブリックと scenario 事例の組み合わせは 409 JUDGE_TRACE_UNAVAILABLE で、本文の rubric が直す対象を指す', async () => {
      await seedAgentAndScenario(server);
      expect((await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: { scope, internalId: 'set', workingName: 's', displayName: 'Set', publishName: 'set', owner: 'o', cases: [{ id: 'turn', kind: 'turn', input: 'hello', tags: [], source: 'manual' }, { id: 'scenario', kind: 'scenario', scenario: { id: 'scenario', version: '1.0.0' }, tags: [], source: 'manual' }] } })).statusCode).toBe(201);
      expect((await server.inject({ method: 'POST', url: '/judge-rubrics', payload: rubricBody('required') })).statusCode).toBe(201);
      expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: judgeProfileBody })).statusCode).toBe(201);
      const rejected = await server.inject({ method: 'POST', url: '/experiments', payload: experimentBody });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toEqual({ error: { code: 'JUDGE_TRACE_UNAVAILABLE', message: "CreateExperiment: judge rubric 'rubric@1.0.0' requires a tool trace, but dataset 'set@1.0.0' contains scenario cases which never produce one; set tracePolicy to 'optional'", rubric: { id: 'rubric', version: '1.0.0' } } });
      expect((await server.inject({ method: 'GET', url: '/experiments', query: scope })).json().experiments).toEqual([]);
    });

    it('[回帰固定] 正常: tracePolicy=required でも turn 事例だけなら 202 で起票できる（test プロファイルの judge は設定済み）', async () => {
      await seedAgentAndScenario(server);
      expect((await server.inject({ method: 'POST', url: '/evaluation-datasets', payload: { scope, internalId: 'set', workingName: 's', displayName: 'Set', publishName: 'set', owner: 'o', cases: [{ id: 'turn', kind: 'turn', input: 'hello', tags: [], source: 'manual' }] } })).statusCode).toBe(201);
      expect((await server.inject({ method: 'POST', url: '/judge-rubrics', payload: rubricBody('required') })).statusCode).toBe(201);
      expect((await server.inject({ method: 'POST', url: '/evaluator-profiles', payload: judgeProfileBody })).statusCode).toBe(201);
      model.enqueue({ message: { role: 'assistant', content: 'hello' }, finishReason: 'stop' });
      judgeModel.enqueue({ message: { role: 'assistant', content: JSON.stringify({ criteria: [{ id: 'accuracy', reason: 'right', score: 1 }], reason: 'fine' }) }, finishReason: 'stop' });
      const created = await server.inject({ method: 'POST', url: '/experiments', payload: experimentBody });
      expect(created.statusCode).toBe(202);
      expect(await waitForTerminal(server, created.json().experiment.id as string)).toMatchObject({ status: 'completed' });
    });
  });

  it('未存在は404、不正versionは400', async () => {
    const missing = await server.inject({ method: 'GET', url: '/experiments/missing', query: scope });
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe('EXPERIMENT_NOT_FOUND');
    expect((await server.inject({ method: 'GET', url: '/experiments/missing/results', query: scope })).statusCode).toBe(404);
    const invalid = await server.inject({ method: 'POST', url: '/experiments', payload: { scope, target: { agentId: 'a', version: 'bad' }, dataset: { id: 's', version: '1.0.0' }, evaluatorProfile: { id: 'p', version: '1.0.0' } } });
    expect(invalid.statusCode).toBe(400);
  });
});
