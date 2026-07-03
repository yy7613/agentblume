import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('agent routes', () => {
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
    return { scope, internalId: 'assistant', workingName: 'Assistant', displayName: 'Assistant', publishName: 'assistant', owner: 'owner', kind: 'normal', systemPrompt: 'Use tools.', tools: [{ internalId: 'scores', version: '1.0.0' }], ...overrides };
  }

  it('Tool一覧、Agent save/list/get/versionsをHTTP DTOで公開する', async () => {
    const toolList = await server.inject({ method: 'GET', url: '/tools', query: scope });
    expect(toolList.json().tools).toMatchObject([{ internalId: 'scores', latestVersion: '1.0.0' }]);

    const first = await server.inject({ method: 'POST', url: '/agents', payload: body({ output: { name: 'assistant_response', fields: [{ name: 'answer', type: 'string', required: true }] } }) });
    expect(first.statusCode).toBe(201);
    expect(first.json().agent.metadata.version).toBe('1.0.0');
    expect(first.json().agent.output).toEqual({ name: 'assistant_response', fields: [{ name: 'answer', type: 'string', required: true }] });
    const second = await server.inject({ method: 'POST', url: '/agents', payload: body() });
    expect(second.json().agent.metadata.version).toBe('1.0.1');

    const list = await server.inject({ method: 'GET', url: '/agents', query: scope });
    expect(list.json().agents).toMatchObject([{ internalId: 'assistant', latestVersion: '1.0.1', kind: 'normal' }]);
    const get = await server.inject({ method: 'GET', url: '/agents/assistant', query: { ...scope, version: '1.0.0' } });
    expect(get.json().agent.systemPrompt).toBe('Use tools.');
    const versions = await server.inject({ method: 'GET', url: '/agents/assistant/versions', query: scope });
    expect(versions.json()).toEqual({ versions: ['1.0.0', '1.0.1'] });
  });

  it('未保存・保存済みAgentのprompt草案を生成する', async () => {
    const draft = await server.inject({ method: 'POST', url: '/agent-drafts/generate-prompt', payload: { scope, displayName: 'Evaluator', kind: 'evaluator', tools: [{ internalId: 'scores', version: '1.0.0' }] } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().draft.systemPromptDraft).toContain('filter_scores@1.0.0');
    expect(draft.json().draft.editable).toBe(true);

    await server.inject({ method: 'POST', url: '/agents', payload: body() });
    const saved = await server.inject({ method: 'POST', url: '/agents/assistant/generate-prompt', payload: { scope } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft.sections.toolUsageGuide).toContain('score:number');
  });

  it('不正version・未存在Tool・別scopeを境界エラーへ変換する', async () => {
    const badVersion = await server.inject({ method: 'POST', url: '/agents', payload: body({ tools: [{ internalId: 'scores', version: 'bad' }] }) });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().error.code).toBe('BAD_REQUEST');
    const missing = await server.inject({ method: 'POST', url: '/agents', payload: body({ tools: [{ internalId: 'missing', version: '1.0.0' }] }) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('AGENT_VALIDATION');
    await server.inject({ method: 'POST', url: '/agents', payload: body() });
    const hidden = await server.inject({ method: 'GET', url: '/agents/assistant', query: { tenantId: 'other', workspaceId: 'workspace' } });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('AGENT_NOT_FOUND');
  });
});
