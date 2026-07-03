import { randomUUID } from 'node:crypto';
import type { Row, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { failRun, startRun, succeedRun, type RunMode, type RunTraceEvent, type RunUsage } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import { EtlEngine, type PreviewResult } from '../etl/engine';
import type { JsonObject, ModelCompletion, ModelMessage, ModelProviderPort, ModelUsage } from '../model/model-provider';
import { AgentRunError, RunFailedError, UnsafeToolError } from './errors';
import { assertOutputMatchesSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';
import { failureFrom, sanitizeRunTrace } from './run-trace';

export type AgentRunMode = RunMode;

export interface RunAgentPreviewInput {
  readonly scope: TenantScope;
  readonly toolId: ToolId;
  readonly version?: SemVer;
  readonly systemPrompt: string;
  readonly message: string;
  readonly mode: AgentRunMode;
}

export interface AgentPreviewRun {
  readonly runId: string;
  readonly mode: AgentRunMode;
  readonly tool: { readonly internalId: string; readonly publishName: string; readonly version: string };
  readonly response: string;
  readonly trace: readonly RunTraceEvent[];
  readonly usage: RunUsage;
}

function mergeUsage(...completions: readonly ModelCompletion[]): ModelUsage {
  const sum = (select: (usage: ModelUsage) => number | undefined): number | undefined => {
    const values = completions.map((completion) => completion.usage).filter((usage): usage is ModelUsage => usage !== undefined).map(select).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  return {
    ...(sum((usage) => usage.promptTokens) !== undefined ? { promptTokens: sum((usage) => usage.promptTokens) } : {}),
    ...(sum((usage) => usage.completionTokens) !== undefined ? { completionTokens: sum((usage) => usage.completionTokens) } : {}),
    ...(sum((usage) => usage.totalTokens) !== undefined ? { totalTokens: sum((usage) => usage.totalTokens) } : {}),
  };
}

function graphWithArguments(tool: Tool, row: Row): ToolGraph {
  let replaced = 0;
  const nodes = tool.graph.nodes.map((node) => {
    if (node.type !== 'agent-input') return node;
    replaced += 1;
    const config = node.config as { schema?: Schema };
    if (!schemasEqual(tool.inputSchema, config.schema)) {
      throw new AgentRunError(`tool inputSchema does not match agent-input node '${node.id}'`);
    }
    return { ...node, config: { ...config, sample: row } };
  });
  if ((tool.inputSchema?.columns.length ?? 0) > 0 && replaced === 0) {
    throw new AgentRunError('tool declares inputSchema but has no agent-input node');
  }
  return { nodes, edges: tool.graph.edges };
}

export class RunAgentPreviewUseCase {
  constructor(
    private readonly repo: ToolRepository,
    private readonly engine: EtlEngine,
    private readonly model: ModelProviderPort,
    private readonly runRepo: RunRepository,
    private readonly makeRunId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: RunAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    const runId = this.makeRunId();
    const started = startRun({
      runId, scope: input.scope, mode: input.mode,
      tool: { internalId: input.toolId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) },
      startedAt: this.now().toISOString(),
    });
    await this.runRepo.save(started);
    const trace: RunTraceEvent[] = [];
    try {
      const result = await this.perform(input, trace, signal);
      await this.runRepo.save(succeedRun(started, {
        tool: result.tool, response: result.response, trace: sanitizeRunTrace(trace), usage: result.usage, completedAt: this.now().toISOString(),
      }));
      return { runId, mode: input.mode, ...result, trace };
    } catch (error) {
      const failure = failureFrom(error);
      trace.push({ sequence: trace.length + 1, kind: 'error', code: failure.code, message: failure.message });
      await this.runRepo.save(failRun(started, { trace: sanitizeRunTrace(trace), failure, completedAt: this.now().toISOString() }));
      throw new RunFailedError(runId, error);
    }
  }

  private async perform(input: RunAgentPreviewInput, trace: RunTraceEvent[], signal?: AbortSignal): Promise<Omit<AgentPreviewRun, 'runId' | 'mode' | 'trace'>> {
    const tool = await this.loadTool(input.scope, input.toolId, input.version);
    if (tool.sideEffect !== 'read-only') {
      throw new UnsafeToolError(`Agent preview refuses ${tool.sideEffect} tool '${tool.metadata.internalId}'`);
    }
    if (!this.model.capabilities().includes('tool-calling')) {
      throw new AgentRunError('configured model provider does not support tool-calling');
    }

    const definition = toolToModelDefinition(tool);
    const messages: ModelMessage[] = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.message },
    ];
    trace.push({ sequence: 1, kind: 'model-request', step: 1, toolNames: [definition.name] });
    const first = await this.model.complete({ messages, tools: [definition] }, signal);
    const calls = first.message.toolCalls ?? [];
    if (first.finishReason === 'tool_calls' && calls.length === 0) {
      throw new AgentRunError('model reported tool_calls without a tool call');
    }
    if (calls.length === 0) {
      const content = first.message.content ?? '';
      trace.push({ sequence: 2, kind: 'model-response', content });
      return { tool: this.toolRef(tool), response: content, usage: mergeUsage(first) };
    }
    if (calls.length !== 1) throw new AgentRunError(`expected one tool call, received ${calls.length}`);
    const call = calls[0];
    if (call === undefined || call.name !== definition.name) {
      throw new AgentRunError(`model requested unknown tool: ${call?.name ?? '(missing)'}`);
    }

    trace.push({ sequence: 2, kind: 'tool-call', name: call.name, arguments: call.arguments });
    const args = validateToolArguments(tool.inputSchema, call.arguments);
    const graph = graphWithArguments(tool, args);
    const preview = this.engine.preview(graph, { rowLimit: 100 });
    assertOutputMatchesSchema(preview.output, tool.outputSchema);
    trace.push({
      sequence: 3, kind: 'tool-result', name: call.name, terminalId: preview.terminalId,
      nodes: Object.values(preview.nodes).map((node) => ({ nodeId: node.nodeId, rowCount: node.table.rows.length, truncated: node.truncated })),
      outputPreview: preview.output.rows.slice(0, 10).map((row) => ({ ...row })),
    });

    const assistantMessage: ModelMessage = {
      role: 'assistant',
      content: first.message.content,
      toolCalls: [call],
    };
    const toolMessage: ModelMessage = {
      role: 'tool',
      content: JSON.stringify({ schema: preview.output.schema, rows: preview.output.rows }),
      toolCallId: call.id,
    };
    trace.push({ sequence: 4, kind: 'model-request', step: 2, toolNames: [] });
    const second = await this.model.complete({ messages: [...messages, assistantMessage, toolMessage] }, signal);
    if ((second.message.toolCalls?.length ?? 0) > 0) {
      throw new AgentRunError('model requested an additional tool call after the v6 limit');
    }
    const content = second.message.content ?? '';
    trace.push({ sequence: 5, kind: 'model-response', content });
    return { tool: this.toolRef(tool), response: content, usage: mergeUsage(first, second) };
  }

  private toolRef(tool: Tool): AgentPreviewRun['tool'] {
    return { internalId: tool.metadata.internalId, publishName: tool.metadata.publishName, version: tool.metadata.version.toString() };
  }

  private async loadTool(scope: TenantScope, toolId: ToolId, version?: SemVer): Promise<Tool> {
    const tool = version === undefined
      ? await this.repo.findLatest(scope, toolId)
      : await this.repo.findVersion(scope, toolId, version);
    if (tool === null) throw new ToolNotFoundError(`RunAgentPreview: tool not found: ${toolId}${version === undefined ? '' : `@${version.toString()}`}`);
    return tool;
  }
}
