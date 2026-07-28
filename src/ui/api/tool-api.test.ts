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

  it('content-typeはbodyがある時だけ付与する（body無しDELETEをFastifyが空JSON本文として拒否するため）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ tools: [] }))
      .mockResolvedValueOnce(jsonResponse({ tool: {} }));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    await client.deleteTool('a/b', scope);
    await client.listTools(scope);
    await client.saveTool({ scope, internalId: 'a/b', workingName: 'w', displayName: 'd', publishName: 'p', owner: 'o', sideEffect: 'read-only', graph });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({});
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({});
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({ 'content-type': 'application/json' });
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

  it('非2xxをApiErrorへ正規化し、messageはローカライズ・原文はserverMessageへ保持する', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'ETL_GRAPH', message: 'broken graph' } }, 422));
    const client = new ToolApiClient('', fetcher as typeof fetch);
    const promise = client.inferDraft(graph);
    await expect(promise).rejects.toEqual(expect.objectContaining({
      status: 422, code: 'ETL_GRAPH', serverMessage: 'broken graph', name: 'ApiError',
      message: 'Please check the node connections (broken graph)',
    }));
  });

  it('Zod由来の生英語メッセージを画面表示用の文言へ変換する', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'BAD_REQUEST', message: 'invalid body: internalId: Too small: expected string to have >=1 characters; displayName: Invalid input: expected string, received undefined' },
    }, 400));
    const error = await new ToolApiClient('', fetcher as typeof fetch).saveTool({
      scope, internalId: '', workingName: 'w', displayName: '', publishName: 'p', owner: 'o', sideEffect: 'read-only', graph,
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Please check your input (Internal ID: is required, Display name: is required)',
      serverMessage: expect.stringContaining('Too small'),
    });
  });

  it('表示言語が日本語のときは日本語の文言を生成する', async () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue('ja') });
    try {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'HARNESS_NOT_FOUND', message: 'DeleteHarness: harness not found: support-bot' } }, 404));
      const error = await new ToolApiClient('', fetcher as typeof fetch).deleteHarness('support-bot', scope).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status: 404, message: 'マルチエージェント構成が見つかりませんでした（ID: support-bot）' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('HTMLなどJSON以外の応答を、構文エラーではなくAPI応答エラーとして扱う', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(new ToolApiClient('', fetcher as typeof fetch).listDataSources(scope)).rejects.toEqual(expect.objectContaining({ code: 'INVALID_API_RESPONSE', message: expect.stringContaining('non-JSON') }));
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

  it('data sourceの一覧・ファイル登録・DB登録・接続テスト・削除のwire contractを扱う', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ sources: [] }))
      .mockResolvedValueOnce(jsonResponse({ source: { id: 'file-1' } }))
      .mockResolvedValueOnce(jsonResponse({ source: { id: 'db-1' } }))
      .mockResolvedValueOnce(jsonResponse({ connections: [{ id: 'sales', driver: 'postgresql' }] }))
      .mockResolvedValueOnce(jsonResponse({ connection: { id: 'sales', driver: 'postgresql', available: true } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await client.listDataSources(scope);
    await client.uploadDataSourceFile({ scope, name: 'rows.csv', format: 'csv', content: 'a\n1' });
    await client.registerDatabaseDataSource({ scope, name: 'Sales', connectionId: 'sales' });
    await client.listDatabaseConnections();
    await client.testDatabaseConnection('sales', scope);
    await client.deleteDataSource('file/1', scope);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/data-sources?');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope, name: 'rows.csv', format: 'csv', content: 'a\n1' }) });
    expect(fetcher.mock.calls[2]?.[0]).toBe('/api/data-sources/databases');
    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/data-sources/connections');
    expect(fetcher.mock.calls[4]?.[0]).toContain('/connections/sales/test');
    expect(fetcher.mock.calls[5]?.[0]).toContain('/data-sources/file%2F1?');
  });

  it('検索provider一覧と明示検索取得のwire contractを扱う', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ providers: [{ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true }] }))
      .mockResolvedValueOnce(jsonResponse({ search: { cacheKey: 'cache-1', provider: 'tavily', query: 'LLMOps', maxResults: 3, includeDomains: [], rows: [], retrievedAt: '2026-07-12T00:00:00.000Z', expiresAt: '2026-07-12T00:15:00.000Z' } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await expect(client.listSearchProviders()).resolves.toMatchObject([{ id: 'tavily' }]);
    await expect(client.fetchWebSearch({ scope, provider: 'tavily', query: 'LLMOps', maxResults: 3 })).resolves.toMatchObject({ cacheKey: 'cache-1' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/search-providers');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope, provider: 'tavily', query: 'LLMOps', maxResults: 3 }) });
  });

  it('Agent SessionとArtifactのwire contractを扱う', async () => {
    const session = { id: 'session-1', status: 'active' };
    const artifact = { id: 'artifact-1', sessionId: 'session-1', name: 'result', kind: 'table' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ session }))
      .mockResolvedValueOnce(jsonResponse({ session: { ...session, status: 'closed' } }))
      .mockResolvedValueOnce(jsonResponse({ artifacts: [artifact] }))
      .mockResolvedValueOnce(jsonResponse({ artifact, payload: { rows: [] } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await client.createAgentSession({ scope, agent: { internalId: 'agent', version: '1.0.0' } });
    await client.closeAgentSession('session/1', scope);
    await client.listSessionArtifacts('session/1', scope);
    await client.getSessionArtifact('session/1', 'artifact/1', scope, 25, 50, 'edges');
    await client.deleteSessionArtifact('session/1', 'artifact/1', scope);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/agent-sessions');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/agent-sessions/session%2F1/close');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/artifacts?');
    expect(fetcher.mock.calls[3]?.[0]).toContain('limit=25');
    expect(fetcher.mock.calls[3]?.[0]).toContain('offset=50');
    expect(fetcher.mock.calls[3]?.[0]).toContain('section=edges');
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('legacy health, evaluation, and memory endpoints retain their wire contracts', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ agent: { metadata: { version: '1.0.0' } } }))
      .mockResolvedValueOnce(jsonResponse({ evaluation: { score: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ pages: [] }))
      .mockResolvedValueOnce(jsonResponse({ page: { id: 'page' } }))
      .mockResolvedValueOnce(jsonResponse({ page: { id: 'page' } }))
      .mockResolvedValueOnce(jsonResponse({ proposals: [] }))
      .mockResolvedValueOnce(jsonResponse({ proposals: [] }))
      .mockResolvedValueOnce(jsonResponse({ proposal: { id: 'proposal' } }))
      .mockResolvedValueOnce(jsonResponse({ proposal: { id: 'proposal' } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await client.health();
    await client.registerPseudoUserAgent('persona/a', { scope, personaVersion: '1.0.0' });
    await client.evaluate({ scope, input: 'question', output: 'answer' });
    await client.listWiki(scope, 'refund');
    await client.getWiki('page/1', scope);
    await client.saveWiki({ scope, title: 'Policy', tags: [], body: 'text' });
    await client.reflectRun({ scope, input: 'question', output: 'answer', sourceRunId: 'run-1' });
    await client.listProposals(scope, 'draft');
    await client.approveProposal('proposal/1', scope);
    await client.rejectProposal('proposal/1', scope);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/health');
    expect(fetcher.mock.calls[1]?.[0]).toContain('persona%2Fa/register-agent');
    expect(fetcher.mock.calls[3]?.[0]).toContain('q=refund');
    expect(fetcher.mock.calls[7]?.[0]).toContain('state=draft');
    expect(fetcher.mock.calls[8]?.[0]).toContain('proposal%2F1/approve');
  });

  it('omits optional query parameters when callers do not supply them', async () => {
    const fetcher = vi.fn();
    fetcher.mockImplementation(() => Promise.resolve(jsonResponse({ tool: {}, agents: [], runs: [], persona: {}, scenario: {}, dataset: {}, pages: [], proposals: [], experiments: [] })));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await client.getTool('tool', scope);
    await client.listAgents(scope, 'normal');
    await client.listRuns(scope);
    await client.getPersona('persona', scope);
    await client.listScenarioRuns(scope);
    await client.getEvaluationDataset('dataset', scope);
    await client.listExperiments(scope);
    await client.listWiki(scope);
    await client.listWikiPages('wiki', scope);
    await client.listProposals(scope);
    expect(fetcher.mock.calls[0]?.[0]).not.toContain('version=');
    expect(fetcher.mock.calls[2]?.[0]).not.toContain('limit=');
    expect(fetcher.mock.calls[7]?.[0]).not.toContain('q=');
  });

  it('operations status、feedback、retentionのwire contractを扱う', async () => {
    const feedback = { id: 'feedback-1', runId: 'run-1' };
    const policy = { scope, payloadDays: 30, traceDays: 14, aggregateDays: 365, updatedAt: 'now' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: { summary: { runCount: 1 }, points: [] } }))
      .mockResolvedValueOnce(jsonResponse({ feedback: null }))
      .mockResolvedValueOnce(jsonResponse({ feedback }))
      .mockResolvedValueOnce(jsonResponse({ policy }))
      .mockResolvedValueOnce(jsonResponse({ policy }))
      .mockResolvedValueOnce(jsonResponse({ result: { deleted: 1 } }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await client.getOperationsStatus(scope, 7);
    await client.getRunFeedback('run/1', scope);
    await client.submitRunFeedback('run/1', { scope, thumb: 'down', rating: 2, comment: 'wrong', issueTags: ['incorrect'] });
    await client.getRetentionPolicy(scope);
    await client.saveRetentionPolicy({ scope, payloadDays: 30, traceDays: 14, aggregateDays: 365 });
    await client.applyRetention(scope);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/operations/status?');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/runs/run%2F1/feedback?');
    expect(fetcher.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'PUT' }));
    expect(fetcher.mock.calls[5]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ scope }) }));
  });

  it('バックアップのwire contractを扱う（スコープを送らず、鍵の同梱は明示する）', async () => {
    const backup = { name: 'backup-20260728-093012345', path: '/backups/backup-20260728-093012345', manifest: { formatVersion: 1 }, warnings: [] };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ root: '/backups', backups: [] }))
      .mockResolvedValueOnce(jsonResponse({ backup }))
      .mockResolvedValueOnce(jsonResponse({ backup }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    expect(await client.listBackups()).toEqual({ root: '/backups', backups: [] });
    expect((await client.createBackup()).name).toBe('backup-20260728-093012345');
    await client.createBackup(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/operations/backups');
    expect(fetcher.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ includeSecretKey: false }) }));
    expect(fetcher.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'POST', body: JSON.stringify({ includeSecretKey: true }) }));
  });

  it('複数WikiとWiki内ページのwire contractを扱う', async () => {
    const wiki = { id: 'customer-a', name: 'Customer A' }; const page = { id: 'page-1', wikiId: 'customer-a' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ wikis: [wiki] }))
      .mockResolvedValueOnce(jsonResponse({ wiki }))
      .mockResolvedValueOnce(jsonResponse({ wiki }))
      .mockResolvedValueOnce(jsonResponse({ pages: [page] }))
      .mockResolvedValueOnce(jsonResponse({ page }))
      .mockResolvedValueOnce(jsonResponse({ page }));
    const client = new ToolApiClient('/api', fetcher as typeof fetch);
    await client.listWikis(scope); await client.getWikiSpace('customer/a', scope); await client.saveWikiSpace({ scope, id: 'customer-a', name: 'Customer A' });
    await client.listWikiPages('customer/a', scope, 'refund'); await client.getWikiPage('customer/a', 'page/1', scope); await client.saveWikiPage('customer/a', { scope, title: 'Policy', tags: [], body: 'text' });
    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/wikis?');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/wikis/customer%2Fa?');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/api/wikis/customer%2Fa/pages?');
    expect(fetcher.mock.calls[3]?.[0]).toContain('q=refund');
    expect(fetcher.mock.calls[4]?.[0]).toContain('/pages/page%2F1?');
    expect(fetcher.mock.calls[5]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
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
