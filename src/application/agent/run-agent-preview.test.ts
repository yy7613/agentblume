import { describe, expect, it } from 'vitest';
import { createAgent, type Agent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import type { Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { RunRecord } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import { EtlEngine } from '../etl/engine';
import type { JsonObject, ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { AgentRunError, RunFailedError, UnsafeToolError } from './errors';
import { RunAgentPreviewUseCase } from './run-agent-preview';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const inputSchema: Schema = { columns: [
  { name: 'name', type: 'string', nullable: false },
  { name: 'score', type: 'number', nullable: false },
] };

function makeTool(sideEffect: 'read-only' | 'write' = 'read-only', withInputNode = true): Tool {
  return createTool({
    metadata: { internalId: 'score-tool', workingName: 'score-draft', displayName: 'Score lookup', publishName: 'score_lookup', version: SemVer.parse('1.2.0'), owner: 'owner', state: 'draft', tenant: scope },
    sideEffect,
    graph: withInputNode
      ? { nodes: [{ id: 'input', type: 'agent-input', config: { schema: inputSchema, sample: { name: 'sample', score: 0 } } }], edges: [] }
      : { nodes: [{ id: 'source', type: 'json-source', config: { rows: [{ name: 'sample', score: 0 }] } }], edges: [] },
    inputSchema,
    outputSchema: inputSchema,
  });
}

class StaticRepository implements ToolRepository {
  constructor(private readonly tool: Tool | null) {}
  async save(): Promise<void> {}
  async findVersion(_scope: TenantScope, _id: ToolId, _version: SemVer): Promise<Tool | null> { return this.tool; }
  async findLatest(): Promise<Tool | null> { return this.tool; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<ToolSummary[]> { return []; }
}

class QueueModel implements ModelProviderPort {
  readonly requests: ModelCompletionRequest[] = [];
  constructor(private readonly queue: ModelCompletion[], private readonly caps: readonly ModelCapability[] = ['chat', 'tool-calling']) {}
  capabilities(): readonly ModelCapability[] { return this.caps; }
  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    const item = this.queue.shift();
    if (item === undefined) throw new Error('missing completion');
    return item;
  }
}

class MemoryRuns implements RunRepository {
  readonly records = new Map<string, RunRecord>();
  async save(record: RunRecord): Promise<void> { this.records.set(record.runId, structuredClone(record)); }
  async find(_scope: TenantScope, runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }
  async list(): Promise<RunRecord[]> { return [...this.records.values()]; }
}

class StaticAgents implements AgentRepository {
  constructor(private readonly agent: Agent | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Agent | null> { return this.agent; }
  async findLatest(): Promise<Agent | null> { return this.agent; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<AgentSummary[]> { return []; }
}

function useCase(tool: Tool | null, model: ModelProviderPort): RunAgentPreviewUseCase {
  return new RunAgentPreviewUseCase(new StaticRepository(tool), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-1');
}

const input = { scope, toolId: 'score-tool', systemPrompt: 'Use tools.', message: 'Alice score?', mode: 'preview' as const };

describe('RunAgentPreviewUseCase', () => {
  it('tool call引数をagent-inputへ渡し、結果で2段目推論する', async () => {
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls', usage: { totalTokens: 10 } },
      { message: { role: 'assistant', content: 'Alice scored 42.' }, finishReason: 'stop', usage: { totalTokens: 5 } },
    ]);
    const run = await useCase(makeTool(), model).execute(input);
    expect(run).toMatchObject({ runId: 'run-1', response: 'Alice scored 42.', tool: { version: '1.2.0' }, usage: { totalTokens: 15 } });
    const toolResult = run.trace.find((event) => event.kind === 'tool-result');
    expect(toolResult).toMatchObject({ outputPreview: [{ name: 'Alice', score: 42 }], nodes: [{ nodeId: 'input', rowCount: 1 }] });
    expect(model.requests[0]?.tools?.[0]?.name).toBe('score_lookup');
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call-1' });
    expect(model.requests[1]?.tools?.[0]?.name).toBe('score_lookup');
  });

  it('複数roundのTool callを上限内で反復しusageと実行Tool列を返す', async () => {
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls', usage: { totalTokens: 2 } },
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-2', name: 'score_lookup', arguments: { name: 'Bob', score: 7 } }] }, finishReason: 'tool_calls', usage: { totalTokens: 3 } },
      { message: { role: 'assistant', content: 'Alice 42, Bob 7.' }, finishReason: 'stop', usage: { totalTokens: 5 } },
    ]);
    const run = await useCase(makeTool(), model).execute(input);
    expect(run.response).toBe('Alice 42, Bob 7.');
    expect(run.tools?.map((tool) => tool.publishName)).toEqual(['score_lookup', 'score_lookup']);
    expect(run.usage.totalTokens).toBe(10);
    expect(run.trace.map((event) => event.kind)).toEqual([
      'model-request', 'tool-call', 'tool-result',
      'model-request', 'tool-call', 'tool-result',
      'model-request', 'model-response',
    ]);
  });

  it('同一completionの複数Tool callを順番に実行する', async () => {
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [
        { id: 'call-1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } },
        { id: 'call-2', name: 'score_lookup', arguments: { name: 'Bob', score: 7 } },
      ] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);
    const run = await useCase(makeTool(), model).execute(input);
    expect(run.tools).toHaveLength(2);
    expect(model.requests[1]?.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['call-1', 'call-2']);
  });

  it('tool callなしの直接応答も返す', async () => {
    const model = new QueueModel([{ message: { role: 'assistant', content: 'No tool needed.' }, finishReason: 'stop' }]);
    const run = await useCase(makeTool(), model).execute(input);
    expect(run.response).toBe('No tool needed.');
    expect(run.trace.map((event) => event.kind)).toEqual(['model-request', 'model-response']);
  });

  it('write toolをfail closedで拒否する', async () => {
    const model = new QueueModel([]);
    await expect(useCase(makeTool('write'), model).execute(input)).rejects.toMatchObject({ cause: expect.any(UnsafeToolError), runId: 'run-1' });
    expect(model.requests).toHaveLength(0);
  });

  it('inputSchemaにagent-inputがなければ実行を拒否する', async () => {
    const model = new QueueModel([{ message: { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'score_lookup', arguments: { name: 'A', score: 1 } }] }, finishReason: 'tool_calls' }]);
    await expect(useCase(makeTool('read-only', false), model).execute(input)).rejects.toThrow(/no agent-input/);
  });

  it('unknown tool、call上限超過、capability不足を拒否する', async () => {
    const unknown = new QueueModel([{ message: { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'other', arguments: {} }] }, finishReason: 'tool_calls' }]);
    await expect(useCase(makeTool(), unknown).execute(input)).rejects.toMatchObject({ cause: expect.any(AgentRunError) });
    const overLimit = new QueueModel([{ message: { role: 'assistant', content: null, toolCalls: [
      { id: '1', name: 'score_lookup', arguments: { name: 'A', score: 1 } },
      { id: '2', name: 'score_lookup', arguments: { name: 'B', score: 2 } },
      { id: '3', name: 'score_lookup', arguments: { name: 'C', score: 3 } },
      { id: '4', name: 'score_lookup', arguments: { name: 'D', score: 4 } },
      { id: '5', name: 'score_lookup', arguments: { name: 'E', score: 5 } },
    ] }, finishReason: 'tool_calls' }]);
    await expect(useCase(makeTool(), overLimit).execute(input)).rejects.toThrow(/limit exceeded/);
    const noCapability = new QueueModel([], ['chat']);
    await expect(useCase(makeTool(), noCapability).execute(input)).rejects.toThrow(/does not support/);
  });

  it('structured-output capabilityがないProviderをfail closedで拒否する', async () => {
    const agent = createAgent({
      metadata: { internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      kind: 'normal', systemPrompt: 'Return JSON.', tools: [],
      output: { name: 'agent_response', fields: [{ name: 'answer', type: 'string', required: true }] },
    });
    const model = new QueueModel([], ['chat']);
    const usecase = new RunAgentPreviewUseCase(new StaticRepository(null), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-structured', undefined, new StaticAgents(agent));
    await expect(usecase.executeSaved({ scope, agentId: 'agent', message: 'go', mode: 'preview' })).rejects.toThrow(/does not support structured output/);
    expect(model.requests).toHaveLength(0);
  });
});

function agentMeta(id: string) {
  return { internalId: id, workingName: id, displayName: id, publishName: id, version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft' as const, tenant: scope };
}
class MapAgents implements AgentRepository {
  constructor(private readonly byId: Map<string, Agent>) {}
  async save(): Promise<void> {}
  async findVersion(_s: TenantScope, id: string): Promise<Agent | null> { return this.byId.get(id) ?? null; }
  async findLatest(_s: TenantScope, id: string): Promise<Agent | null> { return this.byId.get(id) ?? null; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<AgentSummary[]> { return []; }
}
const agentVersion = SemVer.of(1, 0, 0);
function subRef(id: string, usage = `delegate ${id}`) { return { internalId: id, version: agentVersion, usage }; }
function toolCall(id: string, name: string, args: JsonObject): ModelCompletion {
  return { message: { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: args }] }, finishReason: 'tool_calls', usage: { totalTokens: 1 } };
}
function stop(content: string): ModelCompletion {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: { totalTokens: 1 } };
}
function multiUseCase(tool: Tool, model: ModelProviderPort, agents: AgentRepository, runs: RunRepository): RunAgentPreviewUseCase {
  let n = 0;
  return new RunAgentPreviewUseCase(new StaticRepository(tool), new EtlEngine(createDefaultRegistry()), model, runs, () => `run-${(n += 1)}`, undefined, agents);
}

describe('RunAgentPreviewUseCase sub-agent delegation', () => {
  it('ルート→サブ委譲→結果統合: 子Runを独立保存し親traceにagent_callを記録する', async () => {
    const sub = createAgent({ metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'Score users.', tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }] });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'Delegate scoring.', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([
      toolCall('c1', 'ask_sub', { message: 'score Alice' }),
      toolCall('c2', 'score_lookup', { name: 'Alice', score: 42 }),
      stop('Alice scored 42.'),
      stop('Delegated: Alice 42.'),
    ]);
    const run = await multiUseCase(makeTool(), model, new MapAgents(new Map([['sub', sub], ['root', root]])), runs).executeSaved({ scope, agentId: 'root', message: 'Score Alice', mode: 'preview' });

    expect(run.runId).toBe('run-1');
    expect(run.response).toBe('Delegated: Alice 42.');
    const agentCall = run.trace.find((event) => event.kind === 'agent_call');
    expect(agentCall).toMatchObject({ kind: 'agent_call', toolName: 'ask_sub', ok: true, childRunId: 'run-2', agentRef: { internalId: 'sub', version: '1.0.0' } });
    // ルートのモデルには ask_sub が委譲ツールとして提示される。
    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain('ask_sub');
    // 子Runが独立保存され、子自身のTool(score_lookup)を使っている。
    const child = runs.records.get('run-2');
    expect(child?.agent?.internalId).toBe('sub');
    expect(child?.trace.some((event) => event.kind === 'tool-result')).toBe(true);
  });

  it('サブの構造化出力をJSON文字列としてツール結果に渡す', async () => {
    const sub = createAgent({ metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'Return JSON.', tools: [], output: { name: 'result', fields: [{ name: 'score', type: 'number', required: true }] } });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'Delegate.', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([
      toolCall('c1', 'ask_sub', { message: 'score Alice' }),
      stop('{"score":42}'),
      stop('done'),
    ], ['chat', 'tool-calling', 'structured-output']);
    const run = await multiUseCase(makeTool(), model, new MapAgents(new Map([['sub', sub], ['root', root]])), runs).executeSaved({ scope, agentId: 'root', message: 'go', mode: 'preview' });

    const agentCall = run.trace.find((event) => event.kind === 'agent_call');
    expect(agentCall).toMatchObject({ ok: true, summary: '{"score":42}' });
    expect(runs.records.get('run-2')?.structuredResponse).toEqual({ score: 42 });
  });

  it('message引数が空なら委譲せずエラー結果を返し親は継続する', async () => {
    const sub = createAgent({ metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'x', tools: [] });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'x', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'ask_sub', {}), stop('handled without delegation')]);
    const run = await multiUseCase(makeTool(), model, new MapAgents(new Map([['sub', sub], ['root', root]])), runs).executeSaved({ scope, agentId: 'root', message: 'go', mode: 'preview' });

    expect(run.response).toBe('handled without delegation');
    expect(run.trace.find((event) => event.kind === 'agent_call')).toMatchObject({ ok: false, childRunId: '' });
    // 子Runは作られない（ルートのrun-1のみ）。
    expect(runs.records.size).toBe(1);
  });

  it('委譲深さ上限を超える要求はエラー結果になり実行されない', async () => {
    const subsub = createAgent({ metadata: agentMeta('subsub'), kind: 'normal', systemPrompt: 'x', tools: [] });
    const sub = createAgent({ metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'x', tools: [], agents: [subRef('subsub')] });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'x', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([
      toolCall('c1', 'ask_sub', { message: 'go deeper' }),   // root -> sub (depth1)
      toolCall('c2', 'ask_subsub', { message: 'even deeper' }), // sub -> subsub: depth1>=max(1) 拒否
      stop('sub handled'),
      stop('root done'),
    ]);
    const run = await multiUseCase(makeTool(), model, new MapAgents(new Map([['sub', sub], ['subsub', subsub], ['root', root]])), runs).executeSaved({ scope, agentId: 'root', message: 'go', mode: 'preview', budget: { maxDelegationDepth: 1 } });

    expect(run.response).toBe('root done');
    expect(runs.records.size).toBe(2); // root と sub のみ（subsub は実行されない）
    const refused = runs.records.get('run-2')?.trace.find((event) => event.kind === 'agent_call');
    expect(refused).toMatchObject({ ok: false });
    expect(refused).toMatchObject({ summary: expect.stringContaining('max delegation depth') });
  });

  it('共有バジェット枯渇でサブが失敗しても親は継続し子errorを保存する', async () => {
    const sub = createAgent({ metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'x', tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }] });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'x', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([
      toolCall('c1', 'ask_sub', { message: 'score' }),          // root 委譲（tool-call 1消費）
      toolCall('c2', 'score_lookup', { name: 'A', score: 1 }),  // sub のtool-callでバジェット枯渇→失敗
      stop('root recovered'),
    ]);
    const run = await multiUseCase(makeTool(), model, new MapAgents(new Map([['sub', sub], ['root', root]])), runs).executeSaved({ scope, agentId: 'root', message: 'go', mode: 'preview', budget: { remainingToolCalls: 1 } });

    expect(run.response).toBe('root recovered');
    expect(runs.records.get('run-2')?.status).toBe('failed');
    expect(run.trace.find((event) => event.kind === 'agent_call')).toMatchObject({ ok: false, childRunId: 'run-2', summary: expect.stringContaining('budget exhausted') });
  });

  it('サブが実効的にwrite副作用を持つ場合はpreview実行前に拒否する', async () => {
    const sub = createAgent({ metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'x', tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }] });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'x', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([]);
    // ツールリポジトリが write を返すため sub の実効副作用は write。
    await expect(multiUseCase(makeTool('write'), model, new MapAgents(new Map([['sub', sub], ['root', root]])), runs).executeSaved({ scope, agentId: 'root', message: 'go', mode: 'preview' }))
      .rejects.toMatchObject({ cause: expect.any(UnsafeToolError) });
    expect(model.requests).toHaveLength(0);
  });
});
