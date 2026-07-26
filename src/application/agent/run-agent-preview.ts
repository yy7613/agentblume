import { randomUUID } from 'node:crypto';
import type { Agent, AgentSubAgentRef } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import type { Row, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { RunLatencyBreakdown, RunMode, RunModelSnapshot, RunPurpose, RunRecord, RunTraceEvent, RunUsage } from '../../domain/run/run';
import { failRun, startRun, succeedRun } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { EtlEngine } from '../etl/engine';
import type { ModelCompletion, ModelContentPart, ModelMessage, ModelProviderPort, ModelRequestMessage, ModelToolCall, ModelToolDefinition, ModelUsage } from '../model/model-provider';
import { AgentRunError, RunFailedError, UnsafeToolError } from './errors';
import { failureFrom, sanitizeRunTrace } from './run-trace';
import { assertOutputMatchesSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';
import { toModelResponseFormat, validateStructuredResponse } from './structured-output';
import { HARD_MAX_DEPTH, composeAgentSystemPrompt, resolveAgentCapabilities, resolveEffectiveSideEffect, type ResolvedSubAgent } from './resolve-agent-capabilities';
import type { TelemetryPort } from '../operations/telemetry';
import { safeStartSpan } from '../operations/telemetry';
import type { PricingPort } from '../operations/pricing';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { estimateRunCost, recordRunMetricSafely } from '../operations/run-observability';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { effectiveWikiId, type WikiPage } from '../../domain/memory/wiki-page';
import { createAgentSession, expireAgentSession, type AgentSession } from '../../domain/session/agent-session';
import { AgentSessionClosedError, AgentSessionExpiredError, AgentSessionNotFoundError } from '../../domain/session/errors';
import type { AgentSessionRepository, SessionArtifactRepository } from '../../domain/session/session-repository';
import { ToolOutputDispatcher } from '../tool/tool-output-dispatcher';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';

export type AgentRunMode = RunMode;

export interface RunAgentPreviewInput {
  readonly scope: TenantScope;
  readonly toolId: ToolId;
  readonly version?: SemVer;
  readonly systemPrompt: string;
  readonly message: string;
  readonly mode: AgentRunMode;
  readonly purpose?: RunPurpose;
  readonly sessionId?: string;
  readonly images?: readonly ImageAttachment[];
}

/** チャットから渡す画像。data URLだけを許可し、外部URLの取得は行わない。 */
export interface ImageAttachment {
  readonly name: string;
  readonly dataUrl: string;
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
  readonly purpose?: RunPurpose;
  readonly sessionId?: string;
  readonly history?: readonly AgentHistoryMessage[];
  /** 呼び出し元がこのRunだけへ追加する、version固定の委譲先。HarnessのCoordinatorで使用する。 */
  readonly additionalAgents?: readonly AgentSubAgentRef[];
  readonly images?: readonly ImageAttachment[];
  /** サブエージェント委譲のツリー共有バジェット（既定値で補完・上限超は既定へクランプ）。 */
  readonly budget?: Partial<RunBudget>;
  /** 手動アタッチした長期記憶（Wiki）の要約。指定時のみ system prompt 先頭へ最小注入する（v21 M1）。 */
  readonly memoryContext?: string;
  /** API互換の手動ページ指定。Wiki allowlist設定Agentではallowlist内だけ許可する。 */
  readonly memoryPageIds?: readonly string[];
}

/** サブエージェント委譲のツリー共有バジェット。remaining系は実行中に減算される。 */
export interface RunBudget {
  maxDelegationDepth: number;   // 既定2・絶対上限 HARD_MAX_DEPTH(3)
  remainingModelRounds: number; // ツリー共有・既定12
  remainingToolCalls: number;   // ツリー共有・既定16
}

export interface AgentPreviewRun {
  readonly runId: string;
  readonly sessionId?: string;
  readonly mode: AgentRunMode;
  readonly agent?: RunRecord['agent'];
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly response: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEvent[];
  readonly usage: RunUsage;
  readonly purpose?: RunPurpose;
  readonly model?: RunModelSnapshot;
  readonly latency?: RunLatencyBreakdown;
  readonly estimatedCost?: RunRecord['estimatedCost'];
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
  readonly runId: string;
  readonly scope: TenantScope;
  readonly mode: AgentRunMode;
  readonly budget: RunBudget;
  readonly depth: number;
  readonly subAgents: readonly ResolvedSubAgent[];
  readonly session?: AgentSession;
}

interface RunTiming { modelMs: number; toolMs: number }

export interface RunObservabilityOptions {
  readonly telemetry?: TelemetryPort;
  readonly pricing?: PricingPort;
  readonly operations?: OperationsRepository;
  readonly model?: RunModelSnapshot;
  readonly monotonicNow?: () => number;
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

/** 手動アタッチした記憶を system prompt 先頭へ最小注入する（字数制限つき・空/未指定は素通し）。 */
function withMemoryContext(systemPrompt: string, memoryContext?: string): string {
  const trimmed = memoryContext?.trim() ?? '';
  if (trimmed.length === 0) return systemPrompt;
  return `# Memory (retrieved knowledge; use if relevant)\n${summarize(trimmed, 1200)}\n\n${systemPrompt}`;
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

/**
 * ツールのグラフが、セッションへ成果物を書き込む終端（workspace-output / graph-output /
 * chart-output、または agent-output の overflow=store-and-reference）を持つかどうか。
 * Agent実行時の preview rowLimit 拡張と workspace_* ツール公開可否の判定で共用する。
 */
function hasSessionStorageSink(tool: Tool): boolean {
  return tool.graph.nodes.some((node) =>
    node.type === 'workspace-output' || node.type === 'graph-output' || node.type === 'chart-output'
    || (node.type === 'agent-output' && (node.config as { overflow?: unknown }).overflow === 'store-and-reference'));
}

/**
 * filter の1条件について `valueBinding: { source:'agent-input', field }` を実引数へ解決する。
 * バインディングが無ければ同一参照をそのまま返す（差し替えの有無を呼び出し側が判定できる）。
 *
 * `optionalFields`（inputSchema で nullable な引数名）に含まれる引数が省略された／null のときは
 * value を触らず `disabled: true` を注入し、その条件を実行時にスキップさせる（「全リージョン」の
 * ように絞り込み自体が不要なケース）。nullable でない引数は従来どおり欠損をエラーにする。
 */
function conditionWithArgument(nodeId: string, condition: unknown, row: Row, optionalFields: ReadonlySet<string>): unknown {
  const binding = (condition as { valueBinding?: { source?: unknown; field?: unknown } } | null)?.valueBinding;
  if (binding?.source !== 'agent-input') return condition;
  const field = typeof binding.field === 'string' ? binding.field : '';
  // 引数が渡されていれば Cell、宣言と噛み合っていなければ undefined。
  const argument = Object.prototype.hasOwnProperty.call(row, field) ? row[field] ?? null : undefined;
  if (optionalFields.has(field) && (argument === undefined || argument === null)) {
    return { ...(condition as Record<string, unknown>), disabled: true };
  }
  if (argument === undefined) {
    throw new AgentRunError(`filter node '${nodeId}' references an unavailable Agent input`);
  }
  return { ...(condition as Record<string, unknown>), value: argument };
}

/**
 * filter config の agent-input バインディングを実行時引数で解決する。旧形式（フラットな1条件）と
 * 新形式（`{ conditions, combine }`）の両方を扱い、元の形式を保ったまま value だけを差し替える。
 */
function filterConfigWithArguments(nodeId: string, config: unknown, row: Row, optionalFields: ReadonlySet<string>): unknown {
  const conditions = (config as { conditions?: unknown } | null)?.conditions;
  if (!Array.isArray(conditions)) return conditionWithArgument(nodeId, config, row, optionalFields);
  const bound = conditions.map((condition) => conditionWithArgument(nodeId, condition, row, optionalFields));
  if (bound.every((condition, index) => condition === conditions[index])) return config;
  return { ...(config as Record<string, unknown>), conditions: bound };
}

function graphWithArguments(tool: Tool, row: Row): ToolGraph {
  // nullable 宣言された引数だけが「省略 → 条件スキップ」の対象になる。
  const optionalFields = new Set((tool.inputSchema?.columns ?? []).filter((column) => column.nullable).map((column) => column.name));
  let replaced = 0;
  const nodes = tool.graph.nodes.map((node) => {
    if (node.type === 'agent-input') {
      replaced += 1;
      const config = node.config as { schema?: Schema };
      if (!schemasEqual(tool.inputSchema, config.schema)) {
        throw new AgentRunError(`tool inputSchema does not match agent-input node '${node.id}'`);
      }
      return { ...node, config: { ...config, sample: row } };
    }
    if (node.type !== 'filter') return node;
    const config = filterConfigWithArguments(node.id, node.config, row, optionalFields);
    return config === node.config ? node : { ...node, config };
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
    private readonly observability?: RunObservabilityOptions,
    private readonly wiki?: WikiRepository,
    private readonly sessions?: AgentSessionRepository,
    private readonly artifacts?: SessionArtifactRepository,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
  ) { this.output = new ToolOutputDispatcher(artifacts, now); }

  private readonly output: ToolOutputDispatcher;

  async execute(input: RunAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    const tool = await this.loadTool(input.scope, input.toolId, input.version);
    const session = await this.resolveSession(input.scope, { internalId: `tool:${tool.metadata.internalId}`, version: tool.metadata.version.toString() }, input.sessionId);
    return this.executeRun(
      input.scope,
      input.mode,
      input.purpose ?? 'interactive',
      session?.id,
      { tool: { internalId: input.toolId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) } },
      async (trace, timing, runId) => {
        const ctx: NodeContext = { runId, scope: input.scope, mode: input.mode, budget: makeBudget(), depth: 0, subAgents: [], ...(session === undefined ? {} : { session }) };
        const result = await this.perform(input.systemPrompt, input.message, [tool], trace, timing, ctx, signal, undefined, undefined, undefined, input.images);
        return result.tool === undefined ? { ...result, tool: this.toolRef(tool) } : result;
      },
    );
  }

  async executeSaved(input: RunSavedAgentPreviewInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    const agentRepo = this.agents;
    if (agentRepo === undefined) throw new AgentRunError('saved Agent execution is not configured');
    const budget = makeBudget(input.budget);
    const agent = await this.loadAgent(input.scope, input.agentId, input.version);
    const session = await this.resolveSession(input.scope, { internalId: agent.metadata.internalId, version: agent.metadata.version.toString() }, input.sessionId);
    return this.executeRun(
      input.scope,
      input.mode,
      input.purpose ?? 'interactive',
      session?.id,
      { agent: { internalId: input.agentId, ...(input.version !== undefined ? { version: input.version.toString() } : {}) } },
      async (trace, timing, runId) => {
        // 実効副作用（自Tool + 全サブの推移的最大）が read-only でなければ実行前に拒否する。
        const effect = await resolveEffectiveSideEffect(input.scope, agent, { tools: this.repo, agents: agentRepo, skills: this.skills });
        if (effect !== 'read-only' && effect !== 'session-write') {
          throw new UnsafeToolError(`Agent preview refuses ${effect} effective side-effect for agent '${agent.metadata.internalId}'`);
        }
        const additionalAgents = input.additionalAgents ?? [];
        for (const ref of additionalAgents) {
          const sub = await agentRepo.findVersion(input.scope, ref.internalId, ref.version);
          if (sub === null) throw new AgentRunError(`additional sub-agent not found: ${ref.internalId}@${ref.version.toString()}`);
          const subEffect = await resolveEffectiveSideEffect(input.scope, sub, { tools: this.repo, agents: agentRepo, skills: this.skills });
          if (subEffect !== 'read-only' && subEffect !== 'session-write') {
            throw new UnsafeToolError(`Agent preview refuses ${subEffect} effective side-effect for additional sub-agent '${sub.metadata.internalId}'`);
          }
        }
        const resolved = await resolveAgentCapabilities(input.scope, agent.skills, agent.tools, this.repo, this.skills, [...agent.agents, ...additionalAgents], agentRepo);
        const ctx: NodeContext = { runId, scope: input.scope, mode: input.mode, budget, depth: 0, subAgents: resolved.subAgents, ...(session === undefined ? {} : { session }) };
        const wikiContext = await this.buildWikiContext(input.scope, agent, input.message, input.memoryPageIds);
        const memoryContext = [wikiContext, input.memoryContext].filter((value): value is string => value !== undefined && value.trim() !== '').join('\n\n') || undefined;
        const systemPrompt = withMemoryContext(composeAgentSystemPrompt(agent.systemPrompt, resolved.skills), memoryContext);
        return this.perform(systemPrompt, input.message, resolved.tools, trace, timing, ctx, signal, this.agentRef(agent), agent.output, input.history, input.images);
      },
    );
  }

  /** サブエージェントを子Runとして入れ子実行する（ツリー共有 budget・depth+1・history なし）。 */
  private async runChildAgent(scope: TenantScope, agent: Agent, message: string, mode: AgentRunMode, budget: RunBudget, depth: number, session: AgentSession | undefined, signal?: AbortSignal): Promise<AgentPreviewRun> {
    return this.executeRun(scope, mode, 'delegation', session?.id, { agent: this.agentRef(agent) }, async (trace, timing, runId) => {
      const resolved = await resolveAgentCapabilities(scope, agent.skills, agent.tools, this.repo, this.skills, agent.agents, this.agents);
      const ctx: NodeContext = { runId, scope, mode, budget, depth, subAgents: resolved.subAgents, ...(session === undefined ? {} : { session }) };
      const wikiContext = await this.buildWikiContext(scope, agent, message);
      return this.perform(withMemoryContext(composeAgentSystemPrompt(agent.systemPrompt, resolved.skills), wikiContext), message, resolved.tools, trace, timing, ctx, signal, this.agentRef(agent), agent.output);
    });
  }

  private async executeRun(
    scope: TenantScope,
    mode: AgentRunMode,
    purpose: RunPurpose,
    sessionId: string | undefined,
    refs: Pick<RunRecord, 'tool' | 'agent'>,
    work: (trace: RunTraceEvent[], timing: RunTiming, runId: string) => Promise<RunResult>,
  ): Promise<AgentPreviewRun> {
    const runId = this.makeRunId();
    const startedAt = this.now().toISOString();
    const startedTick = this.monotonicNow();
    const model = this.observability?.model;
    const started = startRun({ runId, scope, mode, purpose, ...(sessionId === undefined ? {} : { sessionId }), ...refs, ...(model !== undefined ? { model } : {}), startedAt });
    await this.runRepo.save(started);
    const trace: RunTraceEvent[] = [];
    const timing: RunTiming = { modelMs: 0, toolMs: 0 };
    const span = safeStartSpan(this.observability?.telemetry, 'agent.run', { 'run.id': runId, 'run.mode': mode, 'run.purpose': purpose, 'scope.tenant_id': scope.tenantId, 'scope.workspace_id': scope.workspaceId });
    try {
      const result = await work(trace, timing, runId);
      const completedAt = this.now().toISOString();
      const latency = this.latency(startedTick, timing);
      const estimatedCost = await estimateRunCost(this.observability?.pricing, model, result.usage, completedAt);
      const completed = succeedRun(started, {
        ...(result.tool !== undefined ? { tool: result.tool } : {}),
        ...(result.tools !== undefined ? { tools: result.tools } : {}),
        ...(result.agent !== undefined ? { agent: result.agent } : {}),
        response: result.response,
        ...(result.structuredResponse !== undefined ? { structuredResponse: result.structuredResponse } : {}),
        trace: sanitizeRunTrace(trace),
        usage: result.usage,
        latency,
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        completedAt,
      });
      await this.runRepo.save(completed);
      await recordRunMetricSafely(this.observability?.operations, completed);
      span.setAttribute('run.status', 'succeeded'); span.setAttribute('run.latency_ms', latency.totalMs); span.end();
      return { runId, mode, purpose, ...(sessionId === undefined ? {} : { sessionId }), ...(model !== undefined ? { model } : {}), ...result, latency, ...(estimatedCost !== undefined ? { estimatedCost } : {}), trace };
    } catch (error) {
      const failure = failureFrom(error);
      trace.push({ sequence: trace.length + 1, kind: 'error', code: failure.code, message: failure.message });
      const latency = this.latency(startedTick, timing);
      const failed = failRun(started, { trace: sanitizeRunTrace(trace), failure, latency, completedAt: this.now().toISOString() });
      await this.runRepo.save(failed);
      await recordRunMetricSafely(this.observability?.operations, failed);
      span.setAttribute('run.status', 'failed'); span.setAttribute('run.latency_ms', latency.totalMs); span.end(error);
      throw new RunFailedError(runId, error);
    }
  }

  private async perform(
    systemPrompt: string,
    userMessage: string,
    tools: readonly Tool[],
    trace: RunTraceEvent[],
    timing: RunTiming,
    ctx: NodeContext,
    signal?: AbortSignal,
    agent?: RunRecord['agent'],
    output?: StructuredOutputDefinition,
    history?: readonly AgentHistoryMessage[],
    images?: readonly ImageAttachment[],
  ): Promise<RunResult> {
    for (const tool of tools) {
      if (tool.sideEffect !== 'read-only' && tool.sideEffect !== 'session-write') {
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
    if ((images?.length ?? 0) > 0 && !this.model.capabilities().includes('vision')) {
      throw new AgentRunError('configured model provider does not support image input');
    }

    const toolDefinitions = tools.map(toolToModelDefinition);
    const definitions = [...toolDefinitions, ...ctx.subAgents.map(subAgentToolDefinition), ...this.workspaceDefinitions(ctx, tools)];
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: systemPrompt },
      // v16: 会話履歴（シナリオ検証の複数ターン）を system 直後へ注入する（後方互換: 省略時は従来どおり）。
      ...(history ?? []).map((entry): ModelMessage => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userContent(userMessage, images) },
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
      const completion = await this.completeModel({
        messages,
        ...(definitions.length > 0 ? { tools: definitions } : {}),
        ...(responseFormat !== undefined ? { responseFormat } : {}),
      }, timing, signal);
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
          messages.push(await this.delegateTimed(sub, call, trace, timing, ctx, signal));
          continue;
        }
        if (this.isWorkspaceTool(call.name, ctx, tools)) {
          messages.push(await this.executeWorkspaceTool(call, trace, ctx));
          continue;
        }
        const selectedIndex = toolDefinitions.findIndex((definition) => definition.name === call.name);
        const tool = selectedIndex < 0 ? undefined : tools[selectedIndex];
        if (tool === undefined) throw new AgentRunError(`model requested unknown tool: ${call.name}`);
        messages.push(await this.executeToolTimed(tool, call, trace, timing, ctx, agent));
        executed.push(this.toolRef(tool));
      }
    }
    throw new AgentRunError(`model round limit exceeded: maximum ${MAX_MODEL_ROUNDS}`);
  }

  private async completeModel(request: Parameters<ModelProviderPort['complete']>[0], timing: RunTiming, signal?: AbortSignal): Promise<ModelCompletion> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'model.complete', { 'model.provider': this.observability?.model?.provider ?? 'unknown', 'model.name': this.observability?.model?.model ?? 'unknown' }); let failure: unknown;
    try { return await this.model.complete(request, signal); }
    catch (error) { failure = error; throw error; }
    finally { timing.modelMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private async delegateTimed(sub: ResolvedSubAgent, call: ModelToolCall, trace: RunTraceEvent[], timing: RunTiming, ctx: NodeContext, signal?: AbortSignal): Promise<ModelMessage> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'tool.execute', { 'tool.name': call.name, 'tool.kind': 'agent-delegation' }); let failure: unknown;
    try { return await this.delegate(sub, call, trace, ctx, signal); }
    catch (error) { failure = error; throw error; }
    finally { timing.toolMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private async executeToolTimed(tool: Tool, call: ModelToolCall, trace: RunTraceEvent[], timing: RunTiming, ctx: NodeContext, agent?: RunRecord['agent']): Promise<ModelMessage> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'tool.execute', { 'tool.name': call.name, 'tool.kind': 'etl' }); let failure: unknown;
    try { return await this.executeTool(tool, call, trace, ctx, agent); }
    catch (error) { failure = error; throw error; }
    finally { timing.toolMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private monotonicNow(): number { return this.observability?.monotonicNow?.() ?? performance.now(); }
  private latency(started: number, timing: RunTiming): RunLatencyBreakdown {
    return { totalMs: Math.max(0, this.monotonicNow() - started), modelMs: timing.modelMs, toolMs: timing.toolMs };
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
      const child = await this.runChildAgent(ctx.scope, sub.agent, message, ctx.mode, ctx.budget, ctx.depth + 1, ctx.session, signal);
      const content = child.structuredResponse !== undefined ? JSON.stringify(child.structuredResponse) : child.response;
      trace.push({ sequence: trace.length + 1, kind: 'agent_call', toolName: sub.toolName, agentRef, childRunId: child.runId, ok: true, summary: summarize(content) });
      return { role: 'tool', content, toolCallId: call.id };
    } catch (error) {
      const childRunId = error instanceof RunFailedError ? error.runId : '';
      const detail = error instanceof Error ? error.message : 'delegation failed';
      return record(childRunId, false, `[delegation failed: ${detail}]`);
    }
  }

  private async executeTool(tool: Tool, call: ModelToolCall, trace: RunTraceEvent[], ctx: NodeContext, agent?: RunRecord['agent']): Promise<ModelMessage> {
    trace.push({ sequence: trace.length + 1, kind: 'tool-call', name: call.name, arguments: call.arguments });
    const args = validateToolArguments(tool.inputSchema, call.arguments);
    const graph = graphWithArguments(tool, args);
    const executableGraph = this.resolveDataSources === undefined ? graph : await this.resolveDataSources.execute(ctx.scope, graph);
    const preview = this.engine.preview(executableGraph, { rowLimit: hasSessionStorageSink(tool) ? 10_000 : 100 });
    assertOutputMatchesSchema(preview.output, tool.outputSchema);
    const delivery = await this.output.dispatch({ tool, table: preview.output, session: ctx.session, runId: ctx.runId, toolCallId: call.id, ...(agent?.internalId === undefined ? {} : { agentId: agent.internalId }) });
    trace.push({
      sequence: trace.length + 1,
      kind: 'tool-result',
      name: call.name,
      terminalId: preview.terminalId,
      nodes: Object.values(preview.nodes).map((node) => ({ nodeId: node.nodeId, rowCount: node.table.rows.length, truncated: node.truncated })),
      outputPreview: delivery.delivery === 'session-workspace'
        ? [{ artifactId: delivery.artifact.id, name: delivery.artifact.name, kind: delivery.artifact.kind, revision: delivery.artifact.revision }]
        : preview.output.rows.slice(0, 10).map((row) => ({ ...row })),
    });
    return {
      role: 'tool',
      content: delivery.content,
      toolCallId: call.id,
    };
  }

  private toolRef(tool: Tool): NonNullable<RunRecord['tool']> {
    return { internalId: tool.metadata.internalId, publishName: tool.metadata.publishName, version: tool.metadata.version.toString() };
  }

  private agentRef(agent: Agent): NonNullable<RunRecord['agent']> {
    return { internalId: agent.metadata.internalId, publishName: agent.metadata.publishName, version: agent.metadata.version.toString() };
  }

  private workspaceDefinitions(ctx: NodeContext, tools: readonly Tool[]): readonly ModelToolDefinition[] {
    if (ctx.session === undefined || this.artifacts === undefined || !tools.some((tool) => hasSessionStorageSink(tool))) return [];
    return [
      { name: 'workspace_list', description: 'List temporary artifacts available in the current Agent session.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      { name: 'workspace_describe', description: 'Describe schema, size and provenance for a temporary artifact.', parameters: { type: 'object', properties: { artifactId: { type: 'string', description: 'Artifact ID returned by workspace_list or a Tool result.' } }, required: ['artifactId'], additionalProperties: false } },
      { name: 'workspace_read', description: 'Read a bounded page of a temporary artifact. For graph Artifacts, select nodes or edges. Use this instead of asking for the whole data set.', parameters: { type: 'object', properties: { artifactId: { type: 'string', description: 'Artifact ID.' }, offset: { type: 'integer', description: 'Zero-based row or record offset (default 0).' }, limit: { type: 'integer', description: 'Maximum records to return (1-100).' }, section: { type: 'string', enum: ['nodes', 'edges'], description: 'Graph record kind; default is edges.' } }, required: ['artifactId'], additionalProperties: false } },
      { name: 'workspace_query', description: 'Run a bounded, structured query against one table Artifact page. Supports selected columns, one comparison filter, and one numeric aggregate. It never evaluates SQL or code.', parameters: { type: 'object', properties: { artifactId: { type: 'string', description: 'Table Artifact ID.' }, offset: { type: 'integer', description: 'Zero-based row offset (default 0).' }, limit: { type: 'integer', description: 'Rows to scan from this page (1-100).' }, columns: { type: 'array', items: { type: 'string' }, description: 'Optional columns to return.' }, filter: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'] }, value: {} }, required: ['column', 'op', 'value'], additionalProperties: false }, aggregate: { type: 'object', properties: { op: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] }, column: { type: 'string' } }, required: ['op'], additionalProperties: false } }, required: ['artifactId'], additionalProperties: false } },
    ];
  }

  private isWorkspaceTool(name: string, ctx: NodeContext, tools: readonly Tool[]): boolean {
    return this.workspaceDefinitions(ctx, tools).some((definition) => definition.name === name);
  }

  private async executeWorkspaceTool(call: ModelToolCall, trace: RunTraceEvent[], ctx: NodeContext): Promise<ModelMessage> {
    const session = ctx.session as AgentSession;
    const artifacts = this.artifacts as SessionArtifactRepository;
    trace.push({ sequence: trace.length + 1, kind: 'tool-call', name: call.name, arguments: call.arguments });
    let content: string;
    let preview: readonly Readonly<Record<string, unknown>>[] = [];
    if (call.name === 'workspace_list') {
      const list = await artifacts.list(ctx.scope, session.id);
      content = JSON.stringify({ artifacts: list.map((artifact) => ({ id: artifact.id, name: artifact.name, kind: artifact.kind, revision: artifact.revision, schema: artifact.schema, sizeBytes: artifact.sizeBytes, counts: artifact.counts })) });
      preview = list.slice(0, 10).map((artifact) => ({ artifactId: artifact.id, name: artifact.name, kind: artifact.kind }));
    } else {
      const artifactId = call.arguments['artifactId'];
      if (typeof artifactId !== 'string' || artifactId.trim() === '') throw new AgentRunError(`${call.name} requires a non-empty artifactId`);
      if (call.name === 'workspace_describe') {
        const result = await artifacts.read(ctx.scope, session.id, artifactId, { limit: 1 });
        if (result === null) throw new AgentRunError(`workspace artifact not found: ${artifactId}`);
        content = JSON.stringify({ artifact: { id: result.artifact.id, name: result.artifact.name, kind: result.artifact.kind, revision: result.artifact.revision, schema: result.artifact.schema, sizeBytes: result.artifact.sizeBytes, checksum: result.artifact.checksum, counts: result.artifact.counts, createdAt: result.artifact.createdAt } });
        preview = [{ artifactId: result.artifact.id, name: result.artifact.name, kind: result.artifact.kind }];
      } else if (call.name === 'workspace_query') {
        const limit = boundedWorkspaceLimit(call.arguments['limit']);
        const offset = boundedWorkspaceOffset(call.arguments['offset']);
        const result = await artifacts.read(ctx.scope, session.id, artifactId, { offset, limit });
        if (result === null) throw new AgentRunError(`workspace artifact not found: ${artifactId}`);
        const query = queryWorkspaceTable(result.payload, call.arguments);
        content = JSON.stringify({ artifactId: result.artifact.id, query });
        preview = [{ artifactId: result.artifact.id, rows: query.rows?.length, aggregate: query.aggregate }];
      } else {
        const limit = boundedWorkspaceLimit(call.arguments['limit']);
        const offset = boundedWorkspaceOffset(call.arguments['offset']);
        const requestedSection = call.arguments['section'];
        const section = requestedSection === 'nodes' || requestedSection === 'edges' ? requestedSection : undefined;
        const result = await artifacts.read(ctx.scope, session.id, artifactId, { offset, limit, ...(section === undefined ? {} : { section }) });
        if (result === null) throw new AgentRunError(`workspace artifact not found: ${artifactId}`);
        const payload = boundedWorkspacePayload(result.payload, limit);
        content = JSON.stringify({ artifactId: result.artifact.id, payload });
        preview = [{ artifactId: result.artifact.id, rows: Array.isArray((payload as { rows?: unknown }).rows) ? ((payload as { rows: unknown[] }).rows.length) : undefined }];
      }
    }
    trace.push({ sequence: trace.length + 1, kind: 'tool-result', name: call.name, terminalId: 'session-workspace', nodes: [], outputPreview: preview });
    return { role: 'tool', content, toolCallId: call.id };
  }

  private async resolveSession(scope: TenantScope, rootAgent: { readonly internalId: string; readonly version: string }, requestedId?: string): Promise<AgentSession | undefined> {
    const sessions = this.sessions;
    if (sessions === undefined) return undefined;
    const now = this.now();
    if (requestedId === undefined) {
      const session = createAgentSession({ id: randomUUID(), scope, rootAgent, createdAt: now.toISOString(), lastAccessedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString() });
      await sessions.save(session);
      return session;
    }
    const session = await sessions.find(scope, requestedId);
    if (session === null) throw new AgentSessionNotFoundError(`agent session not found: ${requestedId}`);
    if (session.status === 'closed') throw new AgentSessionClosedError(`agent session is closed: ${requestedId}`);
    if (session.status === 'expired' || session.expiresAt <= now.toISOString()) {
      if (session.status === 'active') await sessions.save(expireAgentSession(session));
      throw new AgentSessionExpiredError(`agent session is expired: ${requestedId}`);
    }
    if (session.rootAgent.internalId !== rootAgent.internalId || session.rootAgent.version !== rootAgent.version) {
      throw new AgentRunError('agent session belongs to a different Agent version');
    }
    await sessions.save({ ...session, lastAccessedAt: now.toISOString() });
    return { ...session, lastAccessedAt: now.toISOString() };
  }

  private async buildWikiContext(scope: TenantScope, agent: Agent, query: string, manualPageIds?: readonly string[]): Promise<string | undefined> {
    const wiki = this.wiki;
    if (wiki === undefined) return undefined;
    const allowed = new Set((agent.wikis ?? []).map((ref) => ref.wikiId));
    const pages = new Map<string, WikiPage>();

    for (const wikiId of allowed) {
      const matchedIds = new Set<string>();
      const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
      const queries = [query, ...tokens];
      for (const candidate of queries) {
        if (matchedIds.size >= 2) break;
        for (const match of await wiki.search(scope, candidate, 2 - matchedIds.size, [wikiId])) matchedIds.add(match.id);
      }
      for (const pageId of matchedIds) {
        const page = await wiki.find(scope, pageId);
        if (page !== null && effectiveWikiId(page) === wikiId) pages.set(page.id, page);
      }
    }
    for (const pageId of manualPageIds ?? []) {
      const page = await wiki.find(scope, pageId);
      if (page === null) continue;
      if (allowed.size > 0 && !allowed.has(effectiveWikiId(page))) throw new AgentRunError(`memory page '${pageId}' is outside Agent wiki allowlist`);
      pages.set(page.id, page);
    }
    if (pages.size === 0) return undefined;

    const sections: string[] = [];
    let length = 0;
    for (const page of [...pages.values()].slice(0, 6)) {
      const space = await wiki.findSpace(scope, effectiveWikiId(page));
      const body = page.body.length > 600 ? `${page.body.slice(0, 600)}…` : page.body;
      const section = `## Wiki: ${space?.name ?? effectiveWikiId(page)} / ${page.title}\n${body}`;
      if (length + section.length > 2400) break;
      sections.push(section); length += section.length;
    }
    return sections.length === 0 ? undefined : sections.join('\n\n');
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

function userContent(message: string, images?: readonly ImageAttachment[]): string | readonly ModelContentPart[] {
  if (images === undefined || images.length === 0) return message;
  return [
    { type: 'text', text: message },
    ...images.map((image): ModelContentPart => ({ type: 'image_url', imageUrl: image.dataUrl })),
  ];
}

function boundedWorkspacePayload(payload: unknown, limit: number): unknown {
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)) {
    const value = payload as { schema?: unknown; rows: unknown[] };
    return { ...(value.schema === undefined ? {} : { schema: value.schema }), rows: value.rows.slice(0, limit) };
  }
  const serialized = JSON.stringify(payload) ?? 'null';
  return serialized.length > 65_536 ? { truncated: true, preview: serialized.slice(0, 65_536) } : payload;
}

function boundedWorkspaceLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(100, Math.max(1, value)) : 20;
}

function boundedWorkspaceOffset(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(1_000_000, Math.max(0, value)) : 0;
}

type WorkspaceQueryValue = string | number | boolean | null;
type WorkspaceQueryRow = Readonly<Record<string, WorkspaceQueryValue>>;
type WorkspaceFilter = Readonly<{ column: string; op: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; value: WorkspaceQueryValue }>;
type WorkspaceAggregate = Readonly<{ op: 'count' | 'sum' | 'avg' | 'min' | 'max'; column?: string }>;

export interface WorkspaceQueryResult {
  readonly schema: Schema;
  readonly rows: readonly WorkspaceQueryRow[];
  readonly page?: unknown;
  readonly aggregate?: Readonly<{ op: WorkspaceAggregate['op']; column?: string; value: number | null }>;
}

/** Executes the deliberately small, data-only query DSL exposed by workspace_query. */
export function queryWorkspaceTable(payload: unknown, arguments_: Readonly<Record<string, unknown>>): WorkspaceQueryResult {
  if (!isWorkspaceTablePayload(payload)) throw new AgentRunError('workspace_query supports table Artifacts only');
  const availableColumns = new Set(payload.schema.columns.map((column) => column.name));
  const columns = selectedWorkspaceColumns(arguments_['columns'], availableColumns);
  const filter = parseWorkspaceFilter(arguments_['filter'], availableColumns);
  const aggregate = parseWorkspaceAggregate(arguments_['aggregate'], availableColumns);
  const filteredRows = payload.rows.filter((row) => filter === undefined || matchesWorkspaceFilter(row, filter));
  const rows = filteredRows.map((row) => projectWorkspaceRow(row, columns));
  const schema = { columns: payload.schema.columns.filter((column) => columns.includes(column.name)) };
  return {
    schema,
    rows,
    ...(payload.page === undefined ? {} : { page: payload.page }),
    ...(aggregate === undefined ? {} : { aggregate: evaluateWorkspaceAggregate(filteredRows, aggregate) }),
  };
}

function isWorkspaceTablePayload(value: unknown): value is Readonly<{ schema: Schema; rows: readonly WorkspaceQueryRow[]; page?: unknown }> {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { schema?: unknown; rows?: unknown };
  return candidate.schema !== null
    && typeof candidate.schema === 'object'
    && Array.isArray((candidate.schema as { columns?: unknown }).columns)
    && (candidate.schema as { columns: unknown[] }).columns.every((column) => column !== null && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string')
    && Array.isArray(candidate.rows)
    && candidate.rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
}

function selectedWorkspaceColumns(value: unknown, availableColumns: ReadonlySet<string>): readonly string[] {
  if (value === undefined) return [...availableColumns];
  if (!Array.isArray(value) || value.length === 0 || value.some((column) => typeof column !== 'string' || !availableColumns.has(column))) {
    throw new AgentRunError('workspace_query columns must be non-empty known column names');
  }
  return [...new Set(value)];
}

function parseWorkspaceFilter(value: unknown, availableColumns: ReadonlySet<string>): WorkspaceFilter | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AgentRunError('workspace_query filter must be an object');
  const filter = value as Readonly<Record<string, unknown>>;
  const op = filter['op'];
  const filterValue = filter['value'];
  if (typeof filter['column'] !== 'string' || !availableColumns.has(filter['column']) || !isWorkspaceFilterOp(op) || !isWorkspaceQueryValue(filterValue)) {
    throw new AgentRunError('workspace_query filter requires a known column, supported operator, and scalar value');
  }
  if (op === 'contains' && typeof filterValue !== 'string') throw new AgentRunError('workspace_query contains filter requires a string value');
  return { column: filter['column'], op, value: filterValue };
}

function isWorkspaceFilterOp(value: unknown): value is WorkspaceFilter['op'] {
  return value === 'eq' || value === 'neq' || value === 'contains' || value === 'gt' || value === 'gte' || value === 'lt' || value === 'lte';
}

function isWorkspaceQueryValue(value: unknown): value is WorkspaceQueryValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parseWorkspaceAggregate(value: unknown, availableColumns: ReadonlySet<string>): WorkspaceAggregate | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AgentRunError('workspace_query aggregate must be an object');
  const aggregate = value as Readonly<Record<string, unknown>>;
  const op = aggregate['op'];
  if (op !== 'count' && op !== 'sum' && op !== 'avg' && op !== 'min' && op !== 'max') throw new AgentRunError('workspace_query aggregate operator is not supported');
  const column = aggregate['column'];
  if (op === 'count') {
    if (column !== undefined && (typeof column !== 'string' || !availableColumns.has(column))) throw new AgentRunError('workspace_query aggregate column is not available');
    return column === undefined ? { op } : { op, column };
  }
  if (typeof column !== 'string' || !availableColumns.has(column)) throw new AgentRunError('workspace_query numeric aggregate requires a known column');
  return { op, column };
}

function matchesWorkspaceFilter(row: WorkspaceQueryRow, filter: WorkspaceFilter): boolean {
  const value = row[filter.column];
  switch (filter.op) {
    case 'eq': return value === filter.value;
    case 'neq': return value !== filter.value;
    case 'contains': return typeof value === 'string' && value.includes(filter.value as string);
    case 'gt': return comparableWorkspaceValues(value, filter.value, (left, right) => left > right);
    case 'gte': return comparableWorkspaceValues(value, filter.value, (left, right) => left >= right);
    case 'lt': return comparableWorkspaceValues(value, filter.value, (left, right) => left < right);
    case 'lte': return comparableWorkspaceValues(value, filter.value, (left, right) => left <= right);
  }
}

function comparableWorkspaceValues(value: WorkspaceQueryValue | undefined, expected: WorkspaceQueryValue, predicate: (left: string | number, right: string | number) => boolean): boolean {
  return (typeof value === 'string' || typeof value === 'number') && typeof value === typeof expected && predicate(value, expected as string | number);
}

function projectWorkspaceRow(row: WorkspaceQueryRow, columns: readonly string[]): WorkspaceQueryRow {
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

function evaluateWorkspaceAggregate(rows: readonly WorkspaceQueryRow[], aggregate: WorkspaceAggregate): NonNullable<WorkspaceQueryResult['aggregate']> {
  if (aggregate.op === 'count') return { op: aggregate.op, ...(aggregate.column === undefined ? {} : { column: aggregate.column }), value: rows.length };
  const values = rows.map((row) => row[aggregate.column as string]).filter((value): value is number => typeof value === 'number');
  const value = values.length === 0 ? null
    : aggregate.op === 'sum' ? values.reduce((total, item) => total + item, 0)
      : aggregate.op === 'avg' ? values.reduce((total, item) => total + item, 0) / values.length
        : aggregate.op === 'min' ? Math.min(...values)
          : Math.max(...values);
  return { op: aggregate.op, column: aggregate.column, value };
}
