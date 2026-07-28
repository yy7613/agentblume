import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_RUNTIME_HARNESS, type Agent, type AgentRuntimeHarness, type AgentSubAgentRef } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import type { Row, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { RunApprovalCheckpoint, RunCheckpointMessage, RunCheckpointToolCall, RunLatencyBreakdown, RunMode, RunModelSnapshot, RunPurpose, RunRecord, RunStatus, RunTraceEvent, RunUsage } from '../../domain/run/run';
import { failRun, resumeRunRecord, startRun, succeedRun, waitRunForApproval } from '../../domain/run/run';
import { RunNotFoundError } from '../../domain/run/errors';
import type { RunRepository } from '../../domain/run/run-repository';
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { SideEffect } from '../../domain/tool/metadata';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { EtlEngine } from '../etl/engine';
import type { JsonObject, ModelCompletion, ModelContentPart, ModelMessage, ModelProviderPort, ModelRequestMessage, ModelToolCall, ModelToolDefinition, ModelUsage } from '../model/model-provider';
import { AgentRunError, RunFailedError, ToolArgumentsError, UnsafeToolError } from './errors';
import { failureFrom, sanitizeRunTrace } from './run-trace';
import { assertOutputMatchesSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';
import { toModelResponseFormat, validateStructuredResponse } from './structured-output';
import { HARD_MAX_DEPTH, composeAgentSystemPrompt, resolveAgentCapabilities, resolveEffectiveSideEffect, type ResolvedSubAgent } from './resolve-agent-capabilities';
import type { TelemetryPort } from '../operations/telemetry';
import { safeStartSpan } from '../operations/telemetry';
import type { PricingPort } from '../operations/pricing';
import type { OperationsRepository } from '../../domain/operations/operations-repository';
import { estimateRunCost, recordRunMetricSafely } from '../operations/run-observability';
import { logSwallowed, type LoggerPort } from '../operations/logger';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { effectiveWikiId, type WikiPage } from '../../domain/memory/wiki-page';
import { createAgentSession, expireAgentSession, type AgentSession } from '../../domain/session/agent-session';
import { AgentSessionClosedError, AgentSessionExpiredError, AgentSessionNotFoundError } from '../../domain/session/errors';
import type { AgentSessionRepository, SessionArtifactRepository } from '../../domain/session/session-repository';
import { ToolOutputDispatcher } from '../tool/tool-output-dispatcher';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { WebSearchUseCase } from '../search/web-search';
import {
  agentMemoryWikiId, AgentRuntimeHarnessRuntime, compactModelMessages,
  HARNESS_COMPACTION_BUDGET_CHARS, HARNESS_MAX_MODEL_ROUNDS, HARNESS_MAX_TOOL_CALLS,
} from './runtime-harness';
import type { McpClientPort } from '../mcp/mcp-client';
import { isMcpToolName, McpToolset } from './mcp-tools';

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
  /**
   * 対話相手（人間）がいる実行かどうか。POST /runs だけが true を渡す。
   * Harness・Factory・シナリオ検証などの自動実行は未指定（false）のままにして、
   * 承認ゲートで停止してデッドロックすることを防ぐ。
   */
  readonly interactive?: boolean;
}

/** 単一エージェントRunの承認待ちを解決して再開する入力。 */
export interface ResumeSavedRunInput {
  readonly scope: TenantScope;
  readonly runId: string;
  readonly decision: 'approve' | 'reject';
  readonly feedback?: string;
  /**
   * 承認した主体（`Principal.subject`）。api層が必ず入れる。
   *
   * クライアントからは受け取らない。以前は承認者の概念自体が無く、
   * runId を知っていれば誰でも他人の待機中Runを承認でき、しかも
   * トレースには「承認された」としか残らなかった。
   */
  readonly decidedBy?: string;
}

/** サブエージェント委譲のツリー共有バジェット。remaining系は実行中に減算される。 */
export interface RunBudget {
  maxDelegationDepth: number;   // 既定2・絶対上限 HARD_MAX_DEPTH(3)
  remainingModelRounds: number; // ツリー共有・既定12
  remainingToolCalls: number;   // ツリー共有・既定16
}

/** 承認待ちで停止したRunがUIへ返す最小の再開情報。 */
export interface AgentRunApprovalPrompt {
  readonly prompt: string;
  readonly expiresAt: string;
  /** 承認対象のツール名（モデルが呼んだ名前）。 */
  readonly tool: string;
  readonly sideEffect: string;
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
  /**
   * 承認待ちで停止したときだけ 'waiting-approval'。完走時は後方互換のため未指定。
   * 呼び出し側は `status === 'waiting-approval'` だけを判定すればよい。
   */
  readonly status?: RunStatus;
  /** status === 'waiting-approval' のときだけ設定される。 */
  readonly checkpoint?: AgentRunApprovalPrompt;
}

type RunResult = Omit<AgentPreviewRun, 'runId' | 'mode' | 'trace' | 'status' | 'checkpoint'>;

export const MAX_TOOL_CALLS = 4;
export const MAX_MODEL_ROUNDS = 5;
export const DEFAULT_MAX_DELEGATION_DEPTH = 2;
export const DEFAULT_MODEL_ROUNDS_BUDGET = 12;
export const DEFAULT_TOOL_CALLS_BUDGET = 16;
/** 承認待ちcheckpointの有効期限（domain/harness の INTERACTIVE_CHECKPOINT_TTL_MS と同値）。 */
export const INTERACTIVE_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * 構造化出力の検証に失敗したとき、エラーを添えてモデルへ作り直させる回数（1 Runあたり）。
 * Factoryの `generateToolWithRepair` と同じ規律だが、対話実行は待ち時間が体感に直結するため
 * 既定は控えめの1回。修復は通常のモデル往復として発行するので `maxModelRounds` と
 * ツリー共有バジェット `remainingModelRounds` を1つ消費する（最終往復・予算切れでは修復しない）。
 */
export const MAX_STRUCTURED_OUTPUT_REPAIRS = 1;

/**
 * モデルが渡したツール引数がスキーマに合わなかったとき、エラーをツール結果として差し戻し
 * 呼び直させる回数（1 Runあたり）。差し戻しは新しいツール呼び出しを誘発するため
 * `remainingToolCalls` を追加で消費しうる（失敗した呼び出し自体も1件として消費済み）。
 */
export const MAX_TOOL_ARGUMENT_REPAIRS = 1;

/** 中断されたRunの失敗コード。`failed` で残るRunを「利用者が止めた」と読めるようにする。 */
export const RUN_CANCELLED_CODE = 'RUN_CANCELLED';
const RUN_CANCELLED_MESSAGE = 'run cancelled by the user';

/**
 * 内部の制御シグナル。承認待ちは「失敗」ではなく永続的な状態遷移なので、
 * 実行ループから executeRun まで checkpoint を運ぶためだけに例外を使う（HarnessPause と同型）。
 */
class AgentRunPause extends Error {
  constructor(readonly checkpoint: RunApprovalCheckpoint, readonly usage: RunUsage) {
    super(`agent run waiting for tool approval: ${checkpoint.prompt}`);
    this.name = 'AgentRunPause';
  }
}

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
  /** Agentが明示設定したランタイムハーネス。未設定（=従来動作）なら undefined。 */
  readonly harness?: AgentRuntimeHarness;
  /** Agentが参照するMCPサーバー名。Run開始時（再開時も）にツールを解決する。 */
  readonly mcpServers?: readonly string[];
  /** 対話相手がいる実行か。承認ゲートは interactive かつ depth === 0 のときだけ発火する。 */
  readonly interactive?: boolean;
}

interface RunTiming { modelMs: number; toolMs: number }

/** 1 Run のループで変化しない実行文脈。新規実行と再開で同じものを組み立てる。 */
interface LoopContext {
  readonly harness: AgentRuntimeHarness;
  readonly maxModelRounds: number;
  readonly maxToolCalls: number;
  readonly runtime: AgentRuntimeHarnessRuntime;
  /** このRunで解決済みのMCPツール（未使用Runでは空集合）。 */
  readonly mcp: McpToolset;
  readonly tools: readonly Tool[];
  readonly toolDefinitions: readonly ModelToolDefinition[];
  readonly definitions: readonly ModelToolDefinition[];
  readonly output?: StructuredOutputDefinition;
  readonly responseFormat?: ReturnType<typeof toModelResponseFormat>;
  readonly agent?: RunRecord['agent'];
  readonly ctx: NodeContext;
  readonly trace: RunTraceEvent[];
  readonly timing: RunTiming;
  readonly signal?: AbortSignal;
  /** true のとき、非read-onlyのETL Tool実行前に人間の承認を要求して停止する。 */
  readonly approvalGate: boolean;
}

/** ループを跨いで進むミュータブルな状態。checkpoint から復元できる情報だけを持つ。 */
interface LoopState {
  messages: ModelRequestMessage[];
  executed: NonNullable<RunRecord['tool']>[];
  usage: RunUsage;
  remainingHistory: number;
  /** 次に実行するモデル往復番号。 */
  startStep: number;
  /** 再開時、startStep の往復で未実行のまま残っていたツール呼び出し。 */
  pending?: readonly ModelToolCall[];
  /** 承認済みとして1件だけ承認ゲートを素通しするツール呼び出しID。 */
  approvedCallId?: string;
  /** これまでに使った構造化出力の修復回数（上限 MAX_STRUCTURED_OUTPUT_REPAIRS）。 */
  structuredRepairs: number;
  /** これまでに使ったツール引数の修復回数（上限 MAX_TOOL_ARGUMENT_REPAIRS）。 */
  toolArgumentRepairs: number;
}

export interface RunObservabilityOptions {
  readonly telemetry?: TelemetryPort;
  readonly pricing?: PricingPort;
  readonly operations?: OperationsRepository;
  /** 静的なモデル指紋。resolveModel が無い（または失敗した）ときに使う。 */
  readonly model?: RunModelSnapshot;
  /**
   * 実行開始時点のモデル設定を解決する（UIからのモデル切替をRun記録へ反映するため）。
   * 失敗しても実行は止めない（記録は model へフォールバックする）。
   */
  readonly resolveModel?: () => Promise<RunModelSnapshot>;
  readonly monotonicNow?: () => number;
  /** 握り潰した観測系の障害を残す先（未指定なら従来どおり無音）。 */
  readonly logger?: LoggerPort;
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

/**
 * usageを積み上げる（キーは、どこかの完了応答が持っていたときだけ結果に現れる）。
 * 承認待ちを挟んでも通算を保てるよう、完了応答の配列ではなく累積値で持ち回る。
 */
function addUsage(total: RunUsage, next: ModelUsage | undefined): RunUsage {
  if (next === undefined) return total;
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const promptTokens = sum(total.promptTokens, next.promptTokens);
  const completionTokens = sum(total.completionTokens, next.completionTokens);
  const totalTokens = sum(total.totalTokens, next.totalTokens);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// checkpoint（domain）↔ モデルメッセージ（application）の相互変換
// domain層はModelRequestMessageを知らないため、境界はここだけに閉じる。
// ---------------------------------------------------------------------------

function toCheckpointContent(content: ModelRequestMessage['content']): RunCheckpointMessage['content'] {
  if (content === null || typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'image' as const, imageUrl: part.imageUrl });
}

function fromCheckpointContent(content: RunCheckpointMessage['content']): ModelRequestMessage['content'] {
  if (content === null || typeof content === 'string') return content;
  return content.map((part): ModelContentPart => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', imageUrl: part.imageUrl });
}

function toCheckpointMessages(messages: readonly ModelRequestMessage[]): readonly RunCheckpointMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: toCheckpointContent(message.content),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map(toCheckpointToolCall) }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
}

function fromCheckpointMessages(messages: readonly RunCheckpointMessage[]): ModelRequestMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: fromCheckpointContent(message.content),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map(fromCheckpointToolCall) }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
}

function toCheckpointToolCall(call: ModelToolCall): RunCheckpointToolCall {
  return { id: call.id, name: call.name, arguments: { ...call.arguments } };
}

function fromCheckpointToolCall(call: RunCheckpointToolCall): ModelToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments as JsonObject };
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
    private readonly webSearch?: WebSearchUseCase,
    /** 保存済みMCPサーバー設定。mcpClient と両方揃ったときだけMCPツールを注入する。 */
    private readonly mcpServers?: McpServerRepository,
    private readonly mcpClient?: McpClientPort,
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
      signal,
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
        const ctx: NodeContext = { runId, scope: input.scope, mode: input.mode, budget, depth: 0, subAgents: resolved.subAgents, ...(session === undefined ? {} : { session }), ...(agent.harness === undefined ? {} : { harness: agent.harness }), ...(agent.mcpServers === undefined ? {} : { mcpServers: agent.mcpServers }), ...(input.interactive === true ? { interactive: true } : {}) };
        const wikiContext = await this.buildWikiContext(input.scope, agent, input.message, input.memoryPageIds);
        const memoryContext = [wikiContext, input.memoryContext].filter((value): value is string => value !== undefined && value.trim() !== '').join('\n\n') || undefined;
        const systemPrompt = withMemoryContext(composeAgentSystemPrompt(agent.systemPrompt, resolved.skills), memoryContext);
        return this.perform(systemPrompt, input.message, resolved.tools, trace, timing, ctx, signal, this.agentRef(agent), agent.output, input.history, input.images);
      },
      signal,
    );
  }

  /** サブエージェントを子Runとして入れ子実行する（ツリー共有 budget・depth+1・history なし）。 */
  private async runChildAgent(scope: TenantScope, agent: Agent, message: string, mode: AgentRunMode, budget: RunBudget, depth: number, session: AgentSession | undefined, signal?: AbortSignal): Promise<AgentPreviewRun> {
    return this.executeRun(scope, mode, 'delegation', session?.id, { agent: this.agentRef(agent) }, async (trace, timing, runId) => {
      const resolved = await resolveAgentCapabilities(scope, agent.skills, agent.tools, this.repo, this.skills, agent.agents, this.agents);
      const ctx: NodeContext = { runId, scope, mode, budget, depth, subAgents: resolved.subAgents, ...(session === undefined ? {} : { session }), ...(agent.harness === undefined ? {} : { harness: agent.harness }), ...(agent.mcpServers === undefined ? {} : { mcpServers: agent.mcpServers }) };
      const wikiContext = await this.buildWikiContext(scope, agent, message);
      return this.perform(withMemoryContext(composeAgentSystemPrompt(agent.systemPrompt, resolved.skills), wikiContext), message, resolved.tools, trace, timing, ctx, signal, this.agentRef(agent), agent.output);
    }, signal);
  }

  private async executeRun(
    scope: TenantScope,
    mode: AgentRunMode,
    purpose: RunPurpose,
    sessionId: string | undefined,
    refs: Pick<RunRecord, 'tool' | 'agent'>,
    work: (trace: RunTraceEvent[], timing: RunTiming, runId: string) => Promise<RunResult>,
    signal?: AbortSignal,
  ): Promise<AgentPreviewRun> {
    const runId = this.makeRunId();
    const startedAt = this.now().toISOString();
    const model = await this.currentModelSnapshot();
    const started = startRun({ runId, scope, mode, purpose, ...(sessionId === undefined ? {} : { sessionId }), ...refs, ...(model !== undefined ? { model } : {}), startedAt });
    await this.runRepo.save(started);
    return this.runWithRecord(started, [], { modelMs: 0, toolMs: 0 }, 0, work, signal);
  }

  /**
   * Run開始時点のモデル指紋。切替可能な配線では実行のたびに解決し直す。
   * 解決に失敗しても実行自体は続ける（観測のための情報であり、実行の前提条件ではない）。
   */
  private async currentModelSnapshot(): Promise<RunModelSnapshot | undefined> {
    const resolve = this.observability?.resolveModel;
    if (resolve === undefined) return this.observability?.model;
    try { return await resolve(); }
    // 実行は続けるが無音にはしない: 記録される指紋が実際に使ったモデルとずれ続けると追跡できなくなる。
    catch (error) { logSwallowed(this.observability?.logger, 'model settings could not be resolved; falling back to the last known snapshot', error); return this.observability?.model; }
  }

  /**
   * running状態のRunRecordに対して1区間の実行を回し、succeeded / failed / waiting-approval のいずれかへ確定する。
   * 新規実行（executeRun）と承認後の再開（resumeSavedRun）で共有する。
   */
  private async runWithRecord(
    started: RunRecord,
    trace: RunTraceEvent[],
    timing: RunTiming,
    baseTotalMs: number,
    work: (trace: RunTraceEvent[], timing: RunTiming, runId: string) => Promise<RunResult>,
    signal?: AbortSignal,
  ): Promise<AgentPreviewRun> {
    const { runId, scope, mode } = started;
    const purpose = started.purpose ?? 'interactive';
    const sessionId = started.sessionId;
    const model = started.model ?? this.observability?.model;
    const startedTick = this.monotonicNow();
    const span = safeStartSpan(this.observability?.telemetry, 'agent.run', { 'run.id': runId, 'run.mode': mode, 'run.purpose': purpose, 'scope.tenant_id': scope.tenantId, 'scope.workspace_id': scope.workspaceId }, this.observability?.logger);
    try {
      const result = await work(trace, timing, runId);
      const completedAt = this.now().toISOString();
      const latency = this.latency(startedTick, timing, baseTotalMs);
      const estimatedCost = await estimateRunCost(this.observability?.pricing, model, result.usage, completedAt, this.observability?.logger);
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
      await recordRunMetricSafely(this.observability?.operations, completed, this.observability?.logger);
      span.setAttribute('run.status', 'succeeded'); span.setAttribute('run.latency_ms', latency.totalMs); span.end();
      return { runId, mode, purpose, ...(sessionId === undefined ? {} : { sessionId }), ...(model !== undefined ? { model } : {}), ...result, latency, ...(estimatedCost !== undefined ? { estimatedCost } : {}), trace };
    } catch (error) {
      // 承認待ちは失敗ではない: RunRecordを waiting-approval + checkpoint で永続化して呼び出し元へ返す。
      if (error instanceof AgentRunPause) {
        const latency = this.latency(startedTick, timing, baseTotalMs);
        const waiting = waitRunForApproval(started, error.checkpoint, { trace: sanitizeRunTrace(trace), usage: error.usage, latency, response: error.checkpoint.prompt });
        await this.runRepo.save(waiting);
        span.setAttribute('run.status', 'waiting-approval'); span.setAttribute('run.latency_ms', latency.totalMs); span.end();
        const pending = error.checkpoint.pendingCalls[0];
        const requested = [...trace].reverse().find((event) => event.kind === 'approval-requested');
        return {
          runId, mode, purpose,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(model !== undefined ? { model } : {}),
          ...(started.agent !== undefined ? { agent: started.agent } : {}),
          ...(started.tool !== undefined ? { tool: started.tool } : {}),
          status: 'waiting-approval',
          checkpoint: {
            prompt: error.checkpoint.prompt,
            expiresAt: error.checkpoint.expiresAt,
            tool: pending?.name ?? '',
            sideEffect: requested?.kind === 'approval-requested' ? requested.sideEffect : 'write',
          },
          response: error.checkpoint.prompt,
          usage: error.usage,
          latency,
          trace,
        };
      }
      /**
       * 中断は「壊れた」のではなく「利用者が止めた」。Runは failed のまま残す（既存の状態遷移を
       * 増やさない）が、失敗理由を専用コードにして履歴から中断だと読み取れるようにする。
       * abort後は握り潰した副次的な失敗（接続断など）も混ざるため、signal を最優先で見る。
       */
      const failure = signal?.aborted === true ? { code: RUN_CANCELLED_CODE, message: RUN_CANCELLED_MESSAGE } : failureFrom(error);
      trace.push({ sequence: trace.length + 1, kind: 'error', code: failure.code, message: failure.message });
      const latency = this.latency(startedTick, timing, baseTotalMs);
      const failed = failRun(started, { trace: sanitizeRunTrace(trace), failure, latency, completedAt: this.now().toISOString() });
      await this.runRepo.save(failed);
      await recordRunMetricSafely(this.observability?.operations, failed, this.observability?.logger);
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
    if ((images?.length ?? 0) > 0 && !this.model.capabilities().includes('vision')) {
      throw new AgentRunError('configured model provider does not support image input');
    }
    const loop = await this.prepareLoop(tools, trace, timing, ctx, signal, agent, output);
    const messages: ModelRequestMessage[] = [
      { role: 'system', content: systemPrompt },
      // v16: 会話履歴（シナリオ検証の複数ターン）を system 直後へ注入する（後方互換: 省略時は従来どおり）。
      ...(history ?? []).map((entry): ModelMessage => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userContent(userMessage, images) },
    ];
    return this.runLoop(loop, {
      messages,
      executed: [],
      usage: {},
      remainingHistory: history?.length ?? 0,
      startStep: 1,
      structuredRepairs: 0,
      toolArgumentRepairs: 0,
    });
  }

  /**
   * ループの不変部分（ガード・ランタイム・ツール定義）を1回だけ組み立てる。
   * 新規実行と承認後の再開の両方が同じ文脈でループへ入れるように切り出してある。
   */
  private async prepareLoop(
    tools: readonly Tool[],
    trace: RunTraceEvent[],
    timing: RunTiming,
    ctx: NodeContext,
    signal: AbortSignal | undefined,
    agent: RunRecord['agent'] | undefined,
    output: StructuredOutputDefinition | undefined,
  ): Promise<LoopContext> {
    for (const tool of tools) {
      if (tool.sideEffect !== 'read-only' && tool.sideEffect !== 'session-write') {
        throw new UnsafeToolError(`Agent preview refuses ${tool.sideEffect} tool '${tool.metadata.internalId}'`);
      }
    }
    // ハーネス未設定Agent（および未保存プレビュー）は既定値＝従来動作。明示設定Agentだけ上限を広げる。
    const harness = ctx.harness ?? DEFAULT_AGENT_RUNTIME_HARNESS;
    const maxModelRounds = ctx.harness === undefined ? MAX_MODEL_ROUNDS : HARNESS_MAX_MODEL_ROUNDS;
    const maxToolCalls = ctx.harness === undefined ? MAX_TOOL_CALLS : HARNESS_MAX_TOOL_CALLS;
    const hasCallables = harness.functionInvocation && (tools.length > 0 || ctx.subAgents.length > 0);
    if (hasCallables && !this.model.capabilities().includes('tool-calling')) {
      throw new AgentRunError('configured model provider does not support tool-calling');
    }
    if (output !== undefined && !this.model.capabilities().includes('structured-output')) {
      throw new AgentRunError('configured model provider does not support structured output');
    }

    const runtime = new AgentRuntimeHarnessRuntime({
      harness, scope: ctx.scope, runId: ctx.runId,
      ...(agent?.internalId === undefined ? {} : { agentId: agent.internalId }),
      ...(ctx.session === undefined ? {} : { session: ctx.session }),
      ...(this.artifacts === undefined ? {} : { artifacts: this.artifacts }),
      ...(this.wiki === undefined ? {} : { wiki: this.wiki }),
      ...(this.webSearch === undefined ? {} : { webSearch: this.webSearch }),
      now: this.now,
    });
    await runtime.prepare();

    const toolDefinitions = tools.map(toolToModelDefinition);
    // functionInvocation:false はツール自動実行ループそのものを無効化する（モデルへ何も渡さない）。
    const builtInDefinitions = harness.functionInvocation
      ? [...toolDefinitions, ...ctx.subAgents.map(subAgentToolDefinition), ...this.workspaceDefinitions(ctx, tools), ...runtime.definitions()]
      : [];
    // MCPツールはRun開始時に一度だけ解決する（承認後の再開もこの経路を通るので同じ集合が再構築される）。
    // 既存ツール名は予約語として渡し、マングル名がそれらと衝突しないようにする。
    const mcp = harness.functionInvocation
      ? await this.resolveMcpToolset(ctx, builtInDefinitions.map((definition) => definition.name), signal)
      : McpToolset.empty();
    const definitions = harness.functionInvocation ? [...builtInDefinitions, ...mcp.definitions()] : [];
    /**
     * 承認ゲートの発火条件。
     * - Agentが harness.toolApproval を明示 opt-in している
     * - 対話相手がいる実行（POST /runs）である。Harness/Factory/シナリオ検証の自動実行では停止するとデッドロックする
     * - 委譲の子Run（depth > 0）ではない。承認は親の対話文脈でしか返せない
     * ランタイムツール（todos_* / memory_* / web_search / workspace_*）とサブエージェント委譲（ask_*）は
     * ETL Toolエンティティではなく副作用がWiki/Session Artifactに閉じているため、常に自動承認とする。
     */
    const approvalGate = harness.toolApproval && ctx.interactive === true && ctx.depth === 0 && agent?.version !== undefined;
    return {
      harness, maxModelRounds, maxToolCalls, runtime, mcp, tools, toolDefinitions, definitions,
      ...(output === undefined ? {} : { output, responseFormat: toModelResponseFormat(output) }),
      ...(agent === undefined ? {} : { agent }),
      ctx, trace, timing, ...(signal === undefined ? {} : { signal }), approvalGate,
    };
  }

  /**
   * Agentが参照するMCPサーバーのツールを解決する。
   * 両ポートが注入されていないRun（未保存プレビュー・テスト配線）は空集合で従来動作のまま。
   */
  private async resolveMcpToolset(ctx: NodeContext, reservedNames: readonly string[], signal?: AbortSignal): Promise<McpToolset> {
    const serverNames = ctx.mcpServers ?? [];
    const servers = this.mcpServers;
    const client = this.mcpClient;
    if (serverNames.length === 0 || servers === undefined || client === undefined) return McpToolset.empty();
    return McpToolset.resolve({ scope: ctx.scope, serverNames, servers, client, reservedNames, ...(signal === undefined ? {} : { signal }) });
  }

  /**
   * モデル往復とツール実行のループ本体。`state.startStep` / `state.pending` により、
   * 承認待ちcheckpointからの再開でも同じコードパスを通る。
   */
  private async runLoop(loop: LoopContext, state: LoopState): Promise<RunResult> {
    const { ctx, trace, timing } = loop;
    for (let step = state.startStep; step <= loop.maxModelRounds; step += 1) {
      // 再開時: この往復で未実行だったツール呼び出しを先に片づけ、次の往復から通常ループへ戻る。
      const pending = state.pending;
      if (pending !== undefined) {
        state.pending = undefined;
        await this.executeCalls(loop, state, pending, step);
        continue;
      }
      if (loop.harness.compaction) {
        const compaction = compactModelMessages(state.messages, { budgetChars: HARNESS_COMPACTION_BUDGET_CHARS, historyCount: state.remainingHistory });
        state.remainingHistory = compaction.remainingHistoryCount;
        if (compaction.compacted) {
          state.messages.splice(0, state.messages.length, ...compaction.messages);
          trace.push({ sequence: trace.length + 1, kind: 'compaction', beforeChars: compaction.beforeChars, afterChars: compaction.afterChars });
        }
      }
      // ツリー共有バジェット: model round 発行前に減算し、枯渇でこのノードのRunを失敗させる。
      if ((ctx.budget.remainingModelRounds -= 1) < 0) {
        throw new AgentRunError('run budget exhausted: model rounds');
      }
      trace.push({ sequence: trace.length + 1, kind: 'model-request', step, toolNames: loop.definitions.map((definition) => definition.name) });
      const completion = await this.completeModel({
        messages: state.messages,
        ...(loop.definitions.length > 0 ? { tools: loop.definitions } : {}),
        ...(loop.responseFormat !== undefined ? { responseFormat: loop.responseFormat } : {}),
      }, timing, loop.signal);
      state.usage = addUsage(state.usage, completion.usage);
      const calls = completion.message.toolCalls ?? [];
      if (completion.finishReason === 'tool_calls' && calls.length === 0) {
        throw new AgentRunError('model reported tool_calls without a tool call');
      }
      if (calls.length === 0) {
        const content = completion.message.content ?? '';
        let structuredResponse: JsonObject | undefined;
        if (loop.output !== undefined) {
          try { structuredResponse = validateStructuredResponse(loop.output, content); }
          catch (error) {
            // 1回の不正JSONでRunを落とさない: 何が違ったかを添えて、同じ往復予算の中で作り直させる。
            if (!this.canRepairStructuredOutput(loop, state, step)) throw error;
            state.structuredRepairs += 1;
            const detail = error instanceof Error ? error.message : String(error);
            trace.push({ sequence: trace.length + 1, kind: 'error', code: 'AGENT_RUN', message: `${detail} (retrying ${state.structuredRepairs}/${MAX_STRUCTURED_OUTPUT_REPAIRS})` });
            state.messages.push({ role: 'assistant', content });
            state.messages.push({ role: 'user', content: structuredRepairInstruction(loop.output, detail) });
            continue;
          }
        }
        trace.push({ sequence: trace.length + 1, kind: 'model-response', content });
        const last = state.executed.at(-1);
        return {
          ...(loop.agent !== undefined ? { agent: loop.agent } : {}),
          ...(last !== undefined ? { tool: last, tools: state.executed } : {}),
          response: content,
          ...(structuredResponse !== undefined ? { structuredResponse } : {}),
          usage: state.usage,
        };
      }
      // functionInvocation:false ではツールを一切提示していないため、ツール呼び出しはfail closedで拒否する。
      if (!loop.harness.functionInvocation) {
        throw new AgentRunError('model requested a tool call but function invocation is disabled for this agent');
      }
      if (state.executed.length + calls.length > loop.maxToolCalls) {
        throw new AgentRunError(`tool call limit exceeded: maximum ${loop.maxToolCalls}`);
      }

      state.messages.push({ role: 'assistant', content: completion.message.content, toolCalls: calls });
      await this.executeCalls(loop, state, calls, step);
    }
    throw new AgentRunError(`model round limit exceeded: maximum ${loop.maxModelRounds}`);
  }

  /**
   * 構造化出力の修復往復を発行してよいか。
   * 残り往復が無いのに修復すると「構造化出力が壊れている」ではなく「往復上限に達した」という
   * 分かりにくい失敗にすり替わるので、最終往復と予算切れでは修復せず元のエラーを見せる。
   */
  private canRepairStructuredOutput(loop: LoopContext, state: LoopState, step: number): boolean {
    return state.structuredRepairs < MAX_STRUCTURED_OUTPUT_REPAIRS
      && step < loop.maxModelRounds
      && loop.ctx.budget.remainingModelRounds > 0;
  }

  /** 1往復ぶんのツール呼び出しを順に実行する。承認が必要なETL Toolに当たったら AgentRunPause を投げる。 */
  private async executeCalls(loop: LoopContext, state: LoopState, calls: readonly ModelToolCall[], step: number): Promise<void> {
    const { ctx, trace, timing } = loop;
    for (const [index, call] of calls.entries()) {
      const sub = ctx.subAgents.find((candidate) => candidate.toolName === call.name);
      const workspace = sub === undefined && this.isWorkspaceTool(call.name, ctx, loop.tools);
      const harnessTool = sub === undefined && !workspace && loop.runtime.isHarnessTool(call.name);
      const mcpTool = sub === undefined && !workspace && !harnessTool ? loop.mcp.find(call.name) : undefined;
      let tool: Tool | undefined;
      if (mcpTool !== undefined) {
        /**
         * MCPツールは外部プロセス／外部サービスで実行されるため、副作用がWiki/Session Artifactに
         * 閉じている組み込みランタイムツール（todos_* / memory_* / web_search / workspace_*）とは扱いが違い、
         * ETLの非read-onlyツールと同じく承認ゲートの対象にする。
         */
        if (loop.approvalGate && state.approvedCallId !== call.id) {
          throw this.pauseForApproval(loop, state, calls.slice(index), step, call, {
            sideEffect: 'external-action',
            prompt: `Approval required: MCP tool '${mcpTool.server}/${mcpTool.originalToolName}' runs on an external MCP server. Arguments: ${summarize(JSON.stringify(call.arguments) ?? '{}', 400)}`,
          });
        }
      } else if (sub === undefined && !workspace && !harnessTool) {
        const selectedIndex = loop.toolDefinitions.findIndex((definition) => definition.name === call.name);
        tool = selectedIndex < 0 ? undefined : loop.tools[selectedIndex];
        if (tool === undefined) throw new AgentRunError(unknownToolMessage(call.name));
        // バジェット減算より前に判定する: 停止した呼び出しはまだ1件も消費していない。
        if (loop.approvalGate && tool.sideEffect !== 'read-only' && state.approvedCallId !== call.id) {
          throw this.pauseForApproval(loop, state, calls.slice(index), step, call, {
            sideEffect: tool.sideEffect,
            prompt: `Approval required: '${call.name}' (${tool.metadata.displayName}) has side effect '${tool.sideEffect}'. Arguments: ${summarize(JSON.stringify(call.arguments) ?? '{}', 400)}`,
          });
        }
      }
      state.approvedCallId = undefined;
      // ツール呼び出し（委譲含む）発行前に共有バジェットを減算する。
      if ((ctx.budget.remainingToolCalls -= 1) < 0) {
        throw new AgentRunError('run budget exhausted: tool calls');
      }
      if (sub !== undefined) {
        state.messages.push(await this.delegateTimed(sub, call, trace, timing, ctx, loop.signal));
        continue;
      }
      if (workspace) {
        state.messages.push(await this.executeWorkspaceTool(call, trace, ctx));
        continue;
      }
      if (harnessTool) {
        state.messages.push(await this.executeHarnessToolTimed(loop.runtime, call, trace, timing));
        continue;
      }
      if (mcpTool !== undefined) {
        state.messages.push(await this.executeMcpToolTimed(loop, call, trace, timing));
        continue;
      }
      const selected = tool as Tool;
      try {
        state.messages.push(await this.executeToolTimed(selected, call, trace, timing, ctx, loop.agent));
      } catch (error) {
        // 引数の作り間違いはモデル側の誤りなので、Runを落とさずツール結果として差し戻して呼び直させる。
        // スキーマ不一致など**ツール定義側**の誤り（AgentRunError）は差し戻しても直らないため対象外。
        if (!(error instanceof ToolArgumentsError) || state.toolArgumentRepairs >= MAX_TOOL_ARGUMENT_REPAIRS) throw error;
        state.toolArgumentRepairs += 1;
        trace.push({ sequence: trace.length + 1, kind: 'error', code: error.code, message: `${error.message} (retrying ${state.toolArgumentRepairs}/${MAX_TOOL_ARGUMENT_REPAIRS})` });
        state.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ error: error.message, hint: `Call '${call.name}' again with corrected arguments that match its schema.` }) });
        continue;
      }
      state.executed.push(this.toolRef(selected));
    }
  }

  /** 承認待ちcheckpointを組み立て、trace へ approval-requested を積んで制御シグナルを返す。 */
  private pauseForApproval(
    loop: LoopContext, state: LoopState, pending: readonly ModelToolCall[], step: number, call: ModelToolCall,
    request: { readonly sideEffect: SideEffect; readonly prompt: string },
  ): AgentRunPause {
    const agent = loop.agent as NonNullable<RunRecord['agent']>;
    const prompt = request.prompt;
    loop.trace.push({ sequence: loop.trace.length + 1, kind: 'approval-requested', tool: call.name, sideEffect: request.sideEffect, prompt });
    const checkpoint: RunApprovalCheckpoint = {
      kind: 'tool-approval',
      agentRef: { internalId: agent.internalId, version: agent.version as string },
      messages: toCheckpointMessages(state.messages),
      pendingCalls: pending.map(toCheckpointToolCall),
      executedToolRefs: state.executed.map((ref) => ({ internalId: ref.internalId, version: ref.version as string, ...(ref.publishName === undefined ? {} : { publishName: ref.publishName }) })),
      budget: { remainingModelRounds: loop.ctx.budget.remainingModelRounds, remainingToolCalls: loop.ctx.budget.remainingToolCalls },
      step,
      ...(loop.ctx.session === undefined ? {} : { sessionId: loop.ctx.session.id }),
      expiresAt: new Date(this.now().getTime() + INTERACTIVE_CHECKPOINT_TTL_MS).toISOString(),
      prompt,
    };
    return new AgentRunPause(checkpoint, state.usage);
  }

  /**
   * 承認待ちRunを再開する。checkpointはJSON永続化済みなので、プロセスをまたいでも再開できる。
   * approve は保留中の呼び出しを先頭（＝承認されたもの）から実行し、reject はモデルへ拒否結果を返して
   * 代替案を作らせる。どちらも同じRunId・同じtraceの続きとして確定する。
   */
  async resumeSavedRun(input: ResumeSavedRunInput, signal?: AbortSignal): Promise<AgentPreviewRun> {
    const agentRepo = this.agents;
    if (agentRepo === undefined) throw new AgentRunError('saved Agent execution is not configured');
    const stored = await this.runRepo.find(input.scope, input.runId);
    if (stored === null) throw new RunNotFoundError(`run not found: ${input.runId}`);
    const checkpoint = stored.checkpoint;
    if (stored.status !== 'waiting-approval' || checkpoint === undefined) {
      throw new AgentRunError(`run '${input.runId}' is not waiting for approval`);
    }
    if (Date.parse(checkpoint.expiresAt) <= this.now().getTime()) {
      // 期限切れは再開不可能なので、Runを failed として確定させてから呼び出し元へ返す。
      const expired = failRun(resumeRunRecord(stored), {
        trace: stored.trace,
        failure: { code: 'AGENT_RUN', message: `approval checkpoint expired at ${checkpoint.expiresAt}` },
        completedAt: this.now().toISOString(),
      });
      await this.runRepo.save(expired);
      throw new RunFailedError(input.runId, new AgentRunError(`run '${input.runId}' approval checkpoint expired at ${checkpoint.expiresAt}`));
    }

    const agent = await this.loadAgent(input.scope, checkpoint.agentRef.internalId, SemVer.parse(checkpoint.agentRef.version));
    const session = await this.resolveSession(input.scope, { internalId: agent.metadata.internalId, version: agent.metadata.version.toString() }, checkpoint.sessionId);
    /**
     * 再開経路でも、prepareLoop のガード（tool-calling / structured-output / vision）を通す前に
     * モデル設定を解決しておく。切替可能な配線の capabilities() は「最後に解決したアダプタ」の
     * 能力を返す同期契約なので、これを省くと env 既定由来の古い能力で判定してしまう。
     * 記録として残す指紋は Run 開始時のもの（stored.model）のままにする。
     */
    await this.currentModelSnapshot();
    const started = resumeRunRecord(stored);
    await this.runRepo.save(started);
    const trace: RunTraceEvent[] = [...stored.trace];
    const timing: RunTiming = { modelMs: stored.latency?.modelMs ?? 0, toolMs: stored.latency?.toolMs ?? 0 };

    return this.runWithRecord(started, trace, timing, stored.latency?.totalMs ?? 0, async (currentTrace, currentTiming, runId) => {
      // 実効副作用は再開時も fail closed で再確認する（Agent定義が更新されている可能性がある）。
      const effect = await resolveEffectiveSideEffect(input.scope, agent, { tools: this.repo, agents: agentRepo, skills: this.skills });
      if (effect !== 'read-only' && effect !== 'session-write') {
        throw new UnsafeToolError(`Agent preview refuses ${effect} effective side-effect for agent '${agent.metadata.internalId}'`);
      }
      const resolved = await resolveAgentCapabilities(input.scope, agent.skills, agent.tools, this.repo, this.skills, agent.agents, agentRepo);
      const budget: RunBudget = {
        maxDelegationDepth: DEFAULT_MAX_DELEGATION_DEPTH,
        remainingModelRounds: checkpoint.budget.remainingModelRounds,
        remainingToolCalls: checkpoint.budget.remainingToolCalls,
      };
      const ctx: NodeContext = {
        runId, scope: input.scope, mode: stored.mode, budget, depth: 0, subAgents: resolved.subAgents,
        ...(session === undefined ? {} : { session }),
        ...(agent.harness === undefined ? {} : { harness: agent.harness }),
        // 再開でも prepareLoop が同じ経路でMCPツール定義とマングル名マップを組み直す。
        ...(agent.mcpServers === undefined ? {} : { mcpServers: agent.mcpServers }),
        interactive: true,
      };
      const loop = await this.prepareLoop(resolved.tools, currentTrace, currentTiming, ctx, signal, this.agentRef(agent), agent.output);
      const state: LoopState = {
        messages: fromCheckpointMessages(checkpoint.messages),
        executed: checkpoint.executedToolRefs.map((ref) => ({ internalId: ref.internalId, version: ref.version, ...(ref.publishName === undefined ? {} : { publishName: ref.publishName }) })),
        usage: stored.usage ?? {},
        remainingHistory: 0,
        startStep: checkpoint.step,
        // 修復回数は再開ごとに数え直す（checkpointは承認の再開情報だけを持ち、修復履歴は保持しない）。
        structuredRepairs: 0,
        toolArgumentRepairs: 0,
      };
      currentTrace.push({ sequence: currentTrace.length + 1, kind: 'approval-resolved', decision: input.decision, ...(input.decidedBy === undefined ? {} : { decidedBy: input.decidedBy }) });
      if (input.decision === 'approve') {
        // 先頭の呼び出しだけが承認済み。2件目以降で再び承認対象が来たら再度停止する。
        state.pending = checkpoint.pendingCalls.map(fromCheckpointToolCall);
        state.approvedCallId = checkpoint.pendingCalls[0]?.id;
      } else {
        const reason = input.feedback?.trim() || 'rejected by user';
        for (const call of checkpoint.pendingCalls) {
          state.messages.push({ role: 'tool', content: JSON.stringify({ approved: false, reason }), toolCallId: call.id });
        }
        // 拒否した往復のモデル応答は既に消費済みなので、次の往復から続ける。
        state.startStep = checkpoint.step + 1;
      }
      return this.runLoop(loop, state);
    }, signal);
  }

  /** ランタイムハーネスの組み込みツール実行。workspace_* と同じく tool-call / tool-result をトレースへ残す。 */
  private async executeHarnessToolTimed(runtime: AgentRuntimeHarnessRuntime, call: ModelToolCall, trace: RunTraceEvent[], timing: RunTiming): Promise<ModelMessage> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'tool.execute', { 'tool.name': call.name, 'tool.kind': 'runtime-harness' }, this.observability?.logger); let failure: unknown;
    try {
      trace.push({ sequence: trace.length + 1, kind: 'tool-call', name: call.name, arguments: call.arguments });
      const result = await runtime.execute(call);
      trace.push({ sequence: trace.length + 1, kind: 'tool-result', name: call.name, terminalId: 'runtime-harness', nodes: [], outputPreview: result.preview });
      return { role: 'tool', content: result.content, toolCallId: call.id };
    }
    catch (error) { failure = error; throw error; }
    finally { timing.toolMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  /**
   * MCPツール実行。tool-call / tool-result は他のランタイムツールと同じ形でトレースへ残す。
   * サーバー側の実行エラー（isError:true）も接続失敗も、内容をツール結果としてモデルへ返しRunを続ける。
   */
  private async executeMcpToolTimed(loop: LoopContext, call: ModelToolCall, trace: RunTraceEvent[], timing: RunTiming): Promise<ModelMessage> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'tool.execute', { 'tool.name': call.name, 'tool.kind': 'mcp' }, this.observability?.logger); let failure: unknown;
    try {
      trace.push({ sequence: trace.length + 1, kind: 'tool-call', name: call.name, arguments: call.arguments });
      const result = await loop.mcp.execute(call, loop.signal);
      trace.push({ sequence: trace.length + 1, kind: 'tool-result', name: call.name, terminalId: 'mcp', nodes: [], outputPreview: result.preview });
      return { role: 'tool', content: result.content, toolCallId: call.id };
    }
    catch (error) { failure = error; throw error; }
    finally { timing.toolMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private async completeModel(request: Parameters<ModelProviderPort['complete']>[0], timing: RunTiming, signal?: AbortSignal): Promise<ModelCompletion> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'model.complete', { 'model.provider': this.observability?.model?.provider ?? 'unknown', 'model.name': this.observability?.model?.model ?? 'unknown' }, this.observability?.logger); let failure: unknown;
    try { return await this.model.complete(request, signal); }
    catch (error) { failure = error; throw error; }
    finally { timing.modelMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private async delegateTimed(sub: ResolvedSubAgent, call: ModelToolCall, trace: RunTraceEvent[], timing: RunTiming, ctx: NodeContext, signal?: AbortSignal): Promise<ModelMessage> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'tool.execute', { 'tool.name': call.name, 'tool.kind': 'agent-delegation' }, this.observability?.logger); let failure: unknown;
    try { return await this.delegate(sub, call, trace, ctx, signal); }
    catch (error) { failure = error; throw error; }
    finally { timing.toolMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private async executeToolTimed(tool: Tool, call: ModelToolCall, trace: RunTraceEvent[], timing: RunTiming, ctx: NodeContext, agent?: RunRecord['agent']): Promise<ModelMessage> {
    const started = this.monotonicNow(); const span = safeStartSpan(this.observability?.telemetry, 'tool.execute', { 'tool.name': call.name, 'tool.kind': 'etl' }, this.observability?.logger); let failure: unknown;
    try { return await this.executeTool(tool, call, trace, ctx, agent); }
    catch (error) { failure = error; throw error; }
    finally { timing.toolMs += Math.max(0, this.monotonicNow() - started); span.end(failure); }
  }

  private monotonicNow(): number { return this.observability?.monotonicNow?.() ?? performance.now(); }
  /** baseTotalMs は承認待ちを挟んだ再開で、停止前の経過時間を通算するために足す。 */
  private latency(started: number, timing: RunTiming, baseTotalMs = 0): RunLatencyBreakdown {
    return { totalMs: baseTotalMs + Math.max(0, this.monotonicNow() - started), modelMs: timing.modelMs, toolMs: timing.toolMs };
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
    // fileMemory 有効時は専用の記憶Wikiも自動想起の検索対象へ加える。
    if (agent.harness?.fileMemory === true) allowed.add(agentMemoryWikiId(agent.metadata.internalId));
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

/**
 * 提示していないツール名を呼ばれたときのメッセージ。
 * 承認後の再開でMCPサーバーへ再接続できないと checkpoint に残った `mcp__*` 名は解決できないので、
 * 「未知のツール」ではなく原因が分かる文言でRunを失敗させる。
 */
function unknownToolMessage(name: string): string {
  return isMcpToolName(name)
    ? `MCP tool '${name}' is unavailable: its MCP server could not be resolved for this run`
    : `model requested unknown tool: ${name}`;
}

/**
 * 構造化出力の修復依頼文。**何が悪かったか**と**期待する形**の両方を渡す
 * （エラー文だけだとモデルは同じ形を出し直しがち）。
 */
function structuredRepairInstruction(output: StructuredOutputDefinition, detail: string): string {
  const fields = output.fields
    .map((field) => `- ${field.name}: ${field.type}${field.required ? ' (required)' : ' (optional)'}${field.description === undefined ? '' : ` — ${field.description}`}`)
    .join('\n');
  return [
    `Your previous reply was rejected: ${detail}`,
    `Reply again with a single JSON object named '${output.name}'. Output raw JSON only: no prose, no markdown code fence.`,
    'Use exactly these fields and nothing else:',
    fields,
  ].join('\n');
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
