import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import type { Row, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { RunMode, RunRecord, RunTraceEvent, RunUsage } from '../../domain/run/run';
import { failRun, startRun, succeedRun } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { EtlEngine } from '../etl/engine';
import type { ModelCompletion, ModelMessage, ModelProviderPort, ModelToolCall, ModelUsage } from '../model/model-provider';
import { AgentRunError, RunFailedError, UnsafeToolError } from './errors';
import { failureFrom, sanitizeRunTrace } from './run-trace';
import { assertOutputMatchesSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';
import { toModelResponseFormat, validateStructuredResponse } from './structured-output';

export type AgentRunMode = RunMode;

export interface RunAgentPreviewInput {
  readonly scope: TenantScope;
  readonly toolId: ToolId;
  readonly version?: SemVer;
  readonly systemPrompt: string;
  readonly message: string;
  readonly mode: AgentRunMode;
}

export interface RunSavedAgentPreviewInput {
  readonly scope: TenantScope;
  readonly agentId: string;
  readonly version?: SemVer;
  readonly message: string;
  readonly mode: AgentRunMode;
}

export interface AgentPreviewRun {
  readonly runId: string;
  readonly mode: AgentRunMode;
  readonly agent?: RunRecord['agent'];
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly response: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEvent[];
  readonly usage: RunUsage;
}

type RunResult = Omit<AgentPreviewRun, 'runId' | 'mode' | 'trace'>;

export const MAX_TOOL_CALLS = 4;
export const MAX_MODEL_ROUNDS = 5;

function mergeUsage(...completions: readonly ModelCompletion[]): ModelUsage {
  const sum = (select: (usage: ModelUsage) => number | undefined): number | undefined => {
    const values = completions.map((completion) => completion.usage)
      .filter((usage): usage is ModelUsage => usage !== undefined)
      .map(select).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  const promptTokens = sum((usage) => usage.promptTokens);
  const completionTokens = sum((usage) => usage.completionTokens);
  const totalTokens = sum((usage) => usage.totalTokens);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
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
    private readonly agents?: AgentRepository,
  ) {}

  async execute(input: RunAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    return this.executeRun(
      input.scope,
      input.mode,
      { tool: { internalId: input.toolId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) } },
      async (trace) => {
        const tool = await this.loadTool(input.scope, input.toolId, input.version);
        const result = await this.perform(input.systemPrompt, input.message, [tool], trace, signal);
        return result.tool === undefined ? { ...result, tool: this.toolRef(tool) } : result;
      },
    );
  }

  async executeSaved(input: RunSavedAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    return this.executeRun(
      input.scope,
      input.mode,
      { agent: { internalId: input.agentId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) } },
      async (trace) => {
        const agent = await this.loadAgent(input.scope, input.agentId, input.version);
        const tools: Tool[] = [];
        for (const ref of agent.tools) tools.push(await this.loadTool(input.scope, ref.internalId, ref.version));
        return this.perform(agent.systemPrompt, input.message, tools, trace, signal, this.agentRef(agent), agent.output);
      },
    );
  }

  private async executeRun(
    scope: TenantScope,
    mode: AgentRunMode,
    refs: Pick<RunRecord, 'tool' | 'agent'>,
    work: (trace: RunTraceEvent[]) => Promise<RunResult>,
  ): Promise<AgentPreviewRun> {
    const runId = this.makeRunId();
    const started = startRun({ runId, scope, mode, ...refs, startedAt: this.now().toISOString() });
    await this.runRepo.save(started);
    const trace: RunTraceEvent[] = [];
    try {
      const result = await work(trace);
      await this.runRepo.save(succeedRun(started, {
        ...(result.tool !== undefined ? { tool: result.tool } : {}),
        ...(result.tools !== undefined ? { tools: result.tools } : {}),
        ...(result.agent !== undefined ? { agent: result.agent } : {}),
        response: result.response,
        ...(result.structuredResponse !== undefined ? { structuredResponse: result.structuredResponse } : {}),
        trace: sanitizeRunTrace(trace),
        usage: result.usage,
        completedAt: this.now().toISOString(),
      }));
      return { runId, mode, ...result, trace };
    } catch (error) {
      const failure = failureFrom(error);
      trace.push({ sequence: trace.length + 1, kind: 'error', code: failure.code, message: failure.message });
      await this.runRepo.save(failRun(started, { trace: sanitizeRunTrace(trace), failure, completedAt: this.now().toISOString() }));
      throw new RunFailedError(runId, error);
    }
  }

  private async perform(
    systemPrompt: string,
    userMessage: string,
    tools: readonly Tool[],
    trace: RunTraceEvent[],
    signal?: AbortSignal,
    agent?: RunRecord['agent'],
    output?: StructuredOutputDefinition,
  ): Promise<RunResult> {
    for (const tool of tools) {
      if (tool.sideEffect !== 'read-only') {
        throw new UnsafeToolError(`Agent preview refuses ${tool.sideEffect} tool '${tool.metadata.internalId}'`);
      }
    }
    if (tools.length > 0 && !this.model.capabilities().includes('tool-calling')) {
      throw new AgentRunError('configured model provider does not support tool-calling');
    }
    if (output !== undefined && !this.model.capabilities().includes('structured-output')) {
      throw new AgentRunError('configured model provider does not support structured output');
    }

    const definitions = tools.map(toolToModelDefinition);
    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    const completions: ModelCompletion[] = [];
    const executed: NonNullable<RunRecord['tool']>[] = [];
    const responseFormat = output === undefined ? undefined : toModelResponseFormat(output);

    for (let step = 1; step <= MAX_MODEL_ROUNDS; step += 1) {
      trace.push({ sequence: trace.length + 1, kind: 'model-request', step, toolNames: definitions.map((definition) => definition.name) });
      const completion = await this.model.complete({
        messages,
        ...(definitions.length > 0 ? { tools: definitions } : {}),
        ...(responseFormat !== undefined ? { responseFormat } : {}),
      }, signal);
      completions.push(completion);
      const calls = completion.message.toolCalls ?? [];
      if (completion.finishReason === 'tool_calls' && calls.length === 0) {
        throw new AgentRunError('model reported tool_calls without a tool call');
      }
      if (calls.length === 0) {
        const content = completion.message.content ?? '';
        const structuredResponse = output === undefined ? undefined : validateStructuredResponse(output, content);
        trace.push({ sequence: trace.length + 1, kind: 'model-response', content });
        const last = executed.at(-1);
        return {
          ...(agent !== undefined ? { agent } : {}),
          ...(last !== undefined ? { tool: last, tools: executed } : {}),
          response: content,
          ...(structuredResponse !== undefined ? { structuredResponse } : {}),
          usage: mergeUsage(...completions),
        };
      }
      if (executed.length + calls.length > MAX_TOOL_CALLS) {
        throw new AgentRunError(`tool call limit exceeded: maximum ${MAX_TOOL_CALLS}`);
      }

      messages.push({ role: 'assistant', content: completion.message.content, toolCalls: calls });
      for (const call of calls) {
        const selectedIndex = definitions.findIndex((definition) => definition.name === call.name);
        const tool = selectedIndex < 0 ? undefined : tools[selectedIndex];
        if (tool === undefined) throw new AgentRunError(`model requested unknown tool: ${call.name}`);
        messages.push(this.executeTool(tool, call, trace));
        executed.push(this.toolRef(tool));
      }
    }
    throw new AgentRunError(`model round limit exceeded: maximum ${MAX_MODEL_ROUNDS}`);
  }

  private executeTool(tool: Tool, call: ModelToolCall, trace: RunTraceEvent[]): ModelMessage {
    trace.push({ sequence: trace.length + 1, kind: 'tool-call', name: call.name, arguments: call.arguments });
    const args = validateToolArguments(tool.inputSchema, call.arguments);
    const preview = this.engine.preview(graphWithArguments(tool, args), { rowLimit: 100 });
    assertOutputMatchesSchema(preview.output, tool.outputSchema);
    trace.push({
      sequence: trace.length + 1,
      kind: 'tool-result',
      name: call.name,
      terminalId: preview.terminalId,
      nodes: Object.values(preview.nodes).map((node) => ({ nodeId: node.nodeId, rowCount: node.table.rows.length, truncated: node.truncated })),
      outputPreview: preview.output.rows.slice(0, 10).map((row) => ({ ...row })),
    });
    return {
      role: 'tool',
      content: JSON.stringify({ schema: preview.output.schema, rows: preview.output.rows }),
      toolCallId: call.id,
    };
  }

  private toolRef(tool: Tool): NonNullable<RunRecord['tool']> {
    return { internalId: tool.metadata.internalId, publishName: tool.metadata.publishName, version: tool.metadata.version.toString() };
  }

  private agentRef(agent: Agent): NonNullable<RunRecord['agent']> {
    return { internalId: agent.metadata.internalId, publishName: agent.metadata.publishName, version: agent.metadata.version.toString() };
  }

  private async loadTool(scope: TenantScope, toolId: ToolId, version?: SemVer): Promise<Tool> {
    const tool = version === undefined ? await this.repo.findLatest(scope, toolId) : await this.repo.findVersion(scope, toolId, version);
    if (tool === null) throw new ToolNotFoundError(`RunAgentPreview: tool not found: ${toolId}${version === undefined ? '' : `@${version.toString()}`}`);
    return tool;
  }

  private async loadAgent(scope: TenantScope, agentId: string, version?: SemVer): Promise<Agent> {
    if (this.agents === undefined) throw new AgentRunError('saved Agent execution is not configured');
    const agent = version === undefined ? await this.agents.findLatest(scope, agentId) : await this.agents.findVersion(scope, agentId, version);
    if (agent === null) throw new AgentNotFoundError(`RunAgentPreview: agent not found: ${agentId}${version === undefined ? '' : `@${version.toString()}`}`);
    return agent;
  }
}
