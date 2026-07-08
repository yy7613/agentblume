/**
 * 検証ルートの inject 統合テスト（v16 実装契約 §5・§7 DoD）
 *
 * Fakeモデル（ScriptedModelProvider）で「Persona保存 → Scenario保存 → 実行 →
 * ScenarioRun取得」が API 経由で通ることを確認する。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

const SURVEY = [
  { id: 'q1', textJa: '目的達成?', textEn: 'Achieved?', kind: 'boolean' },
  { id: 'q2', textJa: '満足度', textEn: 'Satisfaction', kind: 'scale', min: 1, max: 5 },
  { id: 'impressions', textJa: '感想', textEn: 'Impressions', kind: 'text' },
];

function personaBody(overrides: Record<string, unknown> = {}) {
  return {
    scope, internalId: 'novice-user', workingName: 'p', displayName: 'Novice user', publishName: 'novice_user', owner: 'owner',
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja', ...overrides,
  };
}

function scenarioBody(overrides: Record<string, unknown> = {}) {
  return {
    scope, internalId: 'sales-check', workingName: 's', displayName: 'Sales check', publishName: 'sales_check', owner: 'owner',
    target: { agentId: 'sales-agent', version: '1.0.0' },
    persona: { personaId: 'novice-user', version: '1.0.0' },
    goal: '先月の売上サマリを得る', maxUserTurns: 4,
    expectedTools: ['filter_scores'], survey: SURVEY, ...overrides,
  };
}

describe('validation routes', () => {
  let app: App;
  let server: FastifyInstance;
  let model: ScriptedModelProvider;

  beforeEach(async () => {
    model = new ScriptedModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    // 対象Agentが参照する read-only Tool と Agent を用意する。
    await server.inject({ method: 'POST', url: '/tools', payload: {
      scope, internalId: 'scores', workingName: 'Scores', displayName: 'Score filter', publishName: 'filter_scores', owner: 'owner', sideEffect: 'read-only',
      graph: { nodes: [{ id: 'source', type: 'agent-input', config: { schema: { columns: [{ name: 'score', type: 'number', nullable: false }] }, sample: { score: 1 } } }], edges: [] },
      inputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] }, outputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
    } });
    const agent = await server.inject({ method: 'POST', url: '/agents', payload: {
      scope, internalId: 'sales-agent', workingName: 'a', displayName: 'Sales agent', publishName: 'sales_agent', owner: 'owner',
      kind: 'normal', systemPrompt: 'Answer sales questions.', skills: [], tools: [{ internalId: 'scores', version: '1.0.0' }],
    } });
    expect(agent.statusCode).toBe(201);
  });

  afterEach(async () => { await server.close(); app.close(); });

  it('Persona save/list/get/versions を公開する', async () => {
    const first = await server.inject({ method: 'POST', url: '/personas', payload: personaBody() });
    expect(first.statusCode).toBe(201);
    expect(first.json().persona).toMatchObject({ archetype: 'novice', metadata: { version: '1.0.0' } });
    const second = await server.inject({ method: 'POST', url: '/personas', payload: personaBody({ tone: '事務的', bump: 'minor' }) });
    expect(second.json().persona.metadata.version).toBe('1.1.0');

    expect((await server.inject({ method: 'GET', url: '/personas', query: scope })).json().personas)
      .toMatchObject([{ internalId: 'novice-user', archetype: 'novice', latestVersion: '1.1.0' }]);
    const get = await server.inject({ method: 'GET', url: '/personas/novice-user', query: { ...scope, version: '1.0.0' } });
    expect(get.json().persona.tone).toBe('丁寧');
    expect((await server.inject({ method: 'GET', url: '/personas/novice-user/versions', query: scope })).json())
      .toEqual({ versions: ['1.0.0', '1.1.0'] });

    const missing = await server.inject({ method: 'GET', url: '/personas/missing', query: scope });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('PERSONA_NOT_FOUND');
    const bad = await server.inject({ method: 'POST', url: '/personas', payload: personaBody({ archetype: 'weird' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');
  });

  it('Scenario save は参照整合を検証し、save/list/get/versions を公開する', async () => {
    await server.inject({ method: 'POST', url: '/personas', payload: personaBody() });
    const saved = await server.inject({ method: 'POST', url: '/scenarios', payload: scenarioBody() });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().scenario).toMatchObject({
      metadata: { version: '1.0.0' },
      target: { agentId: 'sales-agent', version: '1.0.0' },
      persona: { personaId: 'novice-user', version: '1.0.0' },
    });

    expect((await server.inject({ method: 'GET', url: '/scenarios', query: scope })).json().scenarios)
      .toMatchObject([{ internalId: 'sales-check', latestVersion: '1.0.0' }]);
    expect((await server.inject({ method: 'GET', url: '/scenarios/sales-check', query: scope })).json().scenario.goal)
      .toBe('先月の売上サマリを得る');
    expect((await server.inject({ method: 'GET', url: '/scenarios/sales-check/versions', query: scope })).json())
      .toEqual({ versions: ['1.0.0'] });

    // 参照整合: 未存在Agent版は 400 VALIDATION_DOMAIN。
    const badRef = await server.inject({ method: 'POST', url: '/scenarios', payload: scenarioBody({ target: { agentId: 'missing', version: '1.0.0' } }) });
    expect(badRef.statusCode).toBe(400);
    expect(badRef.json().error.code).toBe('VALIDATION_DOMAIN');
    // 不正 version 文字列は 400 BAD_REQUEST。
    const badVersion = await server.inject({ method: 'POST', url: '/scenarios', payload: scenarioBody({ target: { agentId: 'sales-agent', version: 'bad' } }) });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().error.code).toBe('BAD_REQUEST');
    const missing = await server.inject({ method: 'GET', url: '/scenarios/missing', query: scope });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SCENARIO_NOT_FOUND');
  });

  it('Persona保存→Scenario保存→実行→ScenarioRun取得がAPI経由で通る', async () => {
    await server.inject({ method: 'POST', url: '/personas', payload: personaBody() });
    await server.inject({ method: 'POST', url: '/scenarios', payload: scenarioBody() });

    // スクリプト: 疑似ユーザー発話 → Agent（Tool call → 応答）→ 疑似ユーザー終了 → アンケート。
    model.enqueue(
      { message: { role: 'assistant', content: JSON.stringify({ message: '先月の売上を教えて', endConversation: false, goalAchieved: false }) }, finishReason: 'stop', usage: { totalTokens: 10 } },
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'filter_scores', arguments: { score: 42 } }] }, finishReason: 'tool_calls', usage: { totalTokens: 5 } },
      { message: { role: 'assistant', content: '先月の売上は42です。' }, finishReason: 'stop', usage: { totalTokens: 5 } },
      { message: { role: 'assistant', content: JSON.stringify({ message: 'ありがとう', endConversation: true, goalAchieved: true }) }, finishReason: 'stop', usage: { totalTokens: 10 } },
      { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 5, impressions: 'すぐ得られた' }) }, finishReason: 'stop', usage: { totalTokens: 8 } },
    );

    const executed = await server.inject({ method: 'POST', url: '/scenarios/sales-check/run', payload: { scope, mode: 'preview' } });
    expect(executed.statusCode).toBe(200);
    const run = executed.json().run;
    expect(run).toMatchObject({
      scenario: { id: 'sales-check', version: '1.0.0' },
      status: 'completed',
      goalAchieved: true,
      impressions: 'すぐ得られた',
      metrics: {
        userTurns: 1, agentRuns: 1, totalToolCalls: 1,
        expectedToolHit: { expected: ['filter_scores'], called: ['filter_scores'], hitRate: 1 },
        usage: { totalTokens: 38 },
      },
    });
    expect(run.transcript).toMatchObject([
      { speaker: 'user', message: '先月の売上を教えて' },
      { speaker: 'agent', message: '先月の売上は42です。' },
    ]);
    expect(run.survey).toEqual([
      { questionId: 'q1', value: true },
      { questionId: 'q2', value: 5 },
      { questionId: 'impressions', value: 'すぐ得られた' },
    ]);

    // Agentターンは既存 RunRepository の Run を参照する（トレースへドリルダウン可能）。
    const agentRunId = run.transcript[1].runId;
    const trace = await server.inject({ method: 'GET', url: `/runs/${agentRunId}/trace`, query: scope });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().run.status).toBe('succeeded');

    // 一覧（scenarioId 絞り込み）と詳細。
    const list = await server.inject({ method: 'GET', url: '/scenario-runs', query: { ...scope, scenarioId: 'sales-check' } });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs).toHaveLength(1);
    expect(list.json().runs[0].id).toBe(run.id);
    expect((await server.inject({ method: 'GET', url: '/scenario-runs', query: { ...scope, scenarioId: 'other' } })).json().runs).toEqual([]);

    const detail = await server.inject({ method: 'GET', url: `/scenario-runs/${run.id}`, query: scope });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run).toEqual(run);
  });

  it('Persona登録→pseudoUser Scenario→実行でpseudoUserRef(agent)を記録し、kindで一覧する（v18）', async () => {
    await server.inject({ method: 'POST', url: '/personas', payload: personaBody() });
    // Persona を疑似ユーザーAgentとして登録する。
    const registered = await server.inject({ method: 'POST', url: '/personas/novice-user/register-agent', payload: { scope } });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().agent).toMatchObject({ kind: 'pseudo-user', metadata: { internalId: 'pseudo-novice-user', version: '1.0.0' }, persona: { personaId: 'novice-user', version: '1.0.0' }, tools: [] });

    // kind フィルタは pseudo-user のみ返す（normal の sales-agent は除外）。
    const filtered = await server.inject({ method: 'GET', url: '/agents', query: { ...scope, kind: 'pseudo-user' } });
    expect(filtered.json().agents.map((agent: { internalId: string }) => agent.internalId)).toEqual(['pseudo-novice-user']);

    // pseudoUser 参照の Scenario を保存する（persona ではなく agent）。
    const saved = await server.inject({ method: 'POST', url: '/scenarios', payload: scenarioBody({ persona: undefined, pseudoUser: { agentId: 'pseudo-novice-user', version: '1.0.0' } }) });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().scenario.pseudoUser).toEqual({ agentId: 'pseudo-novice-user', version: '1.0.0' });
    expect('persona' in saved.json().scenario).toBe(false);

    model.enqueue(
      { message: { role: 'assistant', content: JSON.stringify({ message: '売上は？', endConversation: false, goalAchieved: false }) }, finishReason: 'stop', usage: { totalTokens: 3 } },
      { message: { role: 'assistant', content: '42です。' }, finishReason: 'stop', usage: { totalTokens: 3 } },
      { message: { role: 'assistant', content: JSON.stringify({ message: 'ありがとう', endConversation: true, goalAchieved: true }) }, finishReason: 'stop', usage: { totalTokens: 3 } },
      { message: { role: 'assistant', content: JSON.stringify({ q1: true, q2: 4, impressions: 'ok' }) }, finishReason: 'stop', usage: { totalTokens: 3 } },
    );
    const executed = await server.inject({ method: 'POST', url: '/scenarios/sales-check/run', payload: { scope, mode: 'preview' } });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().run).toMatchObject({ status: 'completed', pseudoUserRef: { type: 'agent', id: 'pseudo-novice-user', version: '1.0.0' } });
  });

  it('実行の未存在Scenarioは404、未存在ScenarioRunは404', async () => {
    const missingScenario = await server.inject({ method: 'POST', url: '/scenarios/missing/run', payload: { scope } });
    expect(missingScenario.statusCode).toBe(404);
    expect(missingScenario.json().error.code).toBe('SCENARIO_NOT_FOUND');
    const missingRun = await server.inject({ method: 'GET', url: '/scenario-runs/missing', query: scope });
    expect(missingRun.statusCode).toBe(404);
    expect(missingRun.json().error.code).toBe('SCENARIO_RUN_NOT_FOUND');
  });
});
