import { describe, expect, it } from 'vitest';
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
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
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
    expect(model.requests[1]?.tools).toBeUndefined();
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

  it('unknown/multiple/additional tool callとcapability不足を拒否する', async () => {
    const unknown = new QueueModel([{ message: { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'other', arguments: {} }] }, finishReason: 'tool_calls' }]);
    await expect(useCase(makeTool(), unknown).execute(input)).rejects.toMatchObject({ cause: expect.any(AgentRunError) });
    const multiple = new QueueModel([{ message: { role: 'assistant', content: null, toolCalls: [
      { id: 'x', name: 'score_lookup', arguments: {} }, { id: 'y', name: 'score_lookup', arguments: {} },
    ] }, finishReason: 'tool_calls' }]);
    await expect(useCase(makeTool(), multiple).execute(input)).rejects.toThrow(/expected one/);
    const noCapability = new QueueModel([], ['chat']);
    await expect(useCase(makeTool(), noCapability).execute(input)).rejects.toThrow(/does not support/);
  });
});
