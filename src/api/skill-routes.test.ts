import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('skill routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app);
    await server.inject({ method: 'POST', url: '/tools', payload: {
      scope, internalId: 'scores', workingName: 'Scores', displayName: 'Score filter', publishName: 'filter_scores', owner: 'owner', sideEffect: 'read-only',
      graph: { nodes: [{ id: 'source', type: 'agent-input', config: { schema: { columns: [{ name: 'score', type: 'number', nullable: false }] }, sample: { score: 1 } } }], edges: [] },
      inputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] }, outputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
    } });
  });
  afterEach(async () => { await server.close(); app.close(); });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      scope, internalId: 'analysis', workingName: 'Analysis', displayName: 'Data analysis', publishName: 'data_analysis', owner: 'owner',
      responsibility: 'Analyze data.', activationCondition: 'Use for data questions.', inputDescription: 'A request and data.', outputDescription: 'A grounded answer.',
      instructions: 'Use filter_scores.', tools: [{ internalId: 'scores', version: '1.0.0' }], ...overrides,
    };
  }

  it('Skill save/list/get/versionsをversion固定DTOで公開する', async () => {
    const first = await server.inject({ method: 'POST', url: '/skills', payload: body() });
    expect(first.statusCode).toBe(201);
    expect(first.json().skill).toMatchObject({ metadata: { version: '1.0.0' }, tools: [{ internalId: 'scores', version: '1.0.0' }] });
    const second = await server.inject({ method: 'POST', url: '/skills', payload: body({ instructions: 'Reviewed.', bump: 'minor' }) });
    expect(second.json().skill.metadata.version).toBe('1.1.0');

    expect((await server.inject({ method: 'GET', url: '/skills', query: scope })).json().skills)
      .toMatchObject([{ internalId: 'analysis', latestVersion: '1.1.0' }]);
    const get = await server.inject({ method: 'GET', url: '/skills/analysis', query: { ...scope, version: '1.0.0' } });
    expect(get.json().skill.instructions).toBe('Use filter_scores.');
    expect((await server.inject({ method: 'GET', url: '/skills/analysis/versions', query: scope })).json())
      .toEqual({ versions: ['1.0.0', '1.1.0'] });
  });

  it('未保存・保存済みSkillのprompt草案を生成する', async () => {
    const draft = await server.inject({ method: 'POST', url: '/skill-drafts/generate-prompt', payload: {
      scope, displayName: 'Data analysis', responsibility: 'Analyze data.', activationCondition: 'For data questions.',
      inputDescription: 'Data.', outputDescription: 'Answer.', tools: [{ internalId: 'scores', version: '1.0.0' }],
    } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().draft.promptDraft).toContain('filter_scores@1.0.0');
    expect(draft.json().draft.sources).toEqual(['tool:filter_scores@1.0.0']);

    await server.inject({ method: 'POST', url: '/skills', payload: body() });
    const saved = await server.inject({ method: 'POST', url: '/skills/analysis/generate-prompt', payload: { scope } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft.sections.responsibility).toContain('Data analysis');
  });

  it('不正version・未存在Tool・別scopeを境界エラーへ変換する', async () => {
    const bad = await server.inject({ method: 'POST', url: '/skills', payload: body({ tools: [{ internalId: 'scores', version: 'bad' }] }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');
    const missing = await server.inject({ method: 'POST', url: '/skills', payload: body({ tools: [{ internalId: 'missing', version: '1.0.0' }] }) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('SKILL_VALIDATION');
    await server.inject({ method: 'POST', url: '/skills', payload: body() });
    const hidden = await server.inject({ method: 'GET', url: '/skills/analysis', query: { tenantId: 'other', workspaceId: 'workspace' } });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('SKILL_NOT_FOUND');
  });

  it('保存済みSkillを論理削除できる（listからは除外、GETはfindLatestのため404、pinned versionはfindVersionで残る）', async () => {
    const saved = await server.inject({ method: 'POST', url: '/skills', payload: body() });
    expect(saved.statusCode).toBe(201);

    const deleted = await server.inject({ method: 'DELETE', url: '/skills/analysis', query: scope });
    expect(deleted.statusCode).toBe(204);

    const listed = await server.inject({ method: 'GET', url: '/skills', query: scope });
    expect(listed.json().skills).toEqual([]);

    const getLatest = await server.inject({ method: 'GET', url: '/skills/analysis', query: scope });
    expect(getLatest.statusCode).toBe(404);
    expect(getLatest.json().error).toMatchObject({ code: 'SKILL_NOT_FOUND' });

    const getPinned = await server.inject({ method: 'GET', url: '/skills/analysis', query: { ...scope, version: '1.0.0' } });
    expect(getPinned.statusCode).toBe(200);
    expect(getPinned.json().skill.metadata.version).toBe('1.0.0');

    const again = await server.inject({ method: 'DELETE', url: '/skills/analysis', query: scope });
    expect(again.statusCode).toBe(404);
  });

  it('未存在のSkillを削除すると404を返す', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/skills/missing-skill', query: scope });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });
});
