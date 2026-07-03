import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const schema = { columns: [
  { name: 'name', type: 'string' as const, nullable: false },
  { name: 'score', type: 'number' as const, nullable: false },
] };

describe('POST /runs', () => {
  let model: ScriptedModelProvider;
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    model = new ScriptedModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
    await app.saveTool.execute({
      scope, internalId: 'score-tool', workingName: 'draft', displayName: 'Score', publishName: 'score_lookup', owner: 'owner', sideEffect: 'read-only',
      graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema, sample: { name: 'sample', score: 0 } } }], edges: [] },
      inputSchema: schema, outputSchema: schema,
    });
  });

  afterEach(async () => { await server.close(); app.close(); });

  it('saved Toolをtool callingしtrace付き応答を返す', async () => {
    model.enqueue(
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'Alice: 42' }, finishReason: 'stop' },
    );
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, tool: { internalId: 'score-tool', version: '1.0.0' }, systemPrompt: 'Use the tool.', message: 'Alice score?', mode: 'preview',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ response: 'Alice: 42', mode: 'preview', tool: { version: '1.0.0' } });
    expect(response.json().run.trace.map((event: { kind: string }) => event.kind)).toEqual([
      'model-request', 'tool-call', 'tool-result', 'model-request', 'model-response',
    ]);
    expect(response.json().run.trace[2].outputPreview).toEqual([{ name: 'Alice', score: 42 }]);
    const trace = await server.inject({ method: 'GET', url: `/runs/${response.json().run.runId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().run).toMatchObject({ status: 'succeeded', response: 'Alice: 42' });
  });

  it('不正body/versionを400へ変換する', async () => {
    const missing = await server.inject({ method: 'POST', url: '/runs', payload: { scope } });
    expect(missing.statusCode).toBe(400);
    const version = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, tool: { internalId: 'score-tool', version: 'latest' }, systemPrompt: 'x', message: 'x', mode: 'preview',
    } });
    expect(version.statusCode).toBe(400);
  });

  it('provider failureを502へ変換する', async () => {
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, tool: { internalId: 'score-tool' }, systemPrompt: 'x', message: 'x', mode: 'preview',
    } });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('MODEL_PROVIDER');
    expect(response.json().error.runId).toEqual(expect.any(String));
    const trace = await server.inject({ method: 'GET', url: `/runs/${response.json().error.runId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(trace.json().run).toMatchObject({ status: 'failed', failure: { code: 'MODEL_PROVIDER' } });
  });

  it('run一覧、status filter、scope分離を提供する', async () => {
    model.enqueue({ message: { role: 'assistant', content: 'direct' }, finishReason: 'stop' });
    await server.inject({ method: 'POST', url: '/runs', payload: { scope, tool: { internalId: 'score-tool' }, systemPrompt: 'x', message: 'x', mode: 'preview' } });
    const list = await server.inject({ method: 'GET', url: '/runs?tenantId=tenant&workspaceId=workspace&status=succeeded&limit=10' });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs).toEqual([expect.objectContaining({ status: 'succeeded', traceEventCount: 2 })]);
    const other = await server.inject({ method: 'GET', url: '/runs?tenantId=other&workspaceId=workspace' });
    expect(other.json().runs).toEqual([]);
    const missing = await server.inject({ method: 'GET', url: '/runs/nope/trace?tenantId=tenant&workspaceId=workspace' });
    expect(missing.statusCode).toBe(404);
  });

  it('write Toolを403で拒否する', async () => {
    await app.saveTool.execute({
      scope, internalId: 'write-tool', workingName: 'draft', displayName: 'Write', publishName: 'write_tool', owner: 'owner', sideEffect: 'write',
      graph: { nodes: [{ id: 'source', type: 'json-source', config: { rows: [] } }], edges: [] },
    });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, tool: { internalId: 'write-tool' }, systemPrompt: 'x', message: 'x', mode: 'preview',
    } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('UNSAFE_TOOL');
  });
});
