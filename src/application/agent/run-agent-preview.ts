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
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { EtlEngine } from '../etl/engine';
import type { ModelCompletion, ModelMessage, ModelProviderPort, ModelToolCall, ModelToolDefinition, ModelUsage } from '../model/model-provider';
import { AgentRunError, RunFailedError, UnsafeToolError } from './errors';
import { failureFrom, sanitizeRunTrace } from './run-trace';
import { assertOutputMatchesSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';
import { toModelResponseFormat, validateStructuredResponse } from './structured-output';
import { HARD_MAX_DEPTH, composeAgentSystemPrompt, resolveAgentCapabilities, resolveEffectiveSideEffect, type ResolvedSubAgent } from './resolve-agent-capabilities';

export type AgentRunMode = RunMode;

export interface RunAgentPreviewInput {
  readonly scope: TenantScope;
  readonly toolId: ToolId;
  readonly version?: SemVer;
  readonly systemPrompt: string;
  readonly message: string;
  readonly mode: AgentRunMode;
}

/** 直前までの会話履歴（system直後へ注入される。v16: シナリオ検証の複数ターン会話用）。 */
export interface AgentHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface RunSavedAgentPreviewInput {
  readonly scope: TenantScope;
  readonly agentId: string;
  readonly version?: SemVer;
  readonly message: string;
  readonly mode: AgentRunMode;
  readonly history?: readonly AgentHistoryMessage[];
  /** サブエージェント委譲のツリー共有バジェット（既定値で補完・上限超は既定へクランプ）。 */
  readonly budget?: Partial<RunBudget>;
}

/** サブエージェント委譲のツリー共有バジェット。remaining系は実行中に減算される。 */
export interface RunBudget {
  maxDelegationDepth: number;   // 既定2・絶対上限 HARD_MAX_DEPTH(3)
  remainingModelRounds: number; // ツリー共有・既定12
  remainingToolCalls: number;   // ツリー共有・既定16
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
export const DEFAULT_MAX_DELEGATION_DEPTH = 2;
export const DEFAULT_MODEL_ROUNDS_BUDGET = 12;
export const DEFAULT_TOOL_CALLS_BUDGET = 16;

/** バジェットを既定値で補完し、上限超の値は既定（深さは HARD_MAX_DEPTH）へクランプする。 */
function makeBudget(partial?: Partial<RunBudget>): RunBudget {
  return {
    maxDelegationDepth: Math.min(partial?.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH, HARD_MAX_DEPTH),
    remainingModelRounds: Math.min(partial?.remainingModelRounds ?? DEFAULT_MODEL_ROUNDS_BUDGET, DEFAULT_MODEL_ROUNDS_BUDGET),
    remainingToolCalls: Math.min(partial?.remainingToolCalls ?? DEFAULT_TOOL_CALLS_BUDGET, DEFAULT_TOOL_CALLS_BUDGET),
  };
}

/** 1ノード（1エージェント実行）の委譲コンテキスト。budget はツリーで共有する同一参照。 */
interface NodeContext {
  readonly scope: TenantScope;
  readonly mode: AgentRunMode;
  readonly budget: RunBudget;
  readonly depth: number;
  readonly subAgents: readonly ResolvedSubAgent[];
}

function subAgentToolDefinition(sub: ResolvedSubAgent): ModelToolDefinition {
  return {
    name: sub.toolName,
    description: `${sub.ref.usage}\n(delegates to agent: ${sub.agent.metadata.displayName}@${sub.agent.metadata.version.toString()})`,
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Instruction or question to delegate to the sub-agent.' } },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

function summarize(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

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
    private readonly skills?: SkillRepository,
  ) {}

  async execute(input: RunAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    return this.executeRun(
      input.scope,
      input.mode,
      { tool: { internalId: input.toolId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) } },
      async (trace) => {
        const tool = await this.loadTool(input.scope, input.toolId, input.version);
        const ctx: NodeContext = { scope: input.scope, mode: input.mode, budget: makeBudget(), depth: 0, subAgents: [] };
        const result = await this.perform(input.systemPrompt, input.message, [tool], trace, ctx, signal);
        return result.tool === undefined ? { ...result, tool: this.toolRef(tool) } : result;
      },
    );
  }

  async executeSaved(input: RunSavedAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    const agentRepo = this.agents;
    if (agentRepo === undefined) throw new AgentRunError('saved Agent execution is not configured');
    const budget = makeBudget(input.budget);
    return this.executeRun(
      input.scope,
      input.mode,
      { agent: { internalId: input.agentId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) } },
      async (trace) => {
        const agent = await this.loadAgent(input.scope, input.agentId, input.version);
        // 実効副作用（自Tool + 全サブの推移的最大）が read-only でなければ実行前に拒否する。
        const effect = await resolveEffectiveSideEffect(input.scope, agent, { tools: this.repo, agents: agentRepo, skills: this.skills });
        if (effect !== 'read-only') {
          throw new UnsafeToolError(`Agent preview refuses ${effect} effective side-effect for agent '${agent.metadata.internalId}'`);
        }
        const resolved = await resolveAgentCapabilities(input.scope, agent.skills, agent.tools, this.repo, this.skills, agent.agents, agentRepo);
        const ctx: NodeContext = { scope: input.scope, mode: input.mode, budget, depth: 0, subAgents: resolved.subAgents };
        return this.perform(composeAgentSystemPrompt(agent.systemPrompt, resolved.skills), input.message, resolved.tools, trace, ctx, signal, this.agentRef(agent), agent.output, input.history);
      },
    );
  }

  /** サブエージェントを子Runとして入れ子実行する（ツリー共有 budget・depth+1・history なし）。 */
  private async runChildAgent(scope: TenantScope, agent: Agent, message: string, mode: AgentRunMode, budget: RunBudget, depth: number, signal?: AbortSignal): Promise<AgentPreviewRun> {
    return this.executeRun(scope, mode, { agent: this.agentRef(agent) }, async (trace) => {
      const resolved = await resolveAgentCapabilities(scope, agent.skills, agent.tools, this.repo, this.skills, agent.agents, this.agents);
      const ctx: NodeContext = { scope, mode, budget, depth, subAgents: resolved.subAgents };
      return this.perform(composeAgentSystemPrompt(agent.systemPrompt, resolved.skills), message, resolved.tools, trace, ctx, signal, this.agentRef(agent), agent.output);
    });
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
    ctx: NodeContext,
    signal?: AbortSignal,
    agent?: RunRecord['agent'],
    output?: StructuredOutputDefinition,
    history?: readonly AgentHistoryMessage[],
  ): Promise<RunResult> {
    for (const tool of tools) {
      if (tool.sideEffect !== 'read-only') {
        throw new UnsafeToolError(`Agent preview refuses ${tool.sideEffect} tool '${tool.metadata.internalId}'`);
      }
    }
    const hasCallables = tools.length > 0 || ctx.subAgents.length > 0;
    if (hasCallables && !this.model.capabilities().includes('tool-calling')) {
      throw new AgentRunError('configured model provider does not support tool-calling');
    }
    if (output !== undefined && !this.model.capabilities().includes('structured-output')) {
      throw new AgentRunError('configured model provider does not support structured output');
    }

    const toolDefinitions = tools.map(toolToModelDefinition);
    const definitions = [...toolDefinitions, ...ctx.subAgents.map(subAgentToolDefinition)];
    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
      // v16: 会話履歴（シナリオ検証の複数ターン）を system 直後へ注入する（後方互換: 省略時は従来どおり）。
      ...(history ?? []).map((entry): ModelMessage => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userMessage },
    ];
    const completions: ModelCompletion[] = [];
    const executed: NonNullable<RunRecord['tool']>[] = [];
    const responseFormat = output === undefined ? undefined : toModelResponseFormat(output);

    for (let step = 1; step <= MAX_MODEL_ROUNDS; step += 1) {
      // ツリー共有バジェット: model round 発行前に減算し、枯渇でこのノードのRunを失敗させる。
      if ((ctx.budget.remainingModelRounds -= 1) < 0) {
        throw new AgentRunError('run budget exhausted: model rounds');
      }
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
        // ツール呼び出し（委譲含む）発行前に共有バジェットを減算する。
        if ((ctx.budget.remainingToolCalls -= 1) < 0) {
          throw new AgentRunError('run budget exhausted: tool calls');
        }
        const sub = ctx.subAgents.find((candidate) => candidate.toolName === call.name);
        if (sub !== undefined) {
          messages.push(await this.delegate(sub, call, trace, ctx, signal));
          continue;
        }
        const selectedIndex = toolDefinitions.findIndex((definition) => definition.name === call.name);
        const tool = selectedIndex < 0 ? undefined : tools[selectedIndex];
        if (tool === undefined) throw new AgentRunError(`model requested unknown tool: ${call.name}`);
        messages.push(this.executeTool(tool, call, trace));
        executed.push(this.toolRef(tool));
      }
    }
    throw new AgentRunError(`model round limit exceeded: maximum ${MAX_MODEL_ROUNDS}`);
  }

  /** サブエージェント委譲。子Runを入れ子実行し、親トレースへ agent_call を記録してツール結果を返す。 */
  private async delegate(sub: ResolvedSubAgent, call: ModelToolCall, trace: RunTraceEvent[], ctx: NodeContext, signal?: AbortSignal): Promise<ModelMessage> {
    trace.push({ sequence: trace.length + 1, kind: 'tool-call', name: call.name, arguments: call.arguments });
    const agentRef = { internalId: sub.agent.metadata.internalId, version: sub.agent.metadata.version.toString() };
    const record = (childRunId: string, ok: boolean, summary: string): ModelMessage => {
      trace.push({ sequence: trace.length + 1, kind: 'agent_call', toolName: sub.toolName, agentRef, childRunId, ok, summary });
      return { role: 'tool', content: summary, toolCallId: call.id };
    };

    const message = call.arguments['message'];
    if (typeof message !== 'string' || message.trim() === '') {
      return record('', false, "[delegation failed: 'message' must be a non-empty string]");
    }
    if (ctx.depth >= ctx.budget.maxDelegationDepth) {
      return record('', false, `[delegation failed: max delegation depth ${ctx.budget.maxDelegationDepth} reached]`);
    }
    try {
      const child = await this.runChildAgent(ctx.scope, sub.agent, message, ctx.mode, ctx.budget, ctx.depth + 1, signal);
      const content = child.structuredResponse !== undefined ? JSON.stringify(child.structuredResponse) : child.response;
      trace.push({ sequence: trace.length + 1, kind: 'agent_call', toolName: sub.toolName, agentRef, childRunId: child.runId, ok: true, summary: summarize(content) });
      return { role: 'tool', content, toolCallId: call.id };
    } catch (error) {
      const childRunId = error instanceof RunFailedError ? error.runId : '';
      const detail = error instanceof Error ? error.message : 'delegation failed';
      return record(childRunId, false, `[delegation failed: ${detail}]`);
    }
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
