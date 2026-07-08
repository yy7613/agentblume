import { describe, expect, it, vi } from 'vitest';
import { ToolApiClient } from './tool-api';
import type { ToolGraphDto } from './types';

const graph: ToolGraphDto = { nodes: [{ id: 'source', type: 'json-source', config: { rows: [] } }], edges: [] };
const scope = { tenantId: 'tenant a', workspaceId: 'workspace/1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ToolApiClient', () => {
  it('fetcherをglobalThisへ束縛してブラウザのIllegal invocationを防ぐ', async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse({ tools: [] }));
    });
    await expect(new ToolApiClient('', fetcher as typeof fetch).listTools(scope)).resolves.toEqual([]);
  });

  it('draft infer/preview を正しい body と AbortSignal で呼ぶ', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ propagation: { order: ['source'], nodes: {}, hasErrors: false } }))
      .mockResolvedValueOnce(jsonResponse({ result: { terminalId: 'source', output: { schema: { columns: [] }, rows: [] }, nodes: {} } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();

    await expect(client.inferDraft(graph, controller.signal)).resolves.toMatchObject({ hasErrors: false });
    await expect(client.previewDraft(graph, 25, controller.signal)).resolves.toMatchObject({ terminalId: 'source' });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/tool-drafts/infer-schema', expect.objectContaining({
      method: 'POST', signal: controller.signal, body: JSON.stringify({ graph }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/tool-drafts/preview', expect.objectContaining({
      body: JSON.stringify({ graph, rowLimit: 25 }),
    }));
  });

  it('save、versions、version固定取得の wire contract を扱う', async () => {
    const tool = { metadata: { version: '1.0.0' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tool }))
      .mockResolvedValueOnce(jsonResponse({ versions: ['1.0.0'] }))
      .mockResolvedValueOnce(jsonResponse({ tool }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const input = { scope, internalId: 'a/b', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o', sideEffect: 'read-only' as const, graph };

    await client.saveTool(input);
    await expect(client.listVersions('a/b', scope)).resolves.toEqual(['1.0.0']);
    await client.getTool('a/b', scope, '1.0.0');

    expect(fetcher.mock.calls[0]?.[0]).toBe('/tools');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/tools/a%2Fb/versions?');
    expect(fetcher.mock.calls[2]?.[0]).toContain('version=1.0.0');
  });

  it('非2xxをApiErrorへ正規化する', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'ETL_GRAPH', message: 'broken graph' } }, 422));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const promise = client.inferDraft(graph);
    await expect(promise).rejects.toEqual(expect.objectContaining({ status: 422, code: 'ETL_GRAPH', message: 'broken graph', name: 'ApiError' }));
  });

  it('Agent runをversion固定bodyとAbortSignalで呼ぶ', async () => {
    const run = { runId: 'run-1', response: 'done', trace: [] };
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ run }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    const input = { scope, tool: { internalId: 'tool-1', version: '1.0.0' }, systemPrompt: 'Use tools', message: 'go', mode: 'preview' as const };
    await expect(client.runAgent(input, controller.signal)).resolves.toMatchObject(run);
    expect(fetcher).toHaveBeenCalledWith('/api/runs', expect.objectContaining({
      method: 'POST', body: JSON.stringify(input), signal: controller.signal,
    }));
  });

  it('run list/traceをscope付きで取得し失敗runIdを保持する', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ runs: [{ runId: 'run-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ run: { runId: 'run-1', trace: [] } }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'MODEL_PROVIDER', message: 'offline', runId: 'run-2' } }, 502));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    await client.listRuns(scope, { limit: 10, status: 'failed' });
    await client.getRunTrace('run/1', scope);
    const error = await client.runAgent({ scope, tool: { internalId: 'x' }, systemPrompt: 'x', message: 'x', mode: 'preview' }).catch((cause: unknown) => cause);
    expect(fetcher.mock.calls[0]?.[0]).toContain('limit=10');
    expect(fetcher.mock.calls[0]?.[0]).toContain('status=failed');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/runs/run%2F1/trace?');
    expect(error).toMatchObject({ code: 'MODEL_PROVIDER', runId: 'run-2' });
  });

  it('標準形式でないHTTPエラーにもfallbackを使う', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(new ToolApiClient('', fetcher as typeof fetch).inferDraft(graph)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('Agent BuilderのTool一覧・prompt生成・保存contractを扱う', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tools: [{ internalId: 'tool', latestVersion: '1.0.0' }] }))
      .mockResolvedValueOnce(jsonResponse({ draft: { systemPromptDraft: 'draft' } }))
      .mockResolvedValueOnce(jsonResponse({ agent: { metadata: { version: '1.0.0' } } }))
      .mockResolvedValueOnce(jsonResponse({ agents: [{ internalId: 'agent' }] }))
      .mockResolvedValueOnce(jsonResponse({ run: { runId: 'run-1', response: 'done' } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const refs = [{ internalId: 'tool', version: '1.0.0' }];
    await client.listTools(scope);
    await client.generateAgentPrompt({ scope, displayName: 'Agent', kind: 'normal', tools: refs });
    await client.saveAgent({ scope, internalId: 'agent', workingName: 'Agent', displayName: 'Agent', publishName: 'agent', owner: 'owner', kind: 'normal', systemPrompt: 'draft', tools: refs });
    await client.listAgents(scope);
    await client.runSavedAgent({ scope, agent: { internalId: 'agent', version: '1.0.0' }, message: 'go', mode: 'preview' });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/api/agent-drafts/generate-prompt', '/api/agents']));
  });

  it('Skill Builderのprompt生成・保存・一覧contractを扱う', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ draft: { promptDraft: 'draft' } }))
      .mockResolvedValueOnce(jsonResponse({ skill: { metadata: { version: '1.0.0' } } }))
      .mockResolvedValueOnce(jsonResponse({ skills: [{ internalId: 'analysis', latestVersion: '1.0.0' }] }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const fields = {
      scope, displayName: 'Analysis', responsibility: 'Analyze.', activationCondition: 'For data.',
      inputDescription: 'Data.', outputDescription: 'Answer.', tools: [{ internalId: 'tool', version: '1.0.0' }],
    };
    await client.generateSkillPrompt(fields);
    await client.saveSkill({ ...fields, internalId: 'analysis', workingName: 'Analysis', publishName: 'analysis', owner: 'owner', instructions: 'draft' });
    await client.listSkills(scope);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/skill-drafts/generate-prompt', '/api/skills', expect.stringContaining('/api/skills?'),
    ]);
    const savedBody = JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit | undefined)?.body));
    expect(savedBody).toMatchObject({ internalId: 'analysis', instructions: 'draft', tools: [{ internalId: 'tool', version: '1.0.0' }] });
  });

  it('getAgentをURLエンコード済みidとscope/versionクエリ・AbortSignalで取得する', async () => {
    const agent = { metadata: { internalId: 'a/b', version: '2.0.0' }, kind: 'normal', skills: [], tools: [] };
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ agent }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    const controller = new AbortController();
    await expect(client.getAgent('a/b', scope, '2.0.0', controller.signal)).resolves.toMatchObject({ kind: 'normal' });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/agents/a%2Fb?');
    expect(url).toContain('version=2.0.0');
    expect(init.signal).toBe(controller.signal);
  });

  it('getAgentはversion未指定ならversionクエリを付けない', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ agent: { kind: 'normal', skills: [], tools: [] } }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    await client.getAgent('agent', scope);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('version=');
  });
});
