import type { AddressInfo } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { ModelProviderError, type ModelCapability, type ModelCompletion, type ModelCompletionRequest, type ModelProviderPort } from '../application/model/model-provider';
import { SemVer } from '../domain/tool/semver';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { clientAbortSignal } from './client-abort';
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
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
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

  it('画像添付をマルチモーダルのユーザー入力としてモデルへ渡す', async () => {
    model.enqueue({ message: { role: 'assistant', content: 'A tiny image.' }, finishReason: 'stop' });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, tool: { internalId: 'score-tool' }, systemPrompt: 'Describe images.', message: 'What is shown?', mode: 'preview',
      images: [{ name: 'tiny.png', dataUrl: 'data:image/png;base64,AA==' }],
    } });
    expect(response.statusCode).toBe(200);
    expect(model.requests[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: [
      { type: 'text', text: 'What is shown?' },
      { type: 'image_url', imageUrl: 'data:image/png;base64,AA==' },
    ] });
  });

  it('保存済みAgentの複数Tool候補からモデルが選んだToolを実行する', async () => {
    await app.saveTool.execute({
      scope, internalId: 'other-tool', workingName: 'other', displayName: 'Other score', publishName: 'other_lookup', owner: 'owner', sideEffect: 'read-only',
      graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema, sample: { name: 'sample', score: 0 } } }], edges: [] },
      inputSchema: schema, outputSchema: schema,
    });
    await app.saveAgent.execute({
      scope, internalId: 'score-agent', workingName: 'agent', displayName: 'Score Agent', publishName: 'score_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Choose the correct score tool.',
      tools: [
        { internalId: 'score-tool', version: SemVer.parse('1.0.0') },
        { internalId: 'other-tool', version: SemVer.parse('1.0.0') },
      ],
    });
    model.enqueue(
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-2', name: 'other_lookup', arguments: { name: 'Bob', score: 7 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-3', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'Bob: 7, Alice: 42' }, finishReason: 'stop' },
    );

    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'score-agent', version: '1.0.0' }, message: 'Bob score?', mode: 'preview',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({
      response: 'Bob: 7, Alice: 42',
      agent: { internalId: 'score-agent', version: '1.0.0', publishName: 'score_agent' },
      tool: { internalId: 'score-tool', version: '1.0.0', publishName: 'score_lookup' },
      tools: [
        { internalId: 'other-tool', version: '1.0.0', publishName: 'other_lookup' },
        { internalId: 'score-tool', version: '1.0.0', publishName: 'score_lookup' },
      ],
    });
    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['score_lookup', 'other_lookup']);
    expect(model.requests[1]?.tools?.map((tool) => tool.name)).toEqual(['score_lookup', 'other_lookup']);
    const list = await server.inject({ method: 'GET', url: '/runs?tenantId=tenant&workspaceId=workspace' });
    expect(list.json().runs[0]).toMatchObject({ agent: { internalId: 'score-agent', version: '1.0.0' }, tools: [{ internalId: 'other-tool' }, { internalId: 'score-tool' }] });
  });

  it('サブエージェント委譲を入れ子実行し、親traceのagent_callから子Runを辿れる', async () => {
    await app.saveAgent.execute({
      scope, internalId: 'scorer', workingName: 'scorer', displayName: 'Scorer', publishName: 'scorer', owner: 'owner', kind: 'normal', systemPrompt: 'Score with the tool.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.0.0') }],
    });
    await app.saveAgent.execute({
      scope, internalId: 'coordinator', workingName: 'coord', displayName: 'Coordinator', publishName: 'coordinator', owner: 'owner', kind: 'normal', systemPrompt: 'Delegate scoring.',
      tools: [], agents: [{ internalId: 'scorer', version: SemVer.parse('1.0.0'), usage: 'delegate scoring requests' }],
    });
    model.enqueue(
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'd1', name: 'ask_scorer', arguments: { message: 'score Alice' } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 't1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'Alice scored 42.' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'Final: Alice 42.' }, finishReason: 'stop' },
    );

    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'coordinator', version: '1.0.0' }, message: 'Score Alice', mode: 'preview',
    } });
    expect(response.statusCode).toBe(200);
    const run = response.json().run;
    expect(run.response).toBe('Final: Alice 42.');
    // ルートには委譲ツール ask_scorer が提示される。
    expect(model.requests[0]?.tools?.map((tool: { name: string }) => tool.name)).toEqual(['ask_scorer']);
    // 親traceの agent_call から子Runへ辿れる。
    const agentCall = run.trace.find((event: { kind: string }) => event.kind === 'agent_call');
    expect(agentCall).toMatchObject({ toolName: 'ask_scorer', ok: true, agentRef: { internalId: 'scorer', version: '1.0.0' } });
    const childTrace = await server.inject({ method: 'GET', url: `/runs/${agentCall.childRunId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(childTrace.statusCode).toBe(200);
    expect(childTrace.json().run).toMatchObject({ status: 'succeeded', agent: { internalId: 'scorer', version: '1.0.0' } });
    expect(childTrace.json().run.trace.some((event: { kind: string }) => event.kind === 'tool-result')).toBe(true);
  });

  it('Toolを持たない保存済みAgentの直接応答を記録する', async () => {
    await app.saveAgent.execute({
      scope, internalId: 'chat-agent', workingName: 'chat', displayName: 'Chat Agent', publishName: 'chat_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer directly.', tools: [],
    });
    model.enqueue({ message: { role: 'assistant', content: 'Direct answer.' }, finishReason: 'stop' });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'chat-agent' }, message: 'Hello', mode: 'preview',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ response: 'Direct answer.', agent: { internalId: 'chat-agent', version: '1.0.0' } });
    expect(response.json().run.tool).toBeUndefined();
    expect(model.requests[0]?.tools).toBeUndefined();
  });

  it('historyをsystem直後の会話履歴としてモデルへ渡す（マルチターン会話）', async () => {
    await app.saveAgent.execute({
      scope, internalId: 'chat-agent', workingName: 'chat', displayName: 'Chat Agent', publishName: 'chat_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer directly.', tools: [],
    });
    model.enqueue({ message: { role: 'assistant', content: 'Your first question was about stock.' }, finishReason: 'stop' });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'chat-agent' }, message: 'What was my first question?', mode: 'preview',
      history: [
        { role: 'user', content: 'Which items are in stock?' },
        { role: 'assistant', content: 'Headphones and keyboard.' },
      ],
    } });
    expect(response.statusCode).toBe(200);
    expect(model.requests[0]?.messages.map((entry) => entry.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(model.requests[0]?.messages[1]).toMatchObject({ role: 'user', content: 'Which items are in stock?' });
    expect(model.requests[0]?.messages[2]).toMatchObject({ role: 'assistant', content: 'Headphones and keyboard.' });
    expect(model.requests[0]?.messages.at(-1)).toMatchObject({ role: 'user', content: 'What was my first question?' });
  });

  it('不正なhistory(空content・未知role・41件超)を400へ変換する', async () => {
    await app.saveAgent.execute({
      scope, internalId: 'chat-agent', workingName: 'chat', displayName: 'Chat Agent', publishName: 'chat_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer directly.', tools: [],
    });
    const emptyContent = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'chat-agent' }, message: 'Hi', mode: 'preview', history: [{ role: 'user', content: '' }],
    } });
    expect(emptyContent.statusCode).toBe(400);
    const badRole = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'chat-agent' }, message: 'Hi', mode: 'preview', history: [{ role: 'system', content: 'x' }],
    } });
    expect(badRole.statusCode).toBe(400);
    const tooMany = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'chat-agent' }, message: 'Hi', mode: 'preview',
      history: Array.from({ length: 41 }, (_, index) => ({ role: 'user', content: `m${index}` })),
    } });
    expect(tooMany.statusCode).toBe(400);
  });

  it('保存済みAgentのstructured outputをProviderへ渡して再検証・永続化する', async () => {
    await app.saveAgent.execute({
      scope, internalId: 'structured-agent', workingName: 'structured', displayName: 'Structured Agent', publishName: 'structured_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Return JSON.', tools: [],
      output: { name: 'structured_response', fields: [
        { name: 'answer', type: 'string', required: true },
        { name: 'score', type: 'integer', required: true },
      ] },
    });
    model.enqueue({ message: { role: 'assistant', content: '{"answer":"done","score":9}' }, finishReason: 'stop' });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'structured-agent', version: '1.0.0' }, message: 'Answer', mode: 'preview',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json().run.structuredResponse).toEqual({ answer: 'done', score: 9 });
    expect(model.requests[0]?.responseFormat).toMatchObject({ name: 'structured_response', strict: true, schema: { required: ['answer', 'score'] } });
    const trace = await server.inject({ method: 'GET', url: `/runs/${response.json().run.runId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(trace.json().run.structuredResponse).toEqual({ answer: 'done', score: 9 });

    // 1回目が不正でも修復往復で作り直させ、2回目が通れば完走する（Runは失敗しない）。
    model.enqueue(
      { message: { role: 'assistant', content: '{"answer":"missing score"}' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '{"answer":"repaired","score":3}' }, finishReason: 'stop' },
    );
    const repaired = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'structured-agent' }, message: 'Invalid once', mode: 'preview',
    } });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().run.structuredResponse).toEqual({ answer: 'repaired', score: 3 });

    // 修復上限（既定1回）まで失敗したら従来どおり AGENT_RUN で失敗させる。
    model.enqueue(
      { message: { role: 'assistant', content: '{"answer":"missing score"}' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '{"answer":"still missing"}' }, finishReason: 'stop' },
    );
    const invalid = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'structured-agent' }, message: 'Invalid', mode: 'preview',
    } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error).toMatchObject({ code: 'AGENT_RUN', runId: expect.any(String) });
  });

  it('保存済みAgentの候補にwrite Toolがあれば403でfail closedする', async () => {
    const write = await app.saveTool.execute({
      scope, internalId: 'write-agent-tool', workingName: 'write', displayName: 'Write', publishName: 'write_agent_tool', owner: 'owner', sideEffect: 'write',
      graph: { nodes: [{ id: 'source', type: 'json-source', config: { rows: [] } }], edges: [] },
    });
    await app.saveAgent.execute({
      scope, internalId: 'unsafe-agent', workingName: 'unsafe', displayName: 'Unsafe', publishName: 'unsafe_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Use tools.',
      tools: [{ internalId: write.metadata.internalId, version: write.metadata.version }],
    });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'unsafe-agent', version: '1.0.0' }, message: 'Go', mode: 'preview',
    } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: 'UNSAFE_TOOL', runId: expect.any(String) });
    expect(model.requests).toHaveLength(0);
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
    // scope分離の主体はPrincipal。別テナントのPrincipalからは同じリポジトリでも空に見える。
    const otherServer = buildServer(app, { authentication: new SingleUserAuthentication({ tenantId: 'other', workspaceId: 'workspace' }) });
    const other = await otherServer.inject({ method: 'GET', url: '/runs' });
    expect(other.json().runs).toEqual([]);
    // 逆に、自分のPrincipalで別テナントを名乗っても自分のRunしか見えない（申告は無視される）。
    const impersonated = await server.inject({ method: 'GET', url: '/runs?tenantId=other&workspaceId=workspace' });
    expect(impersonated.json().runs).toHaveLength(1);
    await otherServer.close();
    const missing = await server.inject({ method: 'GET', url: '/runs/nope/trace?tenantId=tenant&workspaceId=workspace' });
    expect(missing.statusCode).toBe(404);
  });

  it('memoryPageIds で Wiki を注入し system prompt 先頭に # Memory を前置する（v21 M1）', async () => {
    await app.saveAgent.execute({
      scope, internalId: 'memo-agent', workingName: 'agent', displayName: 'Memo Agent', publishName: 'memo_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer succinctly.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.0.0') }],
    });
    const wiki = await app.saveWikiPage.execute({ scope, title: 'Cohort rule', tags: ['sql'], body: 'Adults are age>=18.' });
    model.enqueue({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'memo-agent' }, message: 'hi', mode: 'preview', memoryPageIds: [wiki.id],
    } });
    expect(response.statusCode).toBe(200);
    const systemPrompt = model.requests[0]?.messages[0]?.content ?? '';
    expect(systemPrompt).toContain('# Memory');
    expect(systemPrompt).toContain('Adults are age>=18.');
    // 未存在 id は黙って除外し、注入なしでも実行できる。
    model.enqueue({ message: { role: 'assistant', content: 'ok2' }, finishReason: 'stop' });
    const none = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'memo-agent' }, message: 'hi', mode: 'preview', memoryPageIds: ['ghost'],
    } });
    expect(none.statusCode).toBe(200);
    expect(model.requests[1]?.messages[0]?.content ?? '').not.toContain('# Memory');
  });

  it('toolApproval Agentは承認待ちで停止し、POST /runs/:runId/resume で承認/拒否して再開できる', async () => {
    await app.saveTool.execute({
      scope, internalId: 'store-tool', workingName: 'store', displayName: 'Store', publishName: 'store_score', owner: 'owner', sideEffect: 'session-write',
      graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema, sample: { name: 'sample', score: 0 } } }], edges: [] },
      inputSchema: schema, outputSchema: schema,
    });
    await app.saveAgent.execute({
      scope, internalId: 'approver', workingName: 'approver', displayName: 'Approver', publishName: 'approver_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Store scores.',
      tools: [{ internalId: 'store-tool', version: SemVer.parse('1.0.0') }],
      harness: { fileMemory: false, todoProvider: false, compaction: false, webSearch: false, toolApproval: true, functionInvocation: true },
    });

    model.enqueue({ message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'store_score', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' });
    const paused = await server.inject({ method: 'POST', url: '/runs', payload: {
      scope, agent: { internalId: 'approver', version: '1.0.0' }, message: 'Store Alice 42', mode: 'preview',
    } });
    expect(paused.statusCode).toBe(200);
    const pausedRun = paused.json().run;
    expect(pausedRun).toMatchObject({ status: 'waiting-approval', checkpoint: { tool: 'store_score', sideEffect: 'session-write' } });
    expect(pausedRun.checkpoint.expiresAt).toEqual(expect.any(String));
    expect(pausedRun.trace.map((event: { kind: string }) => event.kind)).toEqual(['model-request', 'approval-requested']);

    // 参照系APIはcheckpointの公開部分だけを返す（会話履歴は出さない）。
    const listed = await server.inject({ method: 'GET', url: '/runs?tenantId=tenant&workspaceId=workspace&status=waiting-approval' });
    expect(listed.json().runs[0]).toMatchObject({ runId: pausedRun.runId, status: 'waiting-approval', checkpoint: { kind: 'tool-approval', pendingCalls: [{ name: 'store_score' }] } });
    const traced = await server.inject({ method: 'GET', url: `/runs/${pausedRun.runId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(traced.json().run.checkpoint.messages).toBeUndefined();

    model.enqueue({ message: { role: 'assistant', content: 'Stored Alice: 42' }, finishReason: 'stop' });
    const resumed = await server.inject({ method: 'POST', url: `/runs/${pausedRun.runId}/resume`, payload: { scope, decision: 'approve' } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().run).toMatchObject({ runId: pausedRun.runId, response: 'Stored Alice: 42' });
    expect(resumed.json().run.status).toBeUndefined();
    expect(resumed.json().run.trace.map((event: { kind: string }) => event.kind)).toEqual([
      'model-request', 'approval-requested', 'approval-resolved', 'tool-call', 'tool-result', 'model-request', 'model-response',
    ]);
    /**
     * 承認者は Principal から入る。ボディでは受け取らないので、
     * 「runIdを知っていれば誰でも承認でき、しかも誰が承認したか残らない」状態にはならない。
     */
    expect(resumed.json().run.trace.find((event: { kind: string }) => event.kind === 'approval-resolved'))
      .toMatchObject({ decision: 'approve', decidedBy: 'single-user' });

    // 完了済みRunの再開は422、不正bodyは400。
    const again = await server.inject({ method: 'POST', url: `/runs/${pausedRun.runId}/resume`, payload: { scope, decision: 'approve' } });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.code).toBe('AGENT_RUN');
    const invalid = await server.inject({ method: 'POST', url: `/runs/${pausedRun.runId}/resume`, payload: { scope, decision: 'maybe' } });
    expect(invalid.statusCode).toBe(400);
    const missing = await server.inject({ method: 'POST', url: '/runs/ghost/resume', payload: { scope, decision: 'approve' } });
    expect(missing.statusCode).toBe(404);
  });

  it('rejectで再開すると拒否結果がモデルへ渡り代替応答で完走する', async () => {
    await app.saveTool.execute({
      scope, internalId: 'store-tool', workingName: 'store', displayName: 'Store', publishName: 'store_score', owner: 'owner', sideEffect: 'session-write',
      graph: { nodes: [{ id: 'input', type: 'agent-input', config: { schema, sample: { name: 'sample', score: 0 } } }], edges: [] },
      inputSchema: schema, outputSchema: schema,
    });
    await app.saveAgent.execute({
      scope, internalId: 'approver', workingName: 'approver', displayName: 'Approver', publishName: 'approver_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Store scores.',
      tools: [{ internalId: 'store-tool', version: SemVer.parse('1.0.0') }],
      harness: { fileMemory: false, todoProvider: false, compaction: false, webSearch: false, toolApproval: true, functionInvocation: true },
    });
    model.enqueue({ message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'store_score', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' });
    const paused = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'approver' }, message: 'Store Alice 42', mode: 'preview' } });
    const runId = paused.json().run.runId;

    model.enqueue({ message: { role: 'assistant', content: 'Understood, nothing was stored.' }, finishReason: 'stop' });
    const rejected = await server.inject({ method: 'POST', url: `/runs/${runId}/resume`, payload: { scope, decision: 'reject', feedback: 'not allowed' } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().run.response).toBe('Understood, nothing was stored.');
    const toolMessages = (model.requests[1]?.messages ?? []).filter((message) => message.role === 'tool');
    expect(JSON.parse(String(toolMessages[0]?.content))).toEqual({ approved: false, reason: 'not allowed' });
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

/**
 * 実行の中断。UIの中断ボタンは「HTTPを切る → サーバーがモデル呼び出しをabortする」という
 * 1本の鎖でしか効かないので、その鎖の両端をここで押さえる。
 */
class HangingModel implements ModelProviderPort {
  private resolveStarted!: () => void;
  /** complete() に入ったことを待てるようにする（切断のタイミングを固定するため）。 */
  readonly started: Promise<void> = new Promise((resolve) => { this.resolveStarted = resolve; });
  capabilities(): readonly ModelCapability[] { return ['chat', 'tool-calling', 'structured-output', 'vision']; }
  async complete(_request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    return new Promise<ModelCompletion>((_resolve, reject) => {
      if (signal?.aborted === true) { reject(new ModelProviderError('aborted before start')); return; }
      signal?.addEventListener('abort', () => reject(new ModelProviderError('model request aborted')), { once: true });
      this.resolveStarted();
    });
  }
}

describe('clientAbortSignal', () => {
  function fakeReply(): { readonly reply: FastifyReply; close: (writableEnded: boolean) => void } {
    const listeners: (() => void)[] = [];
    const raw = {
      writableEnded: false,
      once(event: string, listener: () => void) { if (event === 'close') listeners.push(listener); return raw; },
    };
    return {
      reply: { raw } as unknown as FastifyReply,
      close: (writableEnded: boolean) => { raw.writableEnded = writableEnded; for (const listener of listeners) listener(); },
    };
  }

  it('request.raw.signal がある実行環境（Node 26+）ではそれをそのまま使う', () => {
    const native = new AbortController().signal;
    const request = { raw: { signal: native } } as unknown as FastifyRequest;
    expect(clientAbortSignal(request, fakeReply().reply)).toBe(native);
  });

  it('request.raw.signal が無い実行環境（Node 22）でも、応答を書き終える前の切断でabortする', () => {
    const { reply, close } = fakeReply();
    const signal = clientAbortSignal({ raw: {} } as unknown as FastifyRequest, reply);
    expect(signal.aborted).toBe(false);
    close(false);
    expect(signal.aborted).toBe(true);
  });

  it('応答を書き終えた後のcloseではabortしない（正常終了を中断と誤認しない）', () => {
    const { reply, close } = fakeReply();
    const signal = clientAbortSignal({ raw: {} } as unknown as FastifyRequest, reply);
    close(true);
    expect(signal.aborted).toBe(false);
  });
});

describe('POST /runs の中断', () => {
  it('クライアントが切断するとモデル呼び出しをabortし、Runを RUN_CANCELLED で確定する', async () => {
    const hanging = new HangingModel();
    const cancelApp = createApp({ profile: 'test', modelProvider: hanging });
    const cancelServer = buildServer(cancelApp, { authentication: new SingleUserAuthentication(scope) });
    try {
      await cancelApp.saveAgent.execute({
        scope, internalId: 'cancel-agent', workingName: 'cancel', displayName: 'Cancel Agent', publishName: 'cancel_agent',
        owner: 'owner', kind: 'normal', systemPrompt: 'Think slowly.', tools: [],
      });
      await cancelServer.listen({ port: 0, host: '127.0.0.1' });
      const port = (cancelServer.server.address() as AddressInfo).port;
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, agent: { internalId: 'cancel-agent' }, message: 'go', mode: 'preview' }),
        signal: controller.signal,
      });

      await hanging.started;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      await vi.waitFor(async () => {
        const runs = await cancelApp.queryRuns.list(scope, { limit: 5 });
        expect(runs[0]).toMatchObject({ status: 'failed', failure: { code: 'RUN_CANCELLED', message: 'run cancelled by the user' } });
      });
    } finally {
      await cancelServer.close();
      cancelApp.close();
    }
  });
});
