import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import type { ModelCapability } from '../application/model/model-provider';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { explicitRouteAuthorization } from './authorization';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const fullHarness = { fileMemory: false, todoProvider: false, compaction: false, webSearch: false, toolApproval: false, functionInvocation: true };

describe('agent routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
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

  it('GET /agents/:id/diagnostics がツール呼び出しのプリフライト診断を返す', async () => {
    await server.inject({ method: 'POST', url: '/agents', payload: body() });
    const res = await server.inject({ method: 'GET', url: '/agents/assistant/diagnostics', query: scope });
    expect(res.statusCode).toBe(200);
    const { diagnostics } = res.json();
    expect(diagnostics.status).toBe('ok');
    expect(diagnostics.agent).toEqual({ internalId: 'assistant', version: '1.0.0' });
    expect(diagnostics.checks).toEqual(expect.arrayContaining([
      { id: 'skills', status: 'ok' },
      { id: 'function-names', status: 'ok' },
    ]));
    expect(diagnostics.tools).toMatchObject([{ internalId: 'scores', version: '1.0.0', source: 'direct', functionName: 'filter_scores', status: 'ok' }]);
    expect(diagnostics.tools[0].checks).toEqual(expect.arrayContaining([
      { id: 'resolved', status: 'ok' },
      { id: 'agent-input', status: 'ok' },
      { id: 'execution', status: 'ok' },
    ]));

    const missing = await server.inject({ method: 'GET', url: '/agents/no-such-agent/diagnostics', query: scope });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /agent-drafts/diagnose は未保存Agentを保存せずに診断し、版は 0.0.0 で報告する', async () => {
    const res = await server.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body({ mcpServers: ['ghost'], harness: { ...fullHarness, fileMemory: true } }) });
    expect(res.statusCode).toBe(200);
    const { diagnostics } = res.json();
    expect(diagnostics.agent).toEqual({ internalId: 'assistant', version: '0.0.0' });
    expect(diagnostics.status).toBe('error');
    expect(diagnostics.checks).toEqual(expect.arrayContaining([
      { id: 'model', status: 'ok' },
      { id: 'mcp-servers', status: 'error', detail: 'referenced MCP server not found: ghost' },
      { id: 'harness', status: 'warning', detail: 'harness enables file memory but the agent references no wiki, so memory tools have nothing to read' },
    ]));
    expect(diagnostics.tools).toMatchObject([{ internalId: 'scores', version: '1.0.0', source: 'direct', functionName: 'filter_scores', status: 'ok' }]);
    expect(diagnostics.tools[0].checks).toEqual(expect.arrayContaining([{ id: 'resolved', status: 'ok' }, { id: 'state', status: 'ok' }]));
    // 保存はされない。
    expect((await server.inject({ method: 'GET', url: '/agents/assistant', query: scope })).statusCode).toBe(404);

    // 登録済みの MCP サーバーは ok、disabled は warning（実行時は黙ってスキップされる）。
    const registered = await server.inject({ method: 'POST', url: '/mcp-servers', payload: { scope, server: { name: 'files', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: {} }, disabled: true } } });
    expect(registered.statusCode).toBe(201);
    const paused = await server.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body({ mcpServers: ['files'] }) });
    expect(paused.json().diagnostics.checks).toEqual(expect.arrayContaining([
      { id: 'mcp-servers', status: 'warning', detail: "MCP server 'files' is disabled, so its tools are skipped at run time" },
    ]));

    const invalid = await server.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body({ tools: [{ internalId: 'scores', version: 'bad' }] }) });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('BAD_REQUEST');
    // 保存と同じ createAgent 検証を通す（pseudo-user に Tool は付けられない）。
    const rejected = await server.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body({ kind: 'pseudo-user' }) });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('AGENT_VALIDATION');
  });

  it('POST /agent-drafts/diagnose は設定中モデルの能力不足を実行前に報告する', async () => {
    class ChatOnlyModel extends ScriptedModelProvider { override capabilities(): readonly ModelCapability[] { return ['chat']; } }
    const chatOnlyApp = createApp({ profile: 'test', modelProvider: new ChatOnlyModel() });
    const chatOnlyServer = buildServer(chatOnlyApp, { authentication: new SingleUserAuthentication(scope) });
    try {
      const res = await chatOnlyServer.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body({ output: { name: 'assistant_response', fields: [{ name: 'answer', type: 'string', required: true }] } }) });
      expect(res.statusCode).toBe(200);
      expect(res.json().diagnostics.checks).toEqual(expect.arrayContaining([
        { id: 'model', status: 'error', detail: 'configured model provider does not support tool-calling; configured model provider does not support structured output' },
      ]));
      // functionInvocation:false かつ output 無しならこのモデルでも動く。
      const plain = await chatOnlyServer.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body({ harness: { ...fullHarness, functionInvocation: false } }) });
      expect(plain.json().diagnostics.checks).toEqual(expect.arrayContaining([{ id: 'model', status: 'ok' }]));
    } finally {
      await chatOnlyServer.close();
      chatOnlyApp.close();
    }
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

  it('version固定Skillを保存しinstructionsと依存Toolをpromptへ展開する', async () => {
    const skill = await server.inject({ method: 'POST', url: '/skills', payload: {
      scope, internalId: 'analysis', workingName: 'Analysis', displayName: 'Analysis', publishName: 'analysis', owner: 'owner',
      responsibility: 'Analyze scores.', activationCondition: 'For score questions.', inputDescription: 'Scores.', outputDescription: 'Answer.', instructions: 'Ground every answer in score data.',
      tools: [{ internalId: 'scores', version: '1.0.0' }],
    } });
    expect(skill.statusCode).toBe(201);
    const saved = await server.inject({ method: 'POST', url: '/agents', payload: body({ skills: [{ internalId: 'analysis', version: '1.0.0' }], tools: [] }) });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().agent.skills).toEqual([{ internalId: 'analysis', version: '1.0.0' }]);
    const prompt = await server.inject({ method: 'POST', url: '/agents/assistant/generate-prompt', payload: { scope } });
    expect(prompt.json().draft.systemPromptDraft).toContain('Ground every answer in score data.');
    expect(prompt.json().draft.systemPromptDraft).toContain('filter_scores@1.0.0');
  });

  it('ランタイムハーネス設定をHTTP DTOで保存・取得でき、不完全な設定は400にする', async () => {
    const harness = { fileMemory: true, todoProvider: true, compaction: true, webSearch: false, toolApproval: false, functionInvocation: true };
    const saved = await server.inject({ method: 'POST', url: '/agents', payload: body({ harness }) });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().agent.harness).toEqual(harness);
    const fetched = await server.inject({ method: 'GET', url: '/agents/assistant', query: scope });
    expect(fetched.json().agent.harness).toEqual(harness);

    // harness未指定は従来どおりフィールドを持たない。
    const plain = await server.inject({ method: 'POST', url: '/agents', payload: body() });
    expect(plain.json().agent.harness).toBeUndefined();

    const partial = await server.inject({ method: 'POST', url: '/agents', payload: body({ harness: { fileMemory: true } }) });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error.code).toBe('BAD_REQUEST');
  });

  it('MCPサーバー参照をHTTP DTOで保存・取得でき、件数超過は400にする', async () => {
    const saved = await server.inject({ method: 'POST', url: '/agents', payload: body({ mcpServers: ['files', 'github'] }) });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().agent.mcpServers).toEqual(['files', 'github']);
    const fetched = await server.inject({ method: 'GET', url: '/agents/assistant', query: scope });
    expect(fetched.json().agent.mcpServers).toEqual(['files', 'github']);

    // 未指定は従来どおりフィールドを持たない（MCPツールなし）。
    const plain = await server.inject({ method: 'POST', url: '/agents', payload: body() });
    expect(plain.json().agent.mcpServers).toBeUndefined();

    const tooMany = await server.inject({ method: 'POST', url: '/agents', payload: body({ mcpServers: Array.from({ length: 9 }, (_, index) => `s${index}`) }) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe('BAD_REQUEST');
    const duplicated = await server.inject({ method: 'POST', url: '/agents', payload: body({ mcpServers: ['files', 'files'] }) });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json().error.code).toBe('AGENT_VALIDATION');
  });

  it('不正version・未存在Tool・別scopeを境界エラーへ変換する', async () => {
    const badVersion = await server.inject({ method: 'POST', url: '/agents', payload: body({ tools: [{ internalId: 'scores', version: 'bad' }] }) });
    expect(badVersion.statusCode).toBe(400);
    expect(badVersion.json().error.code).toBe('BAD_REQUEST');
    const missing = await server.inject({ method: 'POST', url: '/agents', payload: body({ tools: [{ internalId: 'missing', version: '1.0.0' }] }) });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('AGENT_VALIDATION');
    await server.inject({ method: 'POST', url: '/agents', payload: body() });
    // 別テナントのPrincipalからは見えない。**同じリポジトリ**（同じapp）を別Principalのサーバーで見る。
    const otherServer = buildServer(app, { authentication: new SingleUserAuthentication({ tenantId: 'other', workspaceId: 'workspace' }) });
    const hidden = await otherServer.inject({ method: 'GET', url: '/agents/assistant', query: scope });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('AGENT_NOT_FOUND');
    await otherServer.close();
  });

  it('保存済みAgentを論理削除できる（listからは除外、GETはfindLatestのため404、pinned versionはfindVersionで残る）', async () => {
    const saved = await server.inject({ method: 'POST', url: '/agents', payload: body() });
    expect(saved.statusCode).toBe(201);

    const deleted = await server.inject({ method: 'DELETE', url: '/agents/assistant', query: scope });
    expect(deleted.statusCode).toBe(204);

    const listed = await server.inject({ method: 'GET', url: '/agents', query: scope });
    expect(listed.json().agents).toEqual([]);

    const getLatest = await server.inject({ method: 'GET', url: '/agents/assistant', query: scope });
    expect(getLatest.statusCode).toBe(404);
    expect(getLatest.json().error).toMatchObject({ code: 'AGENT_NOT_FOUND' });

    const getPinned = await server.inject({ method: 'GET', url: '/agents/assistant', query: { ...scope, version: '1.0.0' } });
    expect(getPinned.statusCode).toBe(200);
    expect(getPinned.json().agent.metadata.version).toBe('1.0.0');

    const again = await server.inject({ method: 'DELETE', url: '/agents/assistant', query: scope });
    expect(again.statusCode).toBe(404);
  });

  it('未存在のAgentを削除すると404を返す', async () => {
    const response = await server.inject({ method: 'DELETE', url: '/agents/missing-agent', query: scope });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  describe('POST /agent-drafts/diagnose 境界・異常系', () => {
    const TOKEN = 'r'.repeat(40);
    /** 指定ロールだけを持つ主体として認証する最小の port（authorization.test.ts と同じ形）。 */
    function rolesAuth(roles: readonly AuthorizationRole[]): AuthenticationPort {
      return {
        mode: 'token', required: true,
        authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
          ? authenticated({ subject: 'rita', ...scope, roles })
          : rejected('missing-credentials'),
      };
    }
    const diagnoseDraft = (payload: Record<string, unknown>) => server.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload });

    it('不正 body は 400 BAD_REQUEST で、違反したフィールドのパスをメッセージに含める', async () => {
      const emptyPrompt = await diagnoseDraft(body({ systemPrompt: '' }));
      expect(emptyPrompt.statusCode).toBe(400);
      expect(emptyPrompt.json().error).toMatchObject({ code: 'BAD_REQUEST' });
      expect(emptyPrompt.json().error.message).toContain('systemPrompt');
      const partialHarness = await diagnoseDraft(body({ harness: { fileMemory: true } }));
      expect(partialHarness.statusCode).toBe(400);
      expect(partialHarness.json().error.message).toContain('harness');
    });

    it('参照切れ（Tool / Skill / サブエージェント）は 404 ではなく 200 の error 検査として返す', async () => {
      const res = await diagnoseDraft(body({
        tools: [{ internalId: 'missing-tool', version: '1.0.0' }],
        skills: [{ internalId: 'missing-skill', version: '1.0.0' }],
        agents: [{ internalId: 'ghost', version: '1.0.0', usage: 'delegate' }],
      }));
      expect(res.statusCode).toBe(200);
      const { diagnostics } = res.json();
      expect(diagnostics.status).toBe('error');
      expect(diagnostics.checks).toEqual(expect.arrayContaining([
        { id: 'skills', status: 'error', detail: 'referenced skill not found: missing-skill@1.0.0' },
        { id: 'sub-agents', status: 'error', detail: 'referenced sub-agent not found: ghost@1.0.0' },
      ]));
      expect(diagnostics.tools).toEqual([{
        internalId: 'missing-tool', version: '1.0.0', source: 'direct', status: 'error',
        checks: [{ id: 'resolved', status: 'error', detail: 'referenced tool not found: missing-tool@1.0.0' }],
      }]);
    });

    it('bump / state は受け付けるが採番も保存もせず、版は 0.0.0 のまま報告する', async () => {
      const res = await diagnoseDraft(body({ bump: 'major', state: 'published' }));
      expect(res.statusCode).toBe(200);
      expect(res.json().diagnostics.agent).toEqual({ internalId: 'assistant', version: '0.0.0' });
      expect((await server.inject({ method: 'GET', url: '/agents/assistant', query: scope })).statusCode).toBe(404);
    });

    it('createAgent の不変条件違反（自己参照・重複 Tool 参照・重複 MCP 参照）は 400 AGENT_VALIDATION', async () => {
      const selfReference = await diagnoseDraft(body({ agents: [{ internalId: 'assistant', version: '1.0.0', usage: 'delegate' }] }));
      expect(selfReference.statusCode).toBe(400);
      expect(selfReference.json().error).toMatchObject({ code: 'AGENT_VALIDATION' });
      expect(selfReference.json().error.message).toContain('cannot reference itself');
      const duplicateTool = await diagnoseDraft(body({ tools: [{ internalId: 'scores', version: '1.0.0' }, { internalId: 'scores', version: '1.0.0' }] }));
      expect(duplicateTool.statusCode).toBe(400);
      expect(duplicateTool.json().error.code).toBe('AGENT_VALIDATION');
      const duplicateMcp = await diagnoseDraft(body({ mcpServers: ['files', 'files'] }));
      expect(duplicateMcp.statusCode).toBe(400);
      expect(duplicateMcp.json().error.code).toBe('AGENT_VALIDATION');
    });

    it('認証なしは 401、agent:execute を持たない viewer は 403、editor は 200', async () => {
      const viewer = buildServer(app, { authentication: rolesAuth(['viewer']), authorization: new RoleMatrixAuthorization() });
      const editor = buildServer(app, { authentication: rolesAuth(['editor']), authorization: new RoleMatrixAuthorization() });
      try {
        const unauthenticated = await viewer.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: body() });
        expect(unauthenticated.statusCode).toBe(401);
        expect(unauthenticated.json().error.code).toBe('UNAUTHENTICATED');
        const forbidden = await viewer.inject({ method: 'POST', url: '/agent-drafts/diagnose', headers: { authorization: `Bearer ${TOKEN}` }, payload: body() });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'agent:execute' permission" });
        const allowed = await editor.inject({ method: 'POST', url: '/agent-drafts/diagnose', headers: { authorization: `Bearer ${TOKEN}` }, payload: body() });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().diagnostics.status).toBe('ok');
      } finally {
        await viewer.close();
        await editor.close();
      }
    });

    it('認可表は POST /agent-drafts/diagnose に execute / agent を割り当てている', () => {
      expect(explicitRouteAuthorization('POST', '/agent-drafts/diagnose')).toMatchObject({ action: 'execute', kind: 'agent' });
    });
  });
});
