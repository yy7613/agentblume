/**
 * application層: Agentが参照するMCPサーバーのツールを、1 Runぶんのモデルツールへ束ねる。
 *
 * `runtime-harness.ts` と同じ形（definitions生成 / isXxxTool判定 / execute）で、
 * `run-agent-preview.ts` のループへは最小のフックだけを差し込む。
 *
 * 方針:
 * - Run開始時に一度だけ解決する。存在しない・disabled のサーバー、listTools に失敗した
 *   サーバーはスキップして残りで続行する（外部依存の不調でRunを落とさない）。
 * - ツール名は `mcp__<server>__<tool>` をモデルAPIが許す文字種へ正規化して使う。
 *   衝突（既存ETL/ランタイム/ask_* ツール名やサーバー間の重複）は数値サフィックスで避ける。
 * - MCPツールは外部プロセス／外部サービスで実行されるため、組み込みランタイムツールと違い
 *   ETLの非read-onlyツールと同じ承認ゲートの対象になる（判定は run-agent-preview 側）。
 */
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { McpClientError, type McpClientPort, type McpToolDescriptor } from '../mcp/mcp-client';
import type { JsonObject, JsonSchemaObject, JsonSchemaProperty, ModelToolCall, ModelToolDefinition } from '../model/model-provider';
import { AgentRunError } from './errors';

/** マングル済みMCPツール名の接頭辞。再開時の診断（未解決のMCPツール判定）にも使う。 */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';
/** モデルAPIが受け付けるツール名の最大長。 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;
/** モデルへ渡すdescriptionの上限（文脈を食い潰さないためにクリップする）。 */
export const MCP_TOOL_DESCRIPTION_MAX_CHARS = 500;

/** `/^[A-Za-z0-9_-]{1,64}$/` に収めるため、許可外の文字を `_` へ置換する。 */
const DISALLOWED_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** 同名衝突時に試す数値サフィックスの上限（現実には到達しないが無限ループを避ける）。 */
const MAX_NAME_SUFFIX = 1_000;

/** マングル名から実サーバー・実ツールへの対応。 */
export interface McpBoundTool {
  /** モデルへ提示するマングル済み名。 */
  readonly name: string;
  readonly server: string;
  readonly originalToolName: string;
  readonly config: McpServerConfig;
}

export interface McpToolResult {
  readonly content: string;
  /** サーバーがツール実行エラーとして返したか、または接続に失敗したか。 */
  readonly isError: boolean;
  readonly preview: readonly Readonly<Record<string, unknown>>[];
}

export interface ResolveMcpToolsetOptions {
  readonly scope: TenantScope;
  /** Agentが参照するMCPサーバー名（重複は無視する）。 */
  readonly serverNames: readonly string[];
  readonly servers: McpServerRepository;
  readonly client: McpClientPort;
  /** 既に使われているツール名（ETL / workspace_* / ランタイム / ask_*）。衝突回避に使う。 */
  readonly reservedNames?: readonly string[];
  readonly signal?: AbortSignal;
}

/** 名前が（マングル規則上）MCPツール由来かどうか。解決できなかったときの診断に使う。 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_NAME_PREFIX);
}

/**
 * `mcp__<server>__<tool>` を `/^[A-Za-z0-9_-]{1,64}$/` に正規化する純関数。
 *
 * 1. 許可外の文字は `_` へ置換する。
 * 2. 64字を超える部分は切り詰める。
 * 3. `taken` と衝突するなら `_2`, `_3`, … を末尾へ付ける（64字に収まるよう本体を詰める）。
 *
 * 衝突を解消できなかったときだけ undefined を返す（呼び出し側はそのツールをスキップする）。
 */
export function mangleMcpToolName(server: string, toolName: string, taken: ReadonlySet<string>): string | undefined {
  const sanitized = `${MCP_TOOL_NAME_PREFIX}${server}__${toolName}`.replace(DISALLOWED_NAME_CHARS, '_');
  const base = sanitized.slice(0, MCP_TOOL_NAME_MAX_LENGTH);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    const tail = `_${suffix}`;
    const candidate = `${base.slice(0, MCP_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
}

/** 1 Run ぶんの、解決済みMCPツール集合。 */
export class McpToolset {
  private constructor(
    private readonly client: McpClientPort | undefined,
    private readonly tools: ReadonlyMap<string, McpBoundTool>,
    private readonly defs: readonly ModelToolDefinition[],
  ) {}

  /** MCPを使わないRun（未設定Agent・ポート未注入・functionInvocation:false）用の空集合。 */
  static empty(): McpToolset {
    return new McpToolset(undefined, new Map(), []);
  }

  /**
   * 参照サーバーを解決してツール定義を組み立てる。
   * 存在しない／disabled のサーバーと listTools に失敗したサーバーはスキップする。
   */
  static async resolve(options: ResolveMcpToolsetOptions): Promise<McpToolset> {
    const requested = [...new Set(options.serverNames)];
    const found = await Promise.all(requested.map((name) => options.servers.find(options.scope, name)));
    // 未登録・disabled はスキップする: Agent定義を保ったままサーバーを一時停止できるようにする。
    const configs = found.filter((config): config is McpServerConfig => config !== null && !config.disabled);
    // listTools は並行に投げ、落ちたサーバーだけを除いて残りで続行する。
    const listed = await Promise.all(configs.map(async (config) => {
      try { return { config, tools: await options.client.listTools(config, options.signal) }; }
      catch (error) {
        if (error instanceof McpClientError) return { config, tools: [] as readonly McpToolDescriptor[] };
        throw error;
      }
    }));

    const taken = new Set(options.reservedNames ?? []);
    const tools = new Map<string, McpBoundTool>();
    const defs: ModelToolDefinition[] = [];
    for (const { config, tools: descriptors } of listed) {
      for (const descriptor of descriptors) {
        if (typeof descriptor?.name !== 'string' || descriptor.name.trim() === '') continue;
        // inputSchema が object スキーマでないツールはスキップする。
        // 推測でスキーマを捏造するとモデルが誤った引数を組み立てるため、提示しない方が安全。
        const parameters = toJsonSchemaObject(descriptor.inputSchema);
        if (parameters === undefined) continue;
        const name = mangleMcpToolName(config.name, descriptor.name, taken);
        if (name === undefined) continue;
        taken.add(name);
        tools.set(name, { name, server: config.name, originalToolName: descriptor.name, config });
        defs.push({ name, description: toolDescription(config.name, descriptor), parameters });
      }
    }
    return new McpToolset(options.client, tools, defs);
  }

  /** モデルへ渡すMCPツール定義（解決できたサーバーのぶんだけ）。 */
  definitions(): readonly ModelToolDefinition[] { return this.defs; }

  isMcpTool(name: string): boolean { return this.tools.has(name); }

  find(name: string): McpBoundTool | undefined { return this.tools.get(name); }

  /**
   * MCPツールを実行する。
   * `isError:true` は例外にせずサーバーの返答をそのままモデルへ渡し（モデルが再試行できる）、
   * 接続レベルの失敗（McpClientError）も「利用不可」という結果としてRunを継続させる。
   */
  async execute(call: ModelToolCall, signal?: AbortSignal): Promise<McpToolResult> {
    const bound = this.tools.get(call.name);
    const client = this.client;
    if (bound === undefined || client === undefined) throw new AgentRunError(`unknown MCP tool: ${call.name}`);
    try {
      const result = await client.callTool(bound.config, bound.originalToolName, call.arguments, signal);
      return {
        content: result.content,
        isError: result.isError,
        preview: [{ server: bound.server, tool: bound.originalToolName, isError: result.isError }],
      };
    } catch (error) {
      if (!(error instanceof McpClientError)) throw error;
      return {
        content: `MCP server '${bound.server}' unavailable: ${error.message}`,
        isError: true,
        preview: [{ server: bound.server, tool: bound.originalToolName, unavailable: true }],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * MCPの inputSchema（任意のJSON）を ModelToolDefinition.parameters へ橋渡しする。
 * `type:'object'` でないスキーマは扱えないので undefined を返す（呼び出し側でスキップ）。
 */
function toJsonSchemaObject(schema: JsonObject | undefined): JsonSchemaObject | undefined {
  if (!isPlainObject(schema) || schema['type'] !== 'object') return undefined;
  const properties = schema['properties'];
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((item): item is string => typeof item === 'string')
    : [];
  const additionalProperties = schema['additionalProperties'];
  return {
    type: 'object',
    properties: isPlainObject(properties) ? properties as Readonly<Record<string, JsonSchemaProperty>> : {},
    ...(required.length > 0 ? { required } : {}),
    ...(typeof additionalProperties === 'boolean' ? { additionalProperties } : {}),
  };
}

function toolDescription(server: string, descriptor: McpToolDescriptor): string {
  const provided = descriptor.description?.trim() ?? '';
  const text = provided === '' ? `Tool '${descriptor.name}' provided by MCP server '${server}'.` : provided;
  return text.length > MCP_TOOL_DESCRIPTION_MAX_CHARS ? `${text.slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS - 1)}…` : text;
}
