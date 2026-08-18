import { describe, expect, it } from 'vitest';
import { createAgent, DEFAULT_AGENT_RUNTIME_HARNESS, type Agent, type AgentRuntimeHarness } from '../../domain/agent/agent';
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
import { queryWorkspaceTable, RunAgentPreviewUseCase, type RunObservabilityOptions } from './run-agent-preview';
import { toolToModelDefinition } from './tool-schema';
import { FakeWikiRepository } from '../memory/memory-repositories.fixtures';
import { createWikiSpace } from '../../domain/memory/wiki-space';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { InMemoryAgentSessionRepository } from '../../adapters/storage/in-memory-agent-session-repository';
import { InMemorySessionArtifactRepository } from '../../adapters/storage/in-memory-session-artifact-repository';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import type { AgentSessionRepository, SessionArtifactRepository } from '../../domain/session/session-repository';
import { WebSearchUseCase } from '../search/web-search';
import type { NormalizedSearchRow, SearchProviderCatalog, SearchProviderSummary, SearchRequest } from '../search/search-provider';
import { InMemoryMcpServerRepository } from '../../adapters/storage/in-memory-mcp-server-repository';
import { createMcpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { McpClientError, type McpClientPort } from '../mcp/mcp-client';
import { FakeMcpClient } from '../mcp/mcp-client.fixtures';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const inputSchema: Schema = { columns: [
  { name: 'name', type: 'string', nullable: false },
  { name: 'score', type: 'number', nullable: false },
] };

function makeTool(sideEffect: 'read-only' | 'session-write' | 'write' = 'read-only', withInputNode = true): Tool {
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
  async delete(): Promise<boolean> { return false; }
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
  async listAllByStatus(status: RunRecord['status']): Promise<RunRecord[]> { return [...this.records.values()].filter((record) => record.status === status); }
  async listScopes(): Promise<TenantScope[]> { return [...new Map([...this.records.values()].map((record) => [`${record.scope.tenantId} ${record.scope.workspaceId}`, record.scope])).values()]; }
}

class StaticAgents implements AgentRepository {
  constructor(private readonly agent: Agent | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Agent | null> { return this.agent; }
  async findLatest(): Promise<Agent | null> { return this.agent; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<AgentSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

function useCase(tool: Tool | null, model: ModelProviderPort): RunAgentPreviewUseCase {
  return new RunAgentPreviewUseCase(new StaticRepository(tool), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-1');
}

const input = { scope, toolId: 'score-tool', systemPrompt: 'Use tools.', message: 'Alice score?', mode: 'preview' as const };

describe('RunAgentPreviewUseCase', () => {
  it('Agent Inputを未接続の引数宣言としてFilter条件へ束縛できる', async () => {
    const minimumSchema: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };
    const tool = createTool({
      metadata: { internalId: 'score-search', workingName: 'score-search', displayName: 'Score search', publishName: 'score_search', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: minimumSchema, outputSchema: inputSchema,
      agentTool: { name: 'find_scores', description: 'Find scores at or above minimumScore.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }, { name: 'Bob', score: 7 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } } },
        { id: 'arguments', type: 'agent-input', config: { schema: minimumSchema, sample: { minimumScore: 20 } } },
      ], edges: [{ from: 'data', to: 'filter' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'find', name: 'find_scores', arguments: { minimumScore: 40 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);
    const run = await useCase(tool, model).execute({ ...input, toolId: 'score-search' });
    expect(model.requests[0]?.tools?.[0]).toMatchObject({ name: 'find_scores', description: 'Find scores at or above minimumScore.' });
    expect(model.requests[1]?.messages.at(-1)?.content).toContain('"name":"Alice"');
    expect(model.requests[1]?.messages.at(-1)?.content).not.toContain('"name":"Bob"');
    expect(run.response).toBe('done');
  });

  it('複数条件filterのconditions内valueBindingも実引数へ差し替える（AND）', async () => {
    const searchSchema: Schema = { columns: [
      { name: 'region', type: 'string', nullable: false },
      { name: 'minimumScore', type: 'number', nullable: false },
    ] };
    const tool = createTool({
      metadata: { internalId: 'score-search', workingName: 'score-search', displayName: 'Score search', publishName: 'score_search', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: searchSchema, outputSchema: inputSchema,
      agentTool: { name: 'search_scores', description: 'Search scores by region and minimum score.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [
          { name: 'Alice', score: 42, region: 'Tokyo' },
          { name: 'Bob', score: 7, region: 'Tokyo' },
          { name: 'Carol', score: 90, region: 'Osaka' },
        ] } },
        // バインディングを持たない filter（旧形式 / conditions形式）は実行時もそのまま使われる。
        { id: 'prefilter', type: 'filter', config: { column: 'score', op: 'gte', value: 0 } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'region' } },
          { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } },
        ], combine: 'and' } },
        { id: 'postfilter', type: 'filter', config: { conditions: [{ column: 'name', op: 'notNull' }], combine: 'and' } },
        { id: 'projection', type: 'select', config: { columns: ['name', 'score'] } },
        { id: 'arguments', type: 'agent-input', config: { schema: searchSchema, sample: { region: 'Osaka', minimumScore: 0 } } },
      ], edges: [{ from: 'data', to: 'prefilter' }, { from: 'prefilter', to: 'filter' }, { from: 'filter', to: 'postfilter' }, { from: 'postfilter', to: 'projection' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_scores', arguments: { region: 'Tokyo', minimumScore: 40 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);
    await useCase(tool, model).execute({ ...input, toolId: 'score-search' });
    const result = String(model.requests[1]?.messages.at(-1)?.content);
    expect(result).toContain('"name":"Alice"'); // Tokyo かつ 40点以上。
    expect(result).not.toContain('"name":"Bob"'); // Tokyo だが 40点未満。
    expect(result).not.toContain('"name":"Carol"'); // 40点以上だが Osaka。
    // 設計時サンプル（value）は保存済みグラフ側に残り、実行時だけ差し替わる。
    const savedFilter = tool.graph.nodes.find((node) => node.id === 'filter')?.config as { conditions: { value: unknown }[] };
    expect(savedFilter.conditions.map((condition) => condition.value)).toEqual(['Osaka', 0]);
  });

  it('複数条件filterのORでも各条件のvalueBindingを解決する', async () => {
    const regionSchema: Schema = { columns: [
      { name: 'first', type: 'string', nullable: false },
      { name: 'second', type: 'string', nullable: false },
    ] };
    const tool = createTool({
      metadata: { internalId: 'region-search', workingName: 'region-search', displayName: 'Region search', publishName: 'region_search', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: regionSchema,
      agentTool: { name: 'search_regions', description: 'Search rows in either region.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [
          { name: 'Alice', region: 'Tokyo' },
          { name: 'Bob', region: 'Osaka' },
          { name: 'Carol', region: 'Nagoya' },
        ] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'region', op: 'eq', value: 'Tokyo', valueBinding: { source: 'agent-input', field: 'first' } },
          { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'second' } },
        ], combine: 'or' } },
        { id: 'arguments', type: 'agent-input', config: { schema: regionSchema, sample: { first: 'Tokyo', second: 'Osaka' } } },
      ], edges: [{ from: 'data', to: 'filter' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_regions', arguments: { first: 'Osaka', second: 'Nagoya' } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);
    await useCase(tool, model).execute({ ...input, toolId: 'region-search' });
    const result = String(model.requests[1]?.messages.at(-1)?.content);
    expect(result).not.toContain('Alice');
    expect(result).toContain('Bob');
    expect(result).toContain('Carol');
  });

  it('conditions内のvalueBindingが未宣言のfieldを指す場合は実行を拒否する', async () => {
    const minimumSchema: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };
    const tool = createTool({
      metadata: { internalId: 'broken-binding', workingName: 'broken-binding', displayName: 'Broken binding', publishName: 'broken_binding', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: minimumSchema,
      agentTool: { name: 'broken_binding', description: 'Filter bound to an undeclared argument.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } },
          { column: 'name', op: 'eq', value: 'Alice', valueBinding: { source: 'agent-input', field: 'who' } },
        ], combine: 'and' } },
        { id: 'arguments', type: 'agent-input', config: { schema: minimumSchema, sample: { minimumScore: 0 } } },
      ], edges: [{ from: 'data', to: 'filter' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call', name: 'broken_binding', arguments: { minimumScore: 1 } }] }, finishReason: 'tool_calls' },
    ]);
    await expect(useCase(tool, model).execute({ ...input, toolId: 'broken-binding' })).rejects.toThrow(/filter node 'filter' references an unavailable Agent input/);
  });

  it('valueBindingのfieldが文字列でない壊れたconfigも実行を拒否する', async () => {
    const minimumSchema: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };
    const tool = createTool({
      metadata: { internalId: 'broken-field', workingName: 'broken-field', displayName: 'Broken field', publishName: 'broken_field', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: minimumSchema,
      agentTool: { name: 'broken_field', description: 'Filter bound to a malformed field name.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } },
        { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 42 } } },
        { id: 'arguments', type: 'agent-input', config: { schema: minimumSchema, sample: { minimumScore: 0 } } },
      ], edges: [{ from: 'data', to: 'filter' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call', name: 'broken_field', arguments: { minimumScore: 1 } }] }, finishReason: 'tool_calls' },
    ]);
    await expect(useCase(tool, model).execute({ ...input, toolId: 'broken-field' })).rejects.toThrow(/filter node 'filter' references an unavailable Agent input/);
  });

  describe('nullableなTool引数（省略でその条件をスキップする）', () => {
    // region は nullable（省略可）、minimumScore は必須。region 条件は conditions 形式、
    // month 条件は旧フラット形式の別ノードに置き、両形式のスキップを1本のグラフで確かめる。
    const optionalSchema: Schema = { columns: [
      { name: 'minimumScore', type: 'number', nullable: false },
      { name: 'region', type: 'string', nullable: true },
      { name: 'month', type: 'string', nullable: true },
    ] };
    const optionalTool = (): Tool => createTool({
      metadata: { internalId: 'optional-search', workingName: 'optional-search', displayName: 'Optional search', publishName: 'optional_search', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: optionalSchema,
      agentTool: { name: 'search_scores', description: 'Search scores; omit region or month to cover all of them.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [
          { name: 'Alice', score: 42, region: 'Tokyo', month: '2026-05' },
          { name: 'Bob', score: 7, region: 'Tokyo', month: '2026-06' },
          { name: 'Carol', score: 90, region: 'Osaka', month: '2026-06' },
        ] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'region' } },
          { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } },
        ], combine: 'and' } },
        { id: 'monthfilter', type: 'filter', config: { column: 'month', op: 'eq', value: '2026-05', valueBinding: { source: 'agent-input', field: 'month' } } },
        { id: 'arguments', type: 'agent-input', config: { schema: optionalSchema, sample: { minimumScore: 0 } } },
      ], edges: [{ from: 'data', to: 'filter' }, { from: 'filter', to: 'monthfilter' }] },
    });
    const callWith = async (args: JsonObject): Promise<string> => {
      const model = new QueueModel([
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_scores', arguments: args }] }, finishReason: 'tool_calls' },
        { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
      ]);
      await useCase(optionalTool(), model).execute({ ...input, toolId: 'optional-search' });
      return String(model.requests[1]?.messages.at(-1)?.content);
    };

    it('nullable列はrequiredから外れ、function definitionでnullを許容する', () => {
      const definition = toolToModelDefinition(optionalTool());
      expect(definition.parameters.required).toEqual(['minimumScore']);
      expect(definition.parameters.properties['region']).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    });

    it('省略された引数の条件はスキップされ、他の条件だけで絞り込む', async () => {
      // region も month も省略 → 全リージョン・全月で 40点以上。
      const result = await callWith({ minimumScore: 40 });
      expect(result).toContain('Alice');
      expect(result).toContain('Carol');
      expect(result).not.toContain('Bob'); // 必須の minimumScore は従来どおり効く。
    });

    it('nullを明示的に渡した引数の条件もスキップする', async () => {
      const result = await callWith({ minimumScore: 0, region: null, month: null });
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
      expect(result).toContain('Carol');
    });

    it('値が渡された引数は従来どおりvalueへ差し替える（conditions形式・フラット形式とも）', async () => {
      expect(await callWith({ minimumScore: 0, region: 'Tokyo' })).not.toContain('Carol');
      const single = await callWith({ minimumScore: 0, month: '2026-06' });
      expect(single).not.toContain('Alice');
      expect(single).toContain('Bob');
      expect(single).toContain('Carol');
    });

    it('唯一の条件がスキップされたfilterノードは全行を通す', async () => {
      // monthfilter は条件1つだけなので、month 省略で条件ゼロ = パススルーになる。
      const result = await callWith({ minimumScore: 0 });
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
      expect(result).toContain('Carol');
    });

    it('nullableでない引数の省略は、1回差し戻しても直らなければ従来どおり拒否する', async () => {
      const model = new QueueModel([
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_scores', arguments: { region: 'Tokyo' } }] }, finishReason: 'tool_calls' },
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search-2', name: 'search_scores', arguments: { region: 'Tokyo' } }] }, finishReason: 'tool_calls' },
      ]);
      await expect(useCase(optionalTool(), model).execute({ ...input, toolId: 'optional-search' }))
        .rejects.toThrow(/required argument missing: minimumScore/);
      // 差し戻しはツール結果としてモデルへ返る（次の往復でエラー内容が見えている）。
      expect(JSON.stringify(model.requests[1]?.messages)).toContain('required argument missing: minimumScore');
    });
  });

  describe('opBinding（演算子をTool引数で差し替える）', () => {
    // scoreOp / noteOp / note は nullable（省略可）、minimumScore は必須。
    // score 条件は allowed 省略（全演算子）、note 条件は allowed で eq/isNull/notNull に絞る。
    const opSchema: Schema = { columns: [
      { name: 'minimumScore', type: 'number', nullable: false },
      { name: 'scoreOp', type: 'string', nullable: true },
      { name: 'note', type: 'string', nullable: true },
      { name: 'noteOp', type: 'string', nullable: true },
    ] };
    const opTool = (): Tool => createTool({
      metadata: { internalId: 'op-search', workingName: 'op-search', displayName: 'Operator search', publishName: 'op_search', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', inputSchema: opSchema,
      agentTool: { name: 'search_scores', description: 'Search scores; pass scoreOp/noteOp to change the comparison.' },
      graph: { nodes: [
        { id: 'data', type: 'json-source', config: { rows: [
          { name: 'Alice', score: 42, note: 'paid' },
          { name: 'Bob', score: 7, note: null },
          { name: 'Carol', score: 90, note: 'trial' },
        ] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' }, opBinding: { source: 'agent-input', field: 'scoreOp' } },
          { column: 'note', op: 'eq', value: 'paid', valueBinding: { source: 'agent-input', field: 'note' }, opBinding: { source: 'agent-input', field: 'noteOp', allowed: ['eq', 'isNull', 'notNull'] } },
        ], combine: 'and' } },
        { id: 'arguments', type: 'agent-input', config: { schema: opSchema, sample: { minimumScore: 0 } } },
      ], edges: [{ from: 'data', to: 'filter' }] },
    });
    const callWith = async (args: JsonObject): Promise<string> => {
      const model = new QueueModel([
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_scores', arguments: args }] }, finishReason: 'tool_calls' },
        { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
      ]);
      await useCase(opTool(), model).execute({ ...input, toolId: 'op-search' });
      return String(model.requests[1]?.messages.at(-1)?.content);
    };

    it('AIが渡した演算子でfilterが実行される（既定gteをltへ差し替えると結果行が変わる）', async () => {
      const result = await callWith({ minimumScore: 40, scoreOp: 'lt' });
      expect(result).toContain('Bob'); // 40点未満。
      expect(result).not.toContain('Alice');
      expect(result).not.toContain('Carol');
    });

    it('FilterOpでない文字列は差し戻され、直らなければToolArgumentsErrorで拒否する', async () => {
      const model = new QueueModel([
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_scores', arguments: { minimumScore: 0, scoreOp: 'between' } }] }, finishReason: 'tool_calls' },
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search-2', name: 'search_scores', arguments: { minimumScore: 0, scoreOp: 'between' } }] }, finishReason: 'tool_calls' },
      ]);
      await expect(useCase(opTool(), model).execute({ ...input, toolId: 'op-search' }))
        .rejects.toThrow(/invalid operator 'between' for argument 'scoreOp'/);
      // 差し戻しはツール結果としてモデルへ返る（次の往復でエラー内容が見えている）。
      expect(JSON.stringify(model.requests[1]?.messages)).toContain("invalid operator 'between'");
    });

    it('allowed外の演算子は許可リストを添えて拒否する', async () => {
      const model = new QueueModel([
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search', name: 'search_scores', arguments: { minimumScore: 0, note: 'pa', noteOp: 'contains' } }] }, finishReason: 'tool_calls' },
        { message: { role: 'assistant', content: null, toolCalls: [{ id: 'search-2', name: 'search_scores', arguments: { minimumScore: 0, note: 'pa', noteOp: 'contains' } }] }, finishReason: 'tool_calls' },
      ]);
      // contains はFilterOpだが note 条件の allowed には無い。
      await expect(useCase(opTool(), model).execute({ ...input, toolId: 'op-search' }))
        .rejects.toThrow(/invalid operator 'contains' for argument 'noteOp': expected one of eq, isNull, notNull/);
    });

    it('nullableのop引数を省略すると設計時の既定opで実行される（条件はスキップされない）', async () => {
      const result = await callWith({ minimumScore: 40 });
      expect(result).toContain('Alice'); // 既定の gte 40。
      expect(result).toContain('Carol');
      expect(result).not.toContain('Bob'); // 条件が disabled になっていれば Bob も残ってしまう。
    });

    it('実行時にisNullへ解決されたら、value側のnullable引数が省略されていても条件はisNullとして効く', async () => {
      const result = await callWith({ minimumScore: 0, noteOp: 'isNull' });
      expect(result).toContain('Bob'); // note が null の行だけ。
      expect(result).not.toContain('Alice'); // 条件が disabled になっていれば全行が残ってしまう。
      expect(result).not.toContain('Carol');
    });

    it('valueBindingとopBindingを併用すると値と演算子の両方が差し替わる', async () => {
      // score 条件: op gte→gt / value 0→50。note 条件: value paid→trial（op は既定の eq のまま）。
      const result = await callWith({ minimumScore: 50, scoreOp: 'gt', note: 'trial' });
      expect(result).toContain('Carol'); // 50点超 かつ note=trial。
      expect(result).not.toContain('Alice');
      expect(result).not.toContain('Bob');
    });
  });

  it('workspace-output stores an Artifact in the Run session and returns only its descriptor to the model', async () => {
    const workspaceTool = createTool({
      metadata: { internalId: 'workspace-tool', workingName: 'workspace-tool', displayName: 'Workspace tool', publishName: 'workspace_tool', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'session-write', inputSchema,
      graph: { nodes: [
        { id: 'input', type: 'agent-input', config: { schema: inputSchema, sample: { name: 'sample', score: 0 } } },
        { id: 'sink', type: 'workspace-output', config: { name: 'scores', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 } },
      ], edges: [{ from: 'input', to: 'sink' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'workspace_tool', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'stored' }, finishReason: 'stop' },
    ]);
    const sessions = new InMemoryAgentSessionRepository();
    const artifacts = new InMemorySessionArtifactRepository();
    const runtime = new RunAgentPreviewUseCase(new StaticRepository(workspaceTool), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-workspace', () => new Date('2026-07-11T00:00:00.000Z'), undefined, undefined, undefined, undefined, sessions, artifacts);
    const run = await runtime.execute({ ...input, toolId: 'workspace-tool' });
    expect(run.sessionId).toBeTruthy();
    const result = model.requests[1]?.messages.at(-1);
    expect(result?.content).toContain('artifact');
    expect(result?.content).toContain('"preview"');
    const stored = await artifacts.list(scope, run.sessionId as string);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'scores', counts: { rows: 1 } });
  });

  it('lets a Session-enabled Agent list, describe, and read a bounded Workspace Artifact', async () => {
    const workspaceTool = createTool({
      metadata: { internalId: 'workspace-tool', workingName: 'workspace-tool', displayName: 'Workspace tool', publishName: 'workspace_tool', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'session-write', inputSchema,
      graph: { nodes: [
        { id: 'input', type: 'agent-input', config: { schema: inputSchema, sample: { name: 'sample', score: 0 } } },
        { id: 'sink', type: 'workspace-output', config: { name: 'scores', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 0 } },
      ], edges: [{ from: 'input', to: 'sink' }] },
    });
    class WorkspaceModel implements ModelProviderPort {
      readonly requests: ModelCompletionRequest[] = [];
      private artifactId = '';
      capabilities(): readonly ModelCapability[] { return ['chat', 'tool-calling']; }
      async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
        this.requests.push(request);
        switch (this.requests.length) {
          case 1: return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'store', name: 'workspace_tool', arguments: { name: 'Alice', score: 42 } }] }, finishReason: 'tool_calls' };
          case 2: {
            const toolMessage = request.messages.at(-1);
            const content = typeof toolMessage?.content === 'string' ? toolMessage.content : '{}';
            this.artifactId = ((JSON.parse(content) as { artifact?: { id?: string } }).artifact?.id ?? '');
            return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'list', name: 'workspace_list', arguments: {} }] }, finishReason: 'tool_calls' };
          }
          case 3: return { message: { role: 'assistant', content: null, toolCalls: [{ id: 'describe', name: 'workspace_describe', arguments: { artifactId: this.artifactId } }] }, finishReason: 'tool_calls' };
          case 4: return { message: { role: 'assistant', content: null, toolCalls: [
            { id: 'query', name: 'workspace_query', arguments: { artifactId: this.artifactId, columns: ['name'], filter: { column: 'score', op: 'gte', value: 40 }, aggregate: { op: 'avg', column: 'score' } } },
            { id: 'read', name: 'workspace_read', arguments: { artifactId: this.artifactId, limit: 999 } },
          ] }, finishReason: 'tool_calls' };
          default: return { message: { role: 'assistant', content: 'used the artifact' }, finishReason: 'stop' };
        }
      }
    }
    const model = new WorkspaceModel();
    const sessions = new InMemoryAgentSessionRepository();
    const artifacts = new InMemorySessionArtifactRepository();
    const runtime = new RunAgentPreviewUseCase(new StaticRepository(workspaceTool), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-workspace', () => new Date('2026-07-11T00:00:00.000Z'), undefined, undefined, undefined, undefined, sessions, artifacts);
    const run = await runtime.execute({ ...input, toolId: 'workspace-tool' });
    expect(run.response).toBe('used the artifact');
    expect(model.requests[0]?.tools?.map((definition) => definition.name)).toEqual(expect.arrayContaining(['workspace_list', 'workspace_describe', 'workspace_read', 'workspace_query']));
    const workspaceResults = model.requests[4]?.messages.filter((message) => message.role === 'tool').map((message) => message.content) ?? [];
    expect(workspaceResults.join('\n')).toContain('"value":42');
    expect(workspaceResults.join('\n')).toContain('"name":"Alice"');
    expect(workspaceResults.join('\n')).toContain('"artifactId"');
    expect(run.trace.filter((event) => event.kind === 'tool-result').map((event) => event.name)).toEqual(['workspace_tool', 'workspace_list', 'workspace_describe', 'workspace_query', 'workspace_read']);
  });

  it('chart-output はworkspace/graph-outputと同列でrowLimitが10000になる（G21: preview truncationが5000点downsampleより先に効かない）', async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({ id: index, value: index }));
    const chartTool = createTool({
      metadata: { internalId: 'chart-tool', workingName: 'chart-tool', displayName: 'Chart tool', publishName: 'chart_tool', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'session-write',
      graph: { nodes: [
        { id: 'source', type: 'json-source', config: { rows } },
        { id: 'sink', type: 'chart-output', config: { configVersion: 1, name: 'chart', chartType: 'scatter', mapping: { xColumn: 'id', yColumn: 'value' }, maxPoints: 5000, downsample: 'none', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 } },
      ], edges: [{ from: 'source', to: 'sink' }] },
    });
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', name: 'chart_tool', arguments: {} }] }, finishReason: 'tool_calls' },
      { message: { role: 'assistant', content: 'stored' }, finishReason: 'stop' },
    ]);
    const sessions = new InMemoryAgentSessionRepository();
    const artifacts = new InMemorySessionArtifactRepository();
    const runtime = new RunAgentPreviewUseCase(new StaticRepository(chartTool), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-chart', () => new Date('2026-07-11T00:00:00.000Z'), undefined, undefined, undefined, undefined, sessions, artifacts);
    const run = await runtime.execute({ ...input, toolId: 'chart-tool' });
    const toolResult = run.trace.find((event) => event.kind === 'tool-result');
    // 修正前は preview rowLimit が既定100に落ち、sinkノードが150行のうち100行へtruncateされていた。
    expect(toolResult?.nodes).toContainEqual({ nodeId: 'sink', rowCount: 150, truncated: false });
    const stored = await artifacts.list(scope, run.sessionId as string);
    expect(stored).toHaveLength(1);
    const found = await artifacts.find(scope, run.sessionId as string, stored[0]!.id);
    expect(found?.payload).toMatchObject({ sourceRowCount: 150, sampled: false });
  });

  it('Agentは自分が出力したchart-output Artifactをworkspace_*ツールで参照できる（G21: workspaceDefinitionsにchart-outputが含まれる）', async () => {
    const chartTool = createTool({
      metadata: { internalId: 'chart-tool', workingName: 'chart-tool', displayName: 'Chart tool', publishName: 'chart_tool', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'session-write',
      graph: { nodes: [
        { id: 'source', type: 'json-source', config: { rows: [{ id: 1, value: 10 }] } },
        { id: 'sink', type: 'chart-output', config: { configVersion: 1, name: 'chart', chartType: 'scatter', mapping: { xColumn: 'id', yColumn: 'value' }, maxPoints: 100, downsample: 'none', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 } },
      ], edges: [{ from: 'source', to: 'sink' }] },
    });
    const model = new QueueModel([{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }]);
    const sessions = new InMemoryAgentSessionRepository();
    const artifacts = new InMemorySessionArtifactRepository();
    const runtime = new RunAgentPreviewUseCase(new StaticRepository(chartTool), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-chart-ws', () => new Date('2026-07-11T00:00:00.000Z'), undefined, undefined, undefined, undefined, sessions, artifacts);
    await runtime.execute({ ...input, toolId: 'chart-tool' });
    // chart-output しかない場合でも workspace_* ツールが公開される（従来は workspace/graph-output限定で漏れていた）。
    expect(model.requests[0]?.tools?.map((definition) => definition.name)).toEqual(expect.arrayContaining(['workspace_list', 'workspace_describe', 'workspace_read', 'workspace_query']));
  });

  it('workspace_query は選択・比較・集計をデータ専用 DSL として実行する', () => {
    const payload = {
      schema: { columns: [
        { name: 'name', type: 'string', nullable: false },
        { name: 'score', type: 'number', nullable: false },
        { name: 'active', type: 'boolean', nullable: false },
      ] },
      rows: [
        { name: 'Alice', score: 42, active: true },
        { name: 'Bob', score: 7, active: false },
        { name: 'Alicia', score: 84, active: true },
      ],
      page: { offset: 10, limit: 3, nextOffset: 13 },
    };
    const result = queryWorkspaceTable(payload, {
      columns: ['name'],
      filter: { column: 'score', op: 'gte', value: 40 },
      aggregate: { op: 'avg', column: 'score' },
    });
    expect(result).toEqual({
      schema: { columns: [{ name: 'name', type: 'string', nullable: false }] },
      rows: [{ name: 'Alice' }, { name: 'Alicia' }],
      page: { offset: 10, limit: 3, nextOffset: 13 },
      aggregate: { op: 'avg', column: 'score', value: 63 },
    });
    expect(queryWorkspaceTable(payload, { filter: { column: 'name', op: 'contains', value: 'lic' }, aggregate: { op: 'count' } }).aggregate).toEqual({ op: 'count', value: 2 });
    expect(queryWorkspaceTable(payload, { filter: { column: 'score', op: 'gt', value: 42 }, aggregate: { op: 'sum', column: 'score' } }).aggregate).toEqual({ op: 'sum', column: 'score', value: 84 });
    expect(queryWorkspaceTable(payload, { filter: { column: 'score', op: 'lt', value: 42 }, aggregate: { op: 'min', column: 'score' } }).aggregate).toEqual({ op: 'min', column: 'score', value: 7 });
    expect(queryWorkspaceTable(payload, { filter: { column: 'score', op: 'lte', value: 42 }, aggregate: { op: 'max', column: 'score' } }).aggregate).toEqual({ op: 'max', column: 'score', value: 42 });
    expect(queryWorkspaceTable(payload, { filter: { column: 'active', op: 'eq', value: true } }).rows).toHaveLength(2);
    expect(queryWorkspaceTable(payload, { filter: { column: 'active', op: 'neq', value: true } }).rows).toHaveLength(1);
  });

  it('workspace_query は未対応のペイロードや不正な構造化クエリを拒否する', () => {
    const table = { schema: inputSchema, rows: [{ name: 'Alice', score: 42 }] };
    expect(() => queryWorkspaceTable({ nodes: [] }, {})).toThrow('table Artifacts only');
    expect(() => queryWorkspaceTable(table, { columns: [] })).toThrow('known column names');
    expect(() => queryWorkspaceTable(table, { filter: { column: 'name', op: 'contains', value: 1 } })).toThrow('string value');
    expect(() => queryWorkspaceTable(table, { filter: { column: 'name', op: 'equals', value: 'Alice' } })).toThrow('supported operator');
    expect(() => queryWorkspaceTable(table, { aggregate: { op: 'sum' } })).toThrow('numeric aggregate');
  });

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

  it('Agent allowlist内のWikiだけを検索・注入しallowlist外の手動指定を拒否する', async () => {
    const agent = createAgent({ metadata: { internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope }, kind: 'normal', systemPrompt: 'Answer.', tools: [], wikis: [{ wikiId: 'customer-a' }] });
    const wiki = new FakeWikiRepository();
    await wiki.saveSpace(createWikiSpace({ id: 'customer-a', tenant: scope, name: 'Customer A', createdAt: '2026-07-11T00:00:00.000Z' }));
    await wiki.saveSpace(createWikiSpace({ id: 'customer-b', tenant: scope, name: 'Customer B', createdAt: '2026-07-11T00:00:00.000Z' }));
    await wiki.save(createWikiPage({ id: 'page-a', wikiId: 'customer-a', tenant: scope, title: 'Refund policy', body: 'Alpha refunds require a receipt.', updatedAt: '2026-07-11T00:00:00.000Z' }));
    await wiki.save(createWikiPage({ id: 'page-b', wikiId: 'customer-b', tenant: scope, title: 'Refund policy', body: 'Beta refunds never require a receipt.', updatedAt: '2026-07-11T00:00:00.000Z' }));
    const model = new QueueModel([{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }]);
    const usecase = new RunAgentPreviewUseCase(new StaticRepository(null), new EtlEngine(createDefaultRegistry()), model, new MemoryRuns(), () => 'run-wiki', undefined, new StaticAgents(agent), undefined, undefined, wiki);
    await usecase.executeSaved({ scope, agentId: 'agent', message: 'What is the refund policy?', mode: 'preview' });
    const system = model.requests[0]?.messages[0]?.content ?? '';
    expect(system).toContain('Customer A / Refund policy'); expect(system).toContain('Alpha refunds'); expect(system).not.toContain('Beta refunds');
    await expect(usecase.executeSaved({ scope, agentId: 'agent', message: 'x', mode: 'preview', memoryPageIds: ['page-b'] })).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/outside Agent wiki allowlist/) }) });
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
  async delete(): Promise<boolean> { return false; }
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

// ---------------------------------------------------------------------------
// ランタイムハーネス（Agent単位のopt-in）
// ---------------------------------------------------------------------------

class StaticSearchCatalog implements SearchProviderCatalog {
  constructor(private readonly providers: readonly SearchProviderSummary[], private readonly rows: readonly NormalizedSearchRow[] = []) {}
  list(): readonly SearchProviderSummary[] { return this.providers; }
  async search(_request: SearchRequest): Promise<readonly NormalizedSearchRow[]> { return this.rows; }
}

function harnessOf(overrides: Partial<AgentRuntimeHarness>): AgentRuntimeHarness {
  return { ...DEFAULT_AGENT_RUNTIME_HARNESS, ...overrides };
}

function harnessUseCase(options: {
  readonly agent: Agent;
  readonly model: ModelProviderPort;
  readonly tool?: Tool | null;
  readonly runs?: RunRepository;
  readonly wiki?: WikiRepository;
  readonly sessions?: AgentSessionRepository;
  readonly artifacts?: SessionArtifactRepository;
  readonly webSearch?: WebSearchUseCase;
  readonly mcpServers?: McpServerRepository;
  readonly mcpClient?: McpClientPort;
  readonly now?: () => Date;
  readonly observability?: RunObservabilityOptions;
}): RunAgentPreviewUseCase {
  let sequence = 0;
  return new RunAgentPreviewUseCase(
    new StaticRepository(options.tool ?? null), new EtlEngine(createDefaultRegistry()), options.model,
    options.runs ?? new MemoryRuns(), () => `run-${(sequence += 1)}`, options.now ?? (() => new Date('2026-07-11T00:00:00.000Z')),
    new StaticAgents(options.agent), undefined, options.observability,
    options.wiki, options.sessions, options.artifacts, undefined, options.webSearch,
    options.mcpServers, options.mcpClient,
  );
}

function toolContents(request: ModelCompletionRequest | undefined): readonly string[] {
  return (request?.messages ?? []).filter((message) => message.role === 'tool').map((message) => String(message.content));
}

describe('RunAgentPreviewUseCase runtime harness', () => {
  it('harness未設定Agentは従来どおりでハーネスツールを一切注入しない', async () => {
    const agent = createAgent({ metadata: agentMeta('plain'), kind: 'normal', systemPrompt: 'Answer.', tools: [] });
    const model = new QueueModel([stop('ok')]);
    const search = new WebSearchUseCase(new StaticSearchCatalog([{ id: 'tavily', label: 'Tavily', supportsDomainFilter: true }]));
    const run = await harnessUseCase({ agent, model, wiki: new FakeWikiRepository(), webSearch: search })
      .executeSaved({ scope, agentId: 'plain', message: 'go', mode: 'preview' });

    expect(run.response).toBe('ok');
    expect(model.requests[0]?.tools).toBeUndefined();
    expect(run.trace.find((event) => event.kind === 'model-request')).toMatchObject({ toolNames: [] });
  });

  it('functionInvocation:falseはツールを渡さず1往復で終える', async () => {
    const agent = createAgent({
      metadata: agentMeta('no-loop'), kind: 'normal', systemPrompt: 'Answer directly.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }],
      harness: harnessOf({ functionInvocation: false, todoProvider: true }),
    });
    const model = new QueueModel([stop('answered without tools')]);
    const run = await harnessUseCase({ agent, model, tool: makeTool() })
      .executeSaved({ scope, agentId: 'no-loop', message: 'go', mode: 'preview' });

    expect(run.response).toBe('answered without tools');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.tools).toBeUndefined();
  });

  it('todos_add→todos_completeで状態遷移し、セッションArtifactへ新revisionで保存・次Runで復元する', async () => {
    const agent = createAgent({
      metadata: agentMeta('todo-agent'), kind: 'normal', systemPrompt: 'Track the work.',
      tools: [], harness: harnessOf({ todoProvider: true }),
    });
    const sessions = new InMemoryAgentSessionRepository();
    const artifacts = new InMemorySessionArtifactRepository();
    const model = new QueueModel([
      toolCall('t1', 'todos_add', { items: ['collect data', 'summarize'] }),
      toolCall('t2', 'todos_complete', { indexes: [1, 9] }),
      stop('tracked'),
    ]);
    const run = await harnessUseCase({ agent, model, sessions, artifacts })
      .executeSaved({ scope, agentId: 'todo-agent', message: 'go', mode: 'preview' });

    expect(model.requests[0]?.tools?.map((definition) => definition.name)).toEqual(['todos_add', 'todos_complete']);
    const results = toolContents(model.requests[2]);
    expect(JSON.parse(results[0] as string)).toEqual({ todos: [
      { index: 1, content: 'collect data', status: 'pending' },
      { index: 2, content: 'summarize', status: 'pending' },
    ] });
    // 未知indexは無視して報告し、既知indexだけを完了にする。
    expect(JSON.parse(results[1] as string)).toEqual({ todos: [
      { index: 1, content: 'collect data', status: 'completed' },
      { index: 2, content: 'summarize', status: 'pending' },
    ], ignored: [9] });
    expect(run.trace.filter((event) => event.kind === 'tool-result').map((event) => event.name)).toEqual(['todos_add', 'todos_complete']);

    const sessionId = run.sessionId as string;
    const stored = (await artifacts.list(scope, sessionId)).filter((artifact) => artifact.name === 'harness-todos');
    expect(stored.map((artifact) => artifact.revision).sort()).toEqual([1, 2]);
    expect(stored[0]?.origin).toMatchObject({ toolId: 'builtin-harness-todos', toolVersion: '1.0.0', sinkNodeId: 'harness-todos', agentId: 'todo-agent' });

    // 同じセッションの次Runでは最新revisionから復元される。
    const resume = new QueueModel([toolCall('t3', 'todos_complete', { indexes: [2] }), stop('finished')]);
    await harnessUseCase({ agent, model: resume, sessions, artifacts })
      .executeSaved({ scope, agentId: 'todo-agent', message: 'continue', mode: 'preview', sessionId });
    expect(JSON.parse(toolContents(resume.requests[1])[0] as string)).toEqual({ todos: [
      { index: 1, content: 'collect data', status: 'completed' },
      { index: 2, content: 'summarize', status: 'completed' },
    ] });
  });

  it('todoProviderはセッションが無くてもRun内メモリだけで動作する', async () => {
    const agent = createAgent({ metadata: agentMeta('todo-nosession'), kind: 'normal', systemPrompt: 'Track.', tools: [], harness: harnessOf({ todoProvider: true }) });
    const model = new QueueModel([toolCall('t1', 'todos_add', { items: ['only in memory'] }), stop('ok')]);
    const run = await harnessUseCase({ agent, model }).executeSaved({ scope, agentId: 'todo-nosession', message: 'go', mode: 'preview' });

    expect(run.sessionId).toBeUndefined();
    expect(JSON.parse(toolContents(model.requests[1])[0] as string)).toEqual({ todos: [{ index: 1, content: 'only in memory', status: 'pending' }] });
  });

  it('memory_write→memory_read→memory_listが専用Wikiを自動作成し改訂する', async () => {
    const wiki = new FakeWikiRepository();
    const agent = createAgent({ metadata: agentMeta('memo'), kind: 'normal', systemPrompt: 'Remember facts.', tools: [], harness: harnessOf({ fileMemory: true }) });
    const model = new QueueModel([
      toolCall('m1', 'memory_write', { title: 'Refund policy', body: 'Refunds require a receipt.' }),
      toolCall('m2', 'memory_write', { title: 'Refund policy', body: 'Refunds require a receipt and an order id.' }),
      toolCall('m3', 'memory_read', { title: 'Refund policy' }),
      toolCall('m4', 'memory_list', {}),
      stop('remembered'),
    ]);
    const run = await harnessUseCase({ agent, model, wiki }).executeSaved({ scope, agentId: 'memo', message: 'note the refund policy', mode: 'preview' });

    expect(model.requests[0]?.tools?.map((definition) => definition.name)).toEqual(['memory_list', 'memory_read', 'memory_write']);
    const contents = toolContents(model.requests[4]);
    expect(JSON.parse(contents[0] as string)).toEqual({ wikiId: 'agent-memory--memo', title: 'Refund policy', version: 1, created: true });
    expect(JSON.parse(contents[1] as string)).toEqual({ wikiId: 'agent-memory--memo', title: 'Refund policy', version: 2, created: false });
    expect(JSON.parse(contents[2] as string)).toMatchObject({ found: true, version: 2, truncated: false, body: 'Refunds require a receipt and an order id.' });
    expect(JSON.parse(contents[3] as string)).toMatchObject({ wikiId: 'agent-memory--memo', pages: [{ title: 'Refund policy', updatedAt: '2026-07-11T00:00:00.000Z' }] });

    // 専用Wiki空間は初回書き込みで冪等に自動作成され、ページは1件（改訂）だけ。
    expect(await wiki.findSpace(scope, 'agent-memory--memo')).toMatchObject({ id: 'agent-memory--memo' });
    const pages = await wiki.list(scope, 'agent-memory--memo');
    expect(pages).toHaveLength(1);
    const page = await wiki.find(scope, pages[0]?.id as string);
    expect(page).toMatchObject({ version: 2, sourceRuns: [run.runId] });
  });

  it('未知タイトルのmemory_readはfound:falseを返す', async () => {
    const agent = createAgent({ metadata: agentMeta('memo2'), kind: 'normal', systemPrompt: 'Remember.', tools: [], harness: harnessOf({ fileMemory: true }) });
    const model = new QueueModel([toolCall('m1', 'memory_read', { title: 'Nothing here' }), stop('none')]);
    await harnessUseCase({ agent, model, wiki: new FakeWikiRepository() }).executeSaved({ scope, agentId: 'memo2', message: 'go', mode: 'preview' });
    expect(JSON.parse(toolContents(model.requests[1])[0] as string)).toEqual({ found: false, title: 'Nothing here' });
  });

  it('fileMemory有効時は専用Wikiを自動想起の検索対象へ加える', async () => {
    const wiki = new FakeWikiRepository();
    await wiki.saveSpace(createWikiSpace({ id: 'agent-memory--recall', tenant: scope, name: 'Agent memory', createdAt: '2026-07-11T00:00:00.000Z' }));
    await wiki.save(createWikiPage({ id: 'memory-1', wikiId: 'agent-memory--recall', tenant: scope, title: 'Escalation', body: 'Escalate refunds above 500 USD.', updatedAt: '2026-07-11T00:00:00.000Z' }));
    const agent = createAgent({ metadata: agentMeta('recall'), kind: 'normal', systemPrompt: 'Answer.', tools: [], harness: harnessOf({ fileMemory: true }) });
    const model = new QueueModel([stop('ok')]);
    await harnessUseCase({ agent, model, wiki }).executeSaved({ scope, agentId: 'recall', message: 'What is the escalation rule?', mode: 'preview' });
    expect(String(model.requests[0]?.messages[0]?.content)).toContain('Escalate refunds above 500 USD.');
  });

  it('web_searchは先頭プロバイダで検索し上位5件へ切り詰める', async () => {
    const rows: NormalizedSearchRow[] = Array.from({ length: 8 }, (_, index) => ({
      title: `Result ${index}`, url: `https://example.com/${index}`, snippet: 'z'.repeat(400),
      score: null, provider: 'tavily', retrievedAt: '2026-07-11T00:00:00.000Z',
    }));
    const search = new WebSearchUseCase(
      new StaticSearchCatalog([{ id: 'tavily', label: 'Tavily', supportsDomainFilter: true }], rows),
      () => 'cache-1', () => new Date('2026-07-11T00:00:00.000Z'),
    );
    const agent = createAgent({ metadata: agentMeta('searcher'), kind: 'normal', systemPrompt: 'Search.', tools: [], harness: harnessOf({ webSearch: true }) });
    const model = new QueueModel([toolCall('w1', 'web_search', { query: '  agentblume  ', maxResults: 9 }), stop('searched')]);
    await harnessUseCase({ agent, model, webSearch: search }).executeSaved({ scope, agentId: 'searcher', message: 'go', mode: 'preview' });

    expect(model.requests[0]?.tools?.map((definition) => definition.name)).toEqual(['web_search']);
    const payload = JSON.parse(toolContents(model.requests[1])[0] as string) as { provider: string; query: string; results: readonly { title: string; snippet: string }[] };
    expect(payload.provider).toBe('tavily');
    expect(payload.query).toBe('agentblume');
    expect(payload.results).toHaveLength(5);
    expect(payload.results[0]?.title).toBe('Result 0');
    // snippetは300字クリップ（+省略記号）。
    expect(payload.results[0]?.snippet).toHaveLength(301);
  });

  it('検索プロバイダが未設定ならweb_searchツール自体を注入しない', async () => {
    const search = new WebSearchUseCase(new StaticSearchCatalog([]));
    const agent = createAgent({ metadata: agentMeta('searcher2'), kind: 'normal', systemPrompt: 'Search.', tools: [], harness: harnessOf({ webSearch: true }) });
    const model = new QueueModel([stop('no provider')]);
    const run = await harnessUseCase({ agent, model, webSearch: search }).executeSaved({ scope, agentId: 'searcher2', message: 'go', mode: 'preview' });
    expect(run.response).toBe('no provider');
    expect(model.requests[0]?.tools).toBeUndefined();
  });

  it('compaction有効時は予算超過の往復で履歴を圧縮しtraceへcompactionを積む', async () => {
    const agent = createAgent({ metadata: agentMeta('compactor'), kind: 'normal', systemPrompt: 'Answer.', tools: [], harness: harnessOf({ compaction: true }) });
    const history = Array.from({ length: 4 }, (_, index) => ({ role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: 'h'.repeat(7_000) }));
    const model = new QueueModel([stop('compacted answer')]);
    const run = await harnessUseCase({ agent, model }).executeSaved({ scope, agentId: 'compactor', message: 'go', mode: 'preview', history });

    // system(7) + 履歴28000 + user(2) = 28009 → 古い2件を落として 14009。
    expect(run.trace.find((event) => event.kind === 'compaction')).toMatchObject({ kind: 'compaction', beforeChars: 28_009, afterChars: 14_009 });
    expect(model.requests[0]?.messages).toHaveLength(4);
  });

  it('compaction有効でも予算内ならメッセージもtraceも変えない（境界）', async () => {
    const agent = createAgent({ metadata: agentMeta('compactor2'), kind: 'normal', systemPrompt: 'Answer.', tools: [], harness: harnessOf({ compaction: true }) });
    const history = Array.from({ length: 2 }, () => ({ role: 'user' as const, content: 'h'.repeat(1_000) }));
    const model = new QueueModel([stop('short answer')]);
    const run = await harnessUseCase({ agent, model }).executeSaved({ scope, agentId: 'compactor2', message: 'go', mode: 'preview', history });

    expect(run.trace.some((event) => event.kind === 'compaction')).toBe(false);
    expect(model.requests[0]?.messages).toHaveLength(4);
  });

  it('ハーネス明示設定Agentはノード内のモデル往復上限を8へ拡張する', async () => {
    const agent = createAgent({
      metadata: agentMeta('looper'), kind: 'normal', systemPrompt: 'Loop.', tools: [],
      harness: harnessOf({ todoProvider: true }),
    });
    // 既定(5)なら6往復目で失敗するが、ハーネス設定Agentは8往復まで許される。
    const model = new QueueModel([
      ...Array.from({ length: 6 }, (_, index) => toolCall(`t${index}`, 'todos_add', { items: [`step ${index}`] })),
      stop('finished after seven rounds'),
    ]);
    const run = await harnessUseCase({ agent, model }).executeSaved({ scope, agentId: 'looper', message: 'go', mode: 'preview' });
    expect(run.response).toBe('finished after seven rounds');
    expect(model.requests).toHaveLength(7);
  });

  it('ハーネス明示設定Agentはノード内のツール呼び出し上限を12へ拡張する', async () => {
    const agent = createAgent({
      metadata: agentMeta('many-calls'), kind: 'normal', systemPrompt: 'Look up scores.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }], harness: harnessOf({}),
    });
    // 1往復で5件（既定の MAX_TOOL_CALLS=4 超）。ハーネス設定Agentなら通る。
    const calls = Array.from({ length: 5 }, (_, index) => ({ id: `c${index}`, name: 'score_lookup', arguments: { name: `N${index}`, score: index } }));
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: calls }, finishReason: 'tool_calls' },
      stop('looked up five'),
    ]);
    const run = await harnessUseCase({ agent, model, tool: makeTool() }).executeSaved({ scope, agentId: 'many-calls', message: 'go', mode: 'preview' });
    expect(run.response).toBe('looked up five');
    expect(run.tools).toHaveLength(5);
  });

  it('functionInvocation:falseでモデルがツールを呼んだらfail closedで拒否する', async () => {
    const agent = createAgent({
      metadata: agentMeta('closed'), kind: 'normal', systemPrompt: 'Answer.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }],
      harness: harnessOf({ functionInvocation: false }),
    });
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'A', score: 1 })]);
    await expect(harnessUseCase({ agent, model, tool: makeTool() }).executeSaved({ scope, agentId: 'closed', message: 'go', mode: 'preview' }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/function invocation is disabled/) }) });
  });
});

// ---------------------------------------------------------------------------
// toolApproval（承認待ち → 再開）
// ---------------------------------------------------------------------------

function approvalAgent(id = 'approver'): Agent {
  return createAgent({
    metadata: agentMeta(id), kind: 'normal', systemPrompt: 'Use the tool.',
    tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }],
    harness: harnessOf({ toolApproval: true }),
  });
}
const kinds = (run: { readonly trace: readonly { readonly kind: string }[] }): readonly string[] => run.trace.map((event) => event.kind);

describe('RunAgentPreviewUseCase tool approval', () => {
  it('toolApproval:on + session-writeツール + interactive なら、実行前に waiting-approval で停止する', async () => {
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 })]);
    const run = await harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs })
      .executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });

    expect(run.status).toBe('waiting-approval');
    expect(run.checkpoint).toMatchObject({ tool: 'score_lookup', sideEffect: 'session-write', expiresAt: '2026-07-12T00:00:00.000Z' });
    expect(run.checkpoint?.prompt).toContain('Approval required');
    // ツールは実行されていない（tool-call / tool-result が無い）。
    expect(kinds(run)).toEqual(['model-request', 'approval-requested']);

    const stored = runs.records.get(run.runId);
    expect(stored?.status).toBe('waiting-approval');
    expect(stored?.checkpoint).toMatchObject({
      kind: 'tool-approval', step: 1,
      agentRef: { internalId: 'approver', version: '1.0.0' },
      pendingCalls: [{ id: 'c1', name: 'score_lookup', arguments: { name: 'Alice', score: 42 } }],
      executedToolRefs: [],
      budget: { remainingModelRounds: 11, remainingToolCalls: 16 },
    });
    // 再開に必要な全メッセージ（assistantのtoolCalls含む）が保存されている。
    expect(stored?.checkpoint?.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(stored?.checkpoint?.messages.at(-1)?.toolCalls).toMatchObject([{ id: 'c1', name: 'score_lookup' }]);
  });

  it('approve再開でツールを実行して完走し、traceに approval-requested → approval-resolved が正順で並ぶ', async () => {
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('Alice: 42')]);
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs });
    const paused = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });
    const resumed = await usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'approve' });

    expect(resumed.runId).toBe(paused.runId);
    expect(resumed.status).toBeUndefined();
    expect(resumed.response).toBe('Alice: 42');
    expect(kinds(resumed)).toEqual(['model-request', 'approval-requested', 'approval-resolved', 'tool-call', 'tool-result', 'model-request', 'model-response']);
    expect(resumed.trace.find((event) => event.kind === 'approval-resolved')).toMatchObject({ decision: 'approve' });
    expect(resumed.tools).toMatchObject([{ internalId: 'score-tool', version: '1.2.0' }]);
    // usage は停止前の往復ぶんも通算される。
    expect(resumed.usage.totalTokens).toBe(2);
    // 承認したツールの結果がモデルへ渡る。
    expect(toolContents(model.requests[1])[0]).toContain('"name":"Alice"');

    const stored = runs.records.get(paused.runId);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.checkpoint).toBeUndefined();
  });

  it('再開でもモデル設定を先に解決してから capabilities ガードを通す', async () => {
    /**
     * 切替可能な配線の capabilities() は「最後に解決したアダプタ」の能力を返す同期契約なので、
     * 解決を挟まずに prepareLoop を通すと env 既定由来の古い能力でガードが誤判定する。
     * 「解決するまで tool-calling を持たないモデル」で、再開経路が解決を先に走らせることを固定する。
     */
    const runs = new MemoryRuns();
    const queue: ModelCompletion[] = [toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('Alice: 42')];
    const requests: ModelCompletionRequest[] = [];
    let resolved = false;
    const model: ModelProviderPort = {
      capabilities: () => resolved ? ['chat', 'tool-calling'] : ['chat'],
      complete: async (request) => {
        requests.push(request);
        const item = queue.shift();
        if (item === undefined) throw new Error('missing completion');
        return item;
      },
    };
    const observability: RunObservabilityOptions = {
      model: { provider: 'openai-compatible', model: 'stale', modelConfigHash: 'stale' },
      resolveModel: async () => { resolved = true; return { provider: 'openai-compatible', model: 'switched', modelConfigHash: 'switched' }; },
    };
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs, observability });

    const paused = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });
    expect(paused.status).toBe('waiting-approval');
    // 承認待ちの間にUIでモデルを切り替えた状況（次の解決まで能力は古いまま）。
    resolved = false;

    const resumed = await usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'approve' });

    expect(resumed.response).toBe('Alice: 42');
    expect(resolved).toBe(true);
    expect(runs.records.get(paused.runId)?.status).toBe('succeeded');
  });

  it('モデル設定の解決に失敗しても実行は続け、握り潰さずloggerへ残す', async () => {
    const warns: { message: string; context?: Record<string, unknown> }[] = [];
    const logger = { info: () => {}, warn: (message: string, context?: Record<string, unknown>) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); }, error: () => {} };
    const runs = new MemoryRuns();
    const stale = { provider: 'openai-compatible', model: 'stale', modelConfigHash: 'stale' };
    const usecase = harnessUseCase({
      agent: approvalAgent(), model: new QueueModel([stop('done')]), tool: makeTool('session-write'), runs,
      observability: { model: stale, resolveModel: async () => { throw new Error('key file changed'); }, logger },
    });

    const run = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview' });

    expect(run.response).toBe('done');
    // 実行は止めず、記録は既知の指紋へフォールバックする。
    expect(runs.records.get(run.runId)?.model).toEqual(stale);
    expect(warns).toEqual([{ message: 'model settings could not be resolved; falling back to the last known snapshot', context: { reason: 'key file changed' } }]);
  });

  it('reject再開は拒否結果をモデルへ渡し、代替案で完走できる', async () => {
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('I will not run that tool.')]);
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs });
    const paused = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });
    const resumed = await usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'reject', feedback: 'too risky' });

    expect(resumed.response).toBe('I will not run that tool.');
    expect(kinds(resumed)).toEqual(['model-request', 'approval-requested', 'approval-resolved', 'model-request', 'model-response']);
    expect(resumed.trace.find((event) => event.kind === 'approval-resolved')).toMatchObject({ decision: 'reject' });
    expect(JSON.parse(toolContents(model.requests[1])[0] as string)).toEqual({ approved: false, reason: 'too risky' });
    // ツールは実行されていない。
    expect(resumed.tools).toBeUndefined();
    expect(runs.records.get(paused.runId)?.status).toBe('succeeded');
  });

  it('feedback省略のrejectは既定理由をモデルへ渡す', async () => {
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('understood')]);
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs });
    const paused = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });
    await usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'reject' });
    expect(JSON.parse(toolContents(model.requests[1])[0] as string)).toEqual({ approved: false, reason: 'rejected by user' });
  });

  it('同一往復の2件目が承認対象なら、1件目を実行してから再び承認待ちになる', async () => {
    const runs = new MemoryRuns();
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: [
        { id: 'c1', name: 'score_lookup', arguments: { name: 'A', score: 1 } },
        { id: 'c2', name: 'score_lookup', arguments: { name: 'B', score: 2 } },
      ] }, finishReason: 'tool_calls', usage: { totalTokens: 1 } },
      stop('both applied'),
    ]);
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs });
    const first = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });
    expect(runs.records.get(first.runId)?.checkpoint?.pendingCalls).toMatchObject([{ id: 'c1' }, { id: 'c2' }]);

    const second = await usecase.resumeSavedRun({ scope, runId: first.runId, decision: 'approve' });
    expect(second.status).toBe('waiting-approval');
    // 1件目だけ実行され、2件目が新しい承認対象として残る。
    expect(runs.records.get(first.runId)?.checkpoint).toMatchObject({ step: 1, pendingCalls: [{ id: 'c2' }], executedToolRefs: [{ internalId: 'score-tool' }] });
    expect(kinds(second)).toEqual(['model-request', 'approval-requested', 'approval-resolved', 'tool-call', 'tool-result', 'approval-requested']);

    const third = await usecase.resumeSavedRun({ scope, runId: first.runId, decision: 'approve' });
    expect(third.response).toBe('both applied');
    expect(third.tools).toHaveLength(2);
  });

  it('interactive未指定（Harness/Factory/シナリオ検証など）は承認ゲートを通さず従来どおり実行する', async () => {
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('done')]);
    const run = await harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write') })
      .executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview' });

    expect(run.status).toBeUndefined();
    expect(run.response).toBe('done');
    expect(kinds(run)).toEqual(['model-request', 'tool-call', 'tool-result', 'model-request', 'model-response']);
  });

  it('toolApproval:off なら interactive でも従来どおり実行する', async () => {
    const agent = createAgent({
      metadata: agentMeta('no-approval'), kind: 'normal', systemPrompt: 'Use the tool.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }], harness: harnessOf({}),
    });
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('done')]);
    const run = await harnessUseCase({ agent, model, tool: makeTool('session-write') })
      .executeSaved({ scope, agentId: 'no-approval', message: 'go', mode: 'preview', interactive: true });

    expect(run.response).toBe('done');
    expect(run.trace.some((event) => event.kind === 'approval-requested')).toBe(false);
  });

  it('read-onlyツールは toolApproval:on + interactive でも承認を要求しない', async () => {
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('done')]);
    const run = await harnessUseCase({ agent: approvalAgent(), model, tool: makeTool() })
      .executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });

    expect(run.response).toBe('done');
    expect(run.trace.some((event) => event.kind === 'approval-requested')).toBe(false);
  });

  it('ランタイムツール（todos_*）は toolApproval:on でも自動承認で実行する', async () => {
    const agent = createAgent({
      metadata: agentMeta('todo-approver'), kind: 'normal', systemPrompt: 'Track.', tools: [],
      harness: harnessOf({ toolApproval: true, todoProvider: true }),
    });
    const model = new QueueModel([toolCall('t1', 'todos_add', { items: ['step 1'] }), stop('tracked')]);
    const run = await harnessUseCase({ agent, model }).executeSaved({ scope, agentId: 'todo-approver', message: 'go', mode: 'preview', interactive: true });

    expect(run.response).toBe('tracked');
    expect(run.trace.some((event) => event.kind === 'approval-requested')).toBe(false);
  });

  it('委譲の子Run（depth>0）は toolApproval でも停止せず自動承認で実行する', async () => {
    const sub = createAgent({
      metadata: agentMeta('sub'), kind: 'normal', systemPrompt: 'Score.',
      tools: [{ internalId: 'score-tool', version: SemVer.parse('1.2.0') }], harness: harnessOf({ toolApproval: true }),
    });
    const root = createAgent({ metadata: agentMeta('root'), kind: 'normal', systemPrompt: 'Delegate.', tools: [], agents: [subRef('sub')] });
    const runs = new MemoryRuns();
    const model = new QueueModel([
      toolCall('c1', 'ask_sub', { message: 'score Alice' }),
      toolCall('c2', 'score_lookup', { name: 'Alice', score: 42 }),
      stop('sub done'),
      stop('root done'),
    ]);
    const run = await multiUseCase(makeTool('session-write'), model, new MapAgents(new Map([['sub', sub], ['root', root]])), runs)
      .executeSaved({ scope, agentId: 'root', message: 'go', mode: 'preview', interactive: true });

    expect(run.response).toBe('root done');
    expect(runs.records.get('run-2')?.status).toBe('succeeded');
    expect(runs.records.get('run-2')?.trace.some((event) => event.kind === 'approval-requested')).toBe(false);
  });

  it('期限切れcheckpointの再開はRunをfailedへ確定してエラーにする', async () => {
    const runs = new MemoryRuns();
    let clock = new Date('2026-07-11T00:00:00.000Z');
    const model = new QueueModel([toolCall('c1', 'score_lookup', { name: 'Alice', score: 42 }), stop('never reached')]);
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool('session-write'), runs, now: () => clock });
    const paused = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });
    clock = new Date('2026-07-13T00:00:00.000Z');

    await expect(usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'approve' }))
      .rejects.toMatchObject({ runId: paused.runId, cause: expect.objectContaining({ message: expect.stringMatching(/checkpoint expired/) }) });
    const stored = runs.records.get(paused.runId);
    expect(stored?.status).toBe('failed');
    expect(stored?.checkpoint).toBeUndefined();
    expect(stored?.failure).toMatchObject({ code: 'AGENT_RUN' });
    // モデルは再開で呼ばれない。
    expect(model.requests).toHaveLength(1);
  });

  it('承認待ちでないRun・未知のRunの再開を拒否する', async () => {
    const runs = new MemoryRuns();
    const model = new QueueModel([stop('done')]);
    const usecase = harnessUseCase({ agent: approvalAgent(), model, tool: makeTool(), runs });
    const done = await usecase.executeSaved({ scope, agentId: 'approver', message: 'go', mode: 'preview', interactive: true });

    await expect(usecase.resumeSavedRun({ scope, runId: done.runId, decision: 'approve' })).rejects.toThrow(/not waiting for approval/);
    await expect(usecase.resumeSavedRun({ scope, runId: 'ghost', decision: 'approve' })).rejects.toThrow(/run not found/);
  });
});

// ---------------------------------------------------------------------------
// MCPサーバーのツール（Agent.mcpServers）
// ---------------------------------------------------------------------------

const mcpObjectSchema = { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] };

async function mcpServerRepo(...names: readonly (string | { readonly name: string; readonly disabled: boolean })[]): Promise<McpServerRepository> {
  const repo = new InMemoryMcpServerRepository();
  for (const entry of names) {
    const { name, disabled } = typeof entry === 'string' ? { name: entry, disabled: false } : entry;
    await repo.save(createMcpServerConfig({
      scope, name, disabled,
      transport: { kind: 'stdio', command: 'node', args: ['server.js'], env: {} },
      updatedAt: '2026-07-11T00:00:00.000Z',
    }));
  }
  return repo;
}

function mcpAgent(id: string, mcpServers: readonly string[], harness?: AgentRuntimeHarness): Agent {
  return createAgent({
    metadata: agentMeta(id), kind: 'normal', systemPrompt: 'Use MCP tools.', tools: [], mcpServers,
    ...(harness === undefined ? {} : { harness }),
  });
}

describe('RunAgentPreviewUseCase MCP tools', () => {
  it('mcpServers指定Agentはマングル名でツールを提示し、呼び出しをサーバーへルーティングして完走する', async () => {
    const agent = mcpAgent('mcp-user', ['files']);
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'a.txt' }), stop('read it')]);
    const mcpClient = new FakeMcpClient(
      { files: [{ name: 'read_file', description: 'Read a file.', inputSchema: mcpObjectSchema }] },
      { 'files/read_file': { content: 'hello world', isError: false } },
    );
    const run = await harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files'), mcpClient })
      .executeSaved({ scope, agentId: 'mcp-user', message: 'go', mode: 'preview' });

    expect(model.requests[0]?.tools).toMatchObject([{ name: 'mcp__files__read_file', description: 'Read a file.', parameters: { type: 'object', required: ['path'] } }]);
    expect(mcpClient.calls).toEqual([{ server: 'files', tool: 'read_file', args: { path: 'a.txt' } }]);
    // 結果はそのままモデルへ渡る。
    expect(toolContents(model.requests[1])[0]).toBe('hello world');
    expect(run.response).toBe('read it');
    expect(kinds(run)).toEqual(['model-request', 'tool-call', 'tool-result', 'model-request', 'model-response']);
    expect(run.trace.find((event) => event.kind === 'tool-result')).toMatchObject({ terminalId: 'mcp', outputPreview: [{ server: 'files', tool: 'read_file', isError: false }] });
    // MCPツールはETL Toolではないので tools（実行済みTool参照）へは載らない。
    expect(run.tools).toBeUndefined();
  });

  it('isError:true の結果も例外にせずtool結果としてモデルへ渡す', async () => {
    const agent = mcpAgent('mcp-error', ['files']);
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'missing.txt' }), stop('handled the error')]);
    const mcpClient = new FakeMcpClient(
      { files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] },
      { 'files/read_file': { content: 'ENOENT: no such file', isError: true } },
    );
    const run = await harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files'), mcpClient })
      .executeSaved({ scope, agentId: 'mcp-error', message: 'go', mode: 'preview' });

    expect(run.response).toBe('handled the error');
    expect(toolContents(model.requests[1])[0]).toBe('ENOENT: no such file');
    expect(run.trace.find((event) => event.kind === 'tool-result')).toMatchObject({ outputPreview: [{ isError: true }] });
  });

  it('実行時の接続失敗はRunを落とさず「利用不可」をtool結果として返す', async () => {
    const agent = mcpAgent('mcp-flaky', ['files']);
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'a.txt' }), stop('will try later')]);
    const mcpClient = new FakeMcpClient(
      { files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] },
      { 'files/read_file': new McpClientError('connection closed') },
    );
    const run = await harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files'), mcpClient })
      .executeSaved({ scope, agentId: 'mcp-flaky', message: 'go', mode: 'preview' });

    expect(run.response).toBe('will try later');
    expect(toolContents(model.requests[1])[0]).toBe("MCP server 'files' unavailable: connection closed");
  });

  it('listTools失敗・disabled・未登録のサーバーはスキップし、残りのサーバーで実行を続ける', async () => {
    const agent = mcpAgent('mcp-partial', ['files', 'broken', 'off', 'ghost']);
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'a.txt' }), stop('done')]);
    const mcpClient = new FakeMcpClient({
      files: [{ name: 'read_file', inputSchema: mcpObjectSchema }],
      broken: new McpClientError('failed to start'),
      off: [{ name: 'never', inputSchema: mcpObjectSchema }],
    });
    const run = await harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files', 'broken', { name: 'off', disabled: true }), mcpClient })
      .executeSaved({ scope, agentId: 'mcp-partial', message: 'go', mode: 'preview' });

    expect(model.requests[0]?.tools?.map((definition) => definition.name)).toEqual(['mcp__files__read_file']);
    expect(mcpClient.listed).toEqual(['files', 'broken']);
    expect(run.response).toBe('done');
  });

  it('mcpServers未指定Agentとポート未注入の実行は従来どおりMCPツールを提示しない', async () => {
    const plain = createAgent({ metadata: agentMeta('no-mcp'), kind: 'normal', systemPrompt: 'Answer.', tools: [] });
    const first = new QueueModel([stop('ok')]);
    const mcpClient = new FakeMcpClient({ files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] });
    await harnessUseCase({ agent: plain, model: first, mcpServers: await mcpServerRepo('files'), mcpClient })
      .executeSaved({ scope, agentId: 'no-mcp', message: 'go', mode: 'preview' });
    expect(first.requests[0]?.tools).toBeUndefined();
    expect(mcpClient.listed).toEqual([]);

    // mcpServers を持っていても、ポートが配線されていなければ従来動作のまま。
    const second = new QueueModel([stop('ok')]);
    await harnessUseCase({ agent: mcpAgent('mcp-unwired', ['files']), model: second })
      .executeSaved({ scope, agentId: 'mcp-unwired', message: 'go', mode: 'preview' });
    expect(second.requests[0]?.tools).toBeUndefined();
  });

  it('functionInvocation:false ではMCPツールも提示せず、サーバーへ接続もしない', async () => {
    const agent = mcpAgent('mcp-closed', ['files'], harnessOf({ functionInvocation: false }));
    const model = new QueueModel([stop('answered without tools')]);
    const mcpClient = new FakeMcpClient({ files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] });
    const run = await harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files'), mcpClient })
      .executeSaved({ scope, agentId: 'mcp-closed', message: 'go', mode: 'preview' });

    expect(run.response).toBe('answered without tools');
    expect(model.requests[0]?.tools).toBeUndefined();
    expect(mcpClient.listed).toEqual([]);
  });

  it('toolApproval:on + interactive はMCPツールで停止し、approve再開で（定義を再構築して）実行する', async () => {
    const agent = mcpAgent('mcp-approver', ['files'], harnessOf({ toolApproval: true }));
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'a.txt' }), stop('read it')]);
    const mcpClient = new FakeMcpClient(
      { files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] },
      { 'files/read_file': { content: 'hello world', isError: false } },
    );
    const usecase = harnessUseCase({ agent, model, runs, mcpServers: await mcpServerRepo('files'), mcpClient });
    const paused = await usecase.executeSaved({ scope, agentId: 'mcp-approver', message: 'go', mode: 'preview', interactive: true });

    expect(paused.status).toBe('waiting-approval');
    expect(paused.checkpoint).toMatchObject({ tool: 'mcp__files__read_file', sideEffect: 'external-action' });
    expect(paused.checkpoint?.prompt).toContain("Approval required: MCP tool 'files/read_file'");
    expect(paused.checkpoint?.prompt).toContain('"path":"a.txt"');
    expect(mcpClient.calls).toEqual([]);

    const resumed = await usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'approve' });
    expect(resumed.response).toBe('read it');
    // 再開経路でも listTools が走り、マングル名 → サーバー/ツールの対応が組み直されている。
    expect(mcpClient.listed).toEqual(['files', 'files']);
    expect(mcpClient.calls).toEqual([{ server: 'files', tool: 'read_file', args: { path: 'a.txt' } }]);
    expect(kinds(resumed)).toEqual(['model-request', 'approval-requested', 'approval-resolved', 'tool-call', 'tool-result', 'model-request', 'model-response']);
    expect(runs.records.get(paused.runId)?.status).toBe('succeeded');
  });

  it('MCPツールのrejectは拒否結果をモデルへ渡して継続する', async () => {
    const agent = mcpAgent('mcp-rejecter', ['files'], harnessOf({ toolApproval: true }));
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'a.txt' }), stop('I will not read that.')]);
    const mcpClient = new FakeMcpClient({ files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] });
    const usecase = harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files'), mcpClient });
    const paused = await usecase.executeSaved({ scope, agentId: 'mcp-rejecter', message: 'go', mode: 'preview', interactive: true });
    const resumed = await usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'reject', feedback: 'not allowed' });

    expect(resumed.response).toBe('I will not read that.');
    expect(JSON.parse(toolContents(model.requests[1])[0] as string)).toEqual({ approved: false, reason: 'not allowed' });
    expect(mcpClient.calls).toEqual([]);
  });

  it('再開時にサーバーへ再接続できないと、原因の分かるエラーでRunを失敗させる', async () => {
    const agent = mcpAgent('mcp-lost', ['files'], harnessOf({ toolApproval: true }));
    const runs = new MemoryRuns();
    const model = new QueueModel([toolCall('c1', 'mcp__files__read_file', { path: 'a.txt' }), stop('never reached')]);
    const mcpClient = new FakeMcpClient({ files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] });
    const usecase = harnessUseCase({ agent, model, runs, mcpServers: await mcpServerRepo('files'), mcpClient });
    const paused = await usecase.executeSaved({ scope, agentId: 'mcp-lost', message: 'go', mode: 'preview', interactive: true });

    mcpClient.tools.set('files', new McpClientError('server is gone'));
    await expect(usecase.resumeSavedRun({ scope, runId: paused.runId, decision: 'approve' }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/MCP tool 'mcp__files__read_file' is unavailable/) }) });
    expect(runs.records.get(paused.runId)?.status).toBe('failed');
  });

  it('MCPツールもツール呼び出しバジェットを消費する', async () => {
    const agent = mcpAgent('mcp-budget', ['files']);
    const model = new QueueModel([
      { message: { role: 'assistant', content: null, toolCalls: Array.from({ length: 3 }, (_, index) => ({ id: `c${index}`, name: 'mcp__files__read_file', arguments: { path: `${index}.txt` } })) }, finishReason: 'tool_calls' },
      stop('done'),
    ]);
    const mcpClient = new FakeMcpClient({ files: [{ name: 'read_file', inputSchema: mcpObjectSchema }] });
    // 既存ツールと同じく1件ごとにツリー共有バジェットを減算するので、3件目で枯渇して失敗する。
    await expect(harnessUseCase({ agent, model, mcpServers: await mcpServerRepo('files'), mcpClient })
      .executeSaved({ scope, agentId: 'mcp-budget', message: 'go', mode: 'preview', budget: { remainingToolCalls: 2 } }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/budget exhausted: tool calls/) }) });
    expect(mcpClient.calls).toHaveLength(2);
  });
});

/**
 * モデルの1回きりの間違い（不正JSON・引数の作り間違い）でRunを丸ごと失敗させない修復ループ。
 * 修復は「新しいモデル往復」として発行するので、上限・バジェットの消費も併せて確認する。
 */
describe('RunAgentPreviewUseCase 自動リトライ（修復ループ）', () => {
  const structuredCaps: readonly ModelCapability[] = ['chat', 'tool-calling', 'structured-output'];
  const structuredAgent = () => createAgent({
    metadata: agentMeta('structured'), kind: 'normal', systemPrompt: 'Return JSON.', tools: [],
    output: { name: 'agent_response', fields: [{ name: 'answer', type: 'string', required: true }] },
  });
  function structuredUseCase(model: ModelProviderPort, runs: RunRepository): RunAgentPreviewUseCase {
    return new RunAgentPreviewUseCase(new StaticRepository(null), new EtlEngine(createDefaultRegistry()), model, runs, () => 'run-1', undefined, new StaticAgents(structuredAgent()));
  }

  it('構造化出力が1回不正でも、エラーを添えて作り直させ2回目で完走する', async () => {
    const model = new QueueModel([stop('{}'), stop('{"answer":"ok"}')], structuredCaps);
    const runs = new MemoryRuns();
    const run = await structuredUseCase(model, runs).executeSaved({ scope, agentId: 'structured', message: 'go', mode: 'preview' });

    expect(run.structuredResponse).toEqual({ answer: 'ok' });
    expect(runs.records.get('run-1')?.status).toBe('succeeded');
    // 修復依頼には「何が悪かったか」と「期待する形」の両方が入る。
    const repairPrompt = String(model.requests[1]?.messages.at(-1)?.content);
    expect(repairPrompt).toContain("structured response is missing required field 'answer'");
    expect(repairPrompt).toContain('answer: string (required)');
    // 修復は通常のモデル往復として発行される（model-request が2件）。
    expect(run.trace.filter((event) => event.kind === 'model-request')).toHaveLength(2);
  });

  it('リトライしたことをtraceへ残す（沈黙してやり直さない）', async () => {
    const model = new QueueModel([stop('{}'), stop('{"answer":"ok"}')], structuredCaps);
    const run = await structuredUseCase(model, new MemoryRuns()).executeSaved({ scope, agentId: 'structured', message: 'go', mode: 'preview' });

    expect(run.trace.filter((event) => event.kind === 'error')).toMatchObject([
      { kind: 'error', code: 'AGENT_RUN', message: expect.stringContaining('retrying 1/1') },
    ]);
  });

  it('修復上限（既定1回）まで失敗したら従来どおりRunを失敗させる', async () => {
    const model = new QueueModel([stop('{}'), stop('{"other":1}')], structuredCaps);
    const runs = new MemoryRuns();
    await expect(structuredUseCase(model, runs).executeSaved({ scope, agentId: 'structured', message: 'go', mode: 'preview' }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/unknown field 'other'/) }) });
    // 修復は1回だけ（無限に往復しない）。
    expect(model.requests).toHaveLength(2);
    expect(runs.records.get('run-1')?.status).toBe('failed');
  });

  it('残り往復が無いときは修復せず、往復上限ではなく本来の検証エラーを見せる', async () => {
    const model = new QueueModel([stop('{}')], structuredCaps);
    await expect(structuredUseCase(model, new MemoryRuns()).executeSaved({ scope, agentId: 'structured', message: 'go', mode: 'preview', budget: { remainingModelRounds: 1 } }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/missing required field 'answer'/) }) });
    expect(model.requests).toHaveLength(1);
  });

  it('ツール引数の作り間違いはツール結果として差し戻し、呼び直しで完走する', async () => {
    const model = new QueueModel([
      toolCall('c1', 'score_lookup', { name: 'Alice' }),
      toolCall('c2', 'score_lookup', { name: 'Alice', score: 42 }),
      stop('Alice: 42'),
    ]);
    const runs = new MemoryRuns();
    const run = await new RunAgentPreviewUseCase(new StaticRepository(makeTool()), new EtlEngine(createDefaultRegistry()), model, runs, () => 'run-1').execute(input);

    expect(run.response).toBe('Alice: 42');
    expect(runs.records.get('run-1')?.status).toBe('succeeded');
    expect(run.trace.filter((event) => event.kind === 'error')).toMatchObject([
      { kind: 'error', code: 'TOOL_ARGUMENTS', message: expect.stringContaining('retrying 1/1') },
    ]);
    // 差し戻しはツール結果としてモデルへ返る。
    expect(JSON.stringify(model.requests[1]?.messages)).toContain('required argument missing: score');
  });
});

/** 中断（クライアント切断 / 中断ボタン）は「失敗」ではなく「利用者が止めた」として記録する。 */
class SignalAwareModel implements ModelProviderPort {
  private resolveStarted!: () => void;
  /** complete() に入ったことを待てるようにする（中断のタイミングをテストで固定するため）。 */
  readonly started: Promise<void> = new Promise((resolve) => { this.resolveStarted = resolve; });
  capabilities(): readonly ModelCapability[] { return ['chat', 'tool-calling']; }
  async complete(_request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    // 実プロバイダ（mastra / LM Studio）と同じく、abort で失敗する応答待ちを再現する。
    return new Promise<ModelCompletion>((_resolve, reject) => {
      if (signal?.aborted === true) { reject(new Error('model request aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('model request aborted')), { once: true });
      this.resolveStarted();
    });
  }
}

describe('RunAgentPreviewUseCase 実行の中断', () => {
  it('signalがabortされたRunは failed + RUN_CANCELLED として記録される', async () => {
    const controller = new AbortController();
    const model = new SignalAwareModel();
    const runs = new MemoryRuns();
    const pending = new RunAgentPreviewUseCase(new StaticRepository(makeTool()), new EtlEngine(createDefaultRegistry()), model, runs, () => 'run-cancel')
      .execute(input, controller.signal);

    await model.started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RunFailedError);

    const record = runs.records.get('run-cancel');
    expect(record?.status).toBe('failed');
    expect(record?.failure).toEqual({ code: 'RUN_CANCELLED', message: 'run cancelled by the user' });
    expect(record?.trace.at(-1)).toMatchObject({ kind: 'error', code: 'RUN_CANCELLED' });
  });
});
