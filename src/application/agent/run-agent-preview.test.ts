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
import { queryWorkspaceTable, RunAgentPreviewUseCase } from './run-agent-preview';
import { FakeWikiRepository } from '../memory/memory-repositories.fixtures';
import { createWikiSpace } from '../../domain/memory/wiki-space';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { InMemoryAgentSessionRepository } from '../../adapters/storage/in-memory-agent-session-repository';
import { InMemorySessionArtifactRepository } from '../../adapters/storage/in-memory-session-artifact-repository';

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
