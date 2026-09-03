/**
 * アプリ層: Agent Tool 呼び出しのプリフライト診断。
 *
 * 「作った Tool がエージェントから呼び出せない」とき、原因は参照切れ・名前衝突・スキーマ
 * 不整合・データソース欠落・モデル能力・MCP 設定など複数の層に分かれて潜むが、実行時には
 * **最初に踏んだ1つ**が Run 失敗の1行になって返るだけで全体像が見えない。ここでは Agent 単位の
 * 検査（参照解決・版曖昧性・委譲ツール名・function 名の一意性・MCP サーバー・モデル能力・
 * ハーネス前提）を行い、Tool 単位の検査は `DiagnoseToolUseCase` へ委譲する。検証ロジックは
 * 実行側と共有し、二重実装を作らない — 診断が ok の項目は、実行時にも同じ理由では落ちない。
 *
 * 検査は静的（モデル呼び出しなし・副作用なし）。`modelCapabilities` は設定の解決だけを行い、
 * 補完は呼ばない。
 */
import type { Agent } from '../../domain/agent/agent';
import { DEFAULT_AGENT_RUNTIME_HARNESS, subAgentToolName } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { EtlEngine } from '../etl/engine';
import type { ModelCapability } from '../model/model-provider';
import { DiagnoseToolUseCase, error, messageOf, ok, warning, worst } from '../tool/diagnose-tool';
import type { DiagnosticCheck, DiagnosticStatus, ToolCheckId, ToolDiagnostics } from '../tool/diagnose-tool';
import { buildAgentAggregate, type SaveAgentInput } from './save-agent';
import { isValidFunctionName } from './tool-schema';

// Tool 単位の型は diagnose-tool.ts へ移した。既存の import 元を壊さないよう再公開する。
export type { DiagnosticCheck, DiagnosticStatus, ToolCheckId, ToolDiagnostics } from '../tool/diagnose-tool';

/** Agent単位の検査項目。 */
export type AgentCheckId =
  | 'skills'          // Skill 参照の解決
  | 'tool-versions'   // 直付け + Skill 由来の同一 Tool の版曖昧性
  | 'sub-agents'      // サブエージェント参照の解決と委譲ツール名（ask_*）の衝突・形式
  | 'function-names'  // LLMへ公開する function 名の一意性
  | 'mcp-servers'     // 参照 MCP サーバーの存在と有効/無効
  | 'model'           // 設定中モデルの能力（tool-calling / structured output）
  | 'harness';        // ハーネス機能の前提（検索プロバイダ・Wiki 参照）

export interface AgentDiagnostics {
  readonly agent: { readonly internalId: string; readonly version: string };
  readonly status: DiagnosticStatus;
  readonly checks: readonly DiagnosticCheck<AgentCheckId>[];
  readonly tools: readonly ToolDiagnostics[];
}

/**
 * 追加の依存。位置引数の既存 5 つは変えず、後ろの options で受ける。
 * どれも省略可で、省略した検査は「配線されていない」として ok（model は項目自体を出さない）。
 */
export interface DiagnoseAgentToolsOptions {
  /** Tool 単位の診断。省略時は engine / resolveDataSources から組み立てる。 */
  readonly diagnoseTool?: DiagnoseToolUseCase;
  readonly mcpServers?: McpServerRepository;
  /**
   * 設定中モデルの能力を解決する。切替可能な配線では保存済み設定を解決してから capabilities() を
   * 読む必要がある（同期契約は「最後に解決したアダプタ」の能力を返す）ため非同期で受ける。
   */
  readonly modelCapabilities?: () => Promise<readonly ModelCapability[]>;
  /** web_search ツールを提供できる検索プロバイダが1つ以上あるか。 */
  readonly webSearchConfigured?: () => boolean;
}

interface EffectiveToolRef {
  readonly internalId: string;
  readonly version: SemVer;
  readonly source: 'direct' | 'skill';
  readonly skillId?: string;
}

export class DiagnoseAgentToolsUseCase {
  private readonly diagnoseTool: DiagnoseToolUseCase;

  constructor(
    private readonly tools: ToolRepository,
    engine: EtlEngine,
    private readonly skills?: SkillRepository,
    private readonly agents?: AgentRepository,
    resolveDataSources?: ResolveDataSourceGraphUseCase,
    private readonly options: DiagnoseAgentToolsOptions = {},
  ) {
    this.diagnoseTool = options.diagnoseTool ?? new DiagnoseToolUseCase(engine, resolveDataSources);
  }

  async execute(scope: TenantScope, agent: Agent): Promise<AgentDiagnostics> {
    const agentChecks: DiagnosticCheck<AgentCheckId>[] = [];

    // 1. Skill 参照の解決（実行時: resolveAgentCapabilities の Skill ロードで即失敗する箇所）。
    const { skillToolRefs, skillIssues } = await this.loadSkillToolRefs(scope, agent);
    agentChecks.push(skillIssues.length === 0 ? ok('skills') : error('skills', skillIssues.join('; ')));

    // 2. 直付け + Skill 由来の実効 Tool 集合と、同一 Tool の版曖昧性（実行時: ambiguous tool versions）。
    const { effective, ambiguous } = collectEffectiveRefs(agent, skillToolRefs);
    agentChecks.push(ambiguous.length === 0 ? ok('tool-versions') : error('tool-versions', ambiguous.join('; ')));

    // 3. Tool 単位の診断。
    const toolDiagnostics: ToolDiagnostics[] = [];
    const loadedTools: Tool[] = [];
    for (const ref of effective) {
      const { diagnostics, tool } = await this.diagnoseToolRef(scope, ref);
      toolDiagnostics.push(diagnostics);
      if (tool !== undefined) loadedTools.push(tool);
    }

    // 4. サブエージェント参照と委譲ツール名（実行時: resolveAgentCapabilities と同じ規則）。
    const { askNames, subAgentIssues } = await this.resolveSubAgents(scope, agent, loadedTools);
    agentChecks.push(subAgentIssues.length === 0 ? ok('sub-agents') : error('sub-agents', subAgentIssues.join('; ')));

    // 5. LLMへ公開する function 名の一意性。重複すると後の Tool は選択経路上**永久に届かない**
    //    （実行ループは名前の最初の一致で Tool を引くため）。
    const duplicates = duplicateFunctionNames(toolDiagnostics, askNames);
    agentChecks.push(duplicates.length === 0
      ? ok('function-names')
      : error('function-names', `duplicate function name(s): ${duplicates.join(', ')} — later tools with the same name are unreachable`));

    // 6. MCP サーバー参照。実行時は未登録・disabled を黙ってスキップするので、ここで初めて見える。
    agentChecks.push(await this.checkMcpServers(scope, agent));

    // 7. 設定中モデルの能力（実行時: prepareLoop のガードと同じ2メッセージ）。配線が無ければ項目を出さない。
    if (this.options.modelCapabilities !== undefined) {
      agentChecks.push(await this.checkModel(agent, effective.length));
    }

    // 8. ハーネス機能の前提。満たさなくても Run は失敗しないが、期待したツールが提示されない。
    agentChecks.push(this.checkHarness(agent));

    const status = worst([...agentChecks, ...toolDiagnostics.flatMap((tool) => tool.checks)].map((check) => check.status));
    return {
      agent: { internalId: agent.metadata.internalId, version: agent.metadata.version.toString() },
      status,
      checks: agentChecks,
      tools: toolDiagnostics,
    };
  }

  private async loadSkillToolRefs(scope: TenantScope, agent: Agent): Promise<{ skillToolRefs: EffectiveToolRef[]; skillIssues: string[] }> {
    const skillToolRefs: EffectiveToolRef[] = [];
    const skillIssues: string[] = [];
    for (const ref of agent.skills) {
      if (this.skills === undefined) { skillIssues.push('Skill repository is not configured'); break; }
      const skill = await this.skills.findVersion(scope, ref.internalId, ref.version);
      if (skill === null) { skillIssues.push(`referenced skill not found: ${ref.internalId}@${ref.version.toString()}`); continue; }
      for (const toolRef of skill.tools) {
        skillToolRefs.push({ internalId: toolRef.internalId, version: toolRef.version, source: 'skill', skillId: ref.internalId });
      }
    }
    return { skillToolRefs, skillIssues };
  }

  private async resolveSubAgents(scope: TenantScope, agent: Agent, loadedTools: readonly Tool[]): Promise<{ askNames: string[]; subAgentIssues: string[] }> {
    const askNames: string[] = [];
    const subAgentIssues: string[] = [];
    // 実行時と同じ衝突判定: Tool の publishName 集合に対して ask_{publishName} を照合する。
    const takenToolNames = new Set(loadedTools.map((tool) => tool.metadata.publishName));
    for (const ref of agent.agents) {
      if (this.agents === undefined) { subAgentIssues.push('Agent repository is not configured'); break; }
      const sub = await this.agents.findVersion(scope, ref.internalId, ref.version);
      if (sub === null) { subAgentIssues.push(`referenced sub-agent not found: ${ref.internalId}@${ref.version.toString()}`); continue; }
      const toolName = subAgentToolName(sub.metadata.publishName);
      if (takenToolNames.has(toolName)) {
        subAgentIssues.push(`sub-agent tool name collides with an existing tool or sub-agent: ${toolName}`);
        continue;
      }
      takenToolNames.add(toolName);
      // publishName は function 名の形式で検証されずに保存できる。ask_ 名がモデルへ渡せない形なら
      // 委譲ツールは提示できない（Tool 側の function-definition と同じ規則）。
      if (!isValidFunctionName(toolName)) {
        subAgentIssues.push(`sub-agent tool name is not a valid function name: ${toolName}`);
        continue;
      }
      askNames.push(toolName);
    }
    return { askNames, subAgentIssues };
  }

  /** 参照を解決し（resolved 検査）、実体の検査は DiagnoseToolUseCase に委ねる。 */
  private async diagnoseToolRef(scope: TenantScope, ref: EffectiveToolRef): Promise<{ diagnostics: ToolDiagnostics; tool?: Tool }> {
    const base = { internalId: ref.internalId, version: ref.version.toString(), source: ref.source, ...(ref.skillId === undefined ? {} : { skillId: ref.skillId }) };

    const tool = await this.tools.findVersion(scope, ref.internalId, ref.version);
    if (tool === null) {
      const checks: DiagnosticCheck<ToolCheckId>[] = [error('resolved', `referenced tool not found: ${ref.internalId}@${ref.version.toString()}`)];
      return { diagnostics: { ...base, status: 'error', checks } };
    }

    const result = await this.diagnoseTool.execute(scope, tool);
    return {
      diagnostics: {
        ...base,
        ...(result.functionName === undefined ? {} : { functionName: result.functionName }),
        status: result.status,
        checks: [ok('resolved'), ...result.checks],
      },
      tool,
    };
  }

  /**
   * 参照 MCP サーバーの存在と有効/無効。実行時（McpToolset.resolve）は未登録・disabled を黙って
   * スキップするため、「ツールが1つも来ない」原因がここでしか分からない。
   * 未登録は設定ミス（error）、disabled は意図的な一時停止でもあり得る（warning）。
   */
  private async checkMcpServers(scope: TenantScope, agent: Agent): Promise<DiagnosticCheck<AgentCheckId>> {
    // createAgent は重複参照を拒否するが、Agent は interface なので防御的に一意化し、同じ名前を二重報告しない。
    const names = [...new Set(agent.mcpServers ?? [])];
    const repo = this.options.mcpServers;
    if (names.length === 0 || repo === undefined) return ok('mcp-servers');
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const name of names) {
      let config: Awaited<ReturnType<McpServerRepository['find']>>;
      try {
        config = await repo.find(scope, name);
      } catch (cause) {
        // リポジトリ障害は診断全体（HTTP 500）ではなく、この項目の error として報告する
        // （model 検査の「設定を解決できない」と同じ扱い）。
        errors.push(`MCP server '${name}' could not be resolved: ${messageOf(cause)}`);
        continue;
      }
      if (config === null) errors.push(`referenced MCP server not found: ${name}`);
      else if (config.disabled) warnings.push(`MCP server '${name}' is disabled, so its tools are skipped at run time`);
    }
    if (errors.length > 0) return error('mcp-servers', [...errors, ...warnings].join('; '));
    if (warnings.length > 0) return warning('mcp-servers', warnings.join('; '));
    return ok('mcp-servers');
  }

  /**
   * 設定中モデルの能力。実行時 prepareLoop のガードと同じ判定・同じメッセージで、Run を始める前に
   * 「このモデルではツールを渡せない / 構造化出力できない」を報告する。
   * 呼び出し可能物（Tool・サブエージェント・MCP）が無い、または functionInvocation:false なら
   * tool-calling は要らない。設定の解決自体に失敗したら、その理由を error として返す。
   */
  private async checkModel(agent: Agent, effectiveToolCount: number): Promise<DiagnosticCheck<AgentCheckId>> {
    let capabilities: readonly ModelCapability[];
    try {
      capabilities = await (this.options.modelCapabilities as () => Promise<readonly ModelCapability[]>)();
    } catch (cause) {
      return error('model', `model settings could not be resolved: ${messageOf(cause)}`);
    }
    const issues: string[] = [];
    const functionInvocation = agent.harness?.functionInvocation ?? DEFAULT_AGENT_RUNTIME_HARNESS.functionInvocation;
    const hasCallables = functionInvocation && (effectiveToolCount > 0 || agent.agents.length > 0 || (agent.mcpServers ?? []).length > 0);
    if (hasCallables && !capabilities.includes('tool-calling')) issues.push('configured model provider does not support tool-calling');
    if (agent.output !== undefined && !capabilities.includes('structured-output')) issues.push('configured model provider does not support structured output');
    return issues.length === 0 ? ok('model') : error('model', issues.join('; '));
  }

  /**
   * ハーネス機能の前提。AgentRuntimeHarnessRuntime.definitions() は前提が揃わないツールを黙って
   * 提示しないので、「有効にしたのに web_search / memory_* が出ない」原因はここで伝える。
   */
  private checkHarness(agent: Agent): DiagnosticCheck<AgentCheckId> {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (agent.harness?.webSearch === true) {
      // 検索プロバイダ設定の解決自体が失敗しても診断全体は落とさず、この項目の error として報告する。
      let configured: boolean | undefined;
      try {
        configured = this.options.webSearchConfigured?.();
      } catch (cause) {
        errors.push(`search provider configuration could not be resolved: ${messageOf(cause)}`);
      }
      if (configured === false) {
        warnings.push('harness enables web search but no search provider is configured, so the web_search tool is not offered');
      }
    }
    if (agent.harness?.fileMemory === true && (agent.wikis ?? []).length === 0) {
      warnings.push('harness enables file memory but the agent references no wiki, so memory tools have nothing to read');
    }
    if (errors.length > 0) return error('harness', [...errors, ...warnings].join('; '));
    return warnings.length === 0 ? ok('harness') : warning('harness', warnings.join('; '));
  }
}

/** 直付け + Skill 由来の実効 Tool 参照。同一 internalId の版曖昧性は実行時と同じ規則で検出する。 */
function collectEffectiveRefs(agent: Agent, skillToolRefs: readonly EffectiveToolRef[]): { effective: EffectiveToolRef[]; ambiguous: string[] } {
  const effective = new Map<string, EffectiveToolRef>();
  const ambiguous: string[] = [];
  const direct: EffectiveToolRef[] = agent.tools.map((ref) => ({ internalId: ref.internalId, version: ref.version, source: 'direct' }));
  for (const ref of [...direct, ...skillToolRefs]) {
    const existing = effective.get(ref.internalId);
    if (existing !== undefined) {
      if (!existing.version.equals(ref.version)) {
        ambiguous.push(`ambiguous tool versions: ${ref.internalId}@${existing.version.toString()} and ${ref.internalId}@${ref.version.toString()}`);
      }
      // 同一版の重複は先勝ち（直付けが先に入るので、直付けツールを「スキル経由」と誤表示しない）。
      continue;
    }
    effective.set(ref.internalId, ref);
  }
  return { effective: [...effective.values()], ambiguous };
}

function duplicateFunctionNames(tools: readonly ToolDiagnostics[], askNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of [...tools.map((tool) => tool.functionName), ...askNames]) {
    if (name === undefined) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

/** 未保存 Agent の診断入力。SaveAgentInput から採番指示（bump）を除いたもの。 */
export type AgentDraftInput = Omit<SaveAgentInput, 'bump'>;

/** 未保存 draft を表す版。採番は保存時に決まるので、診断結果にはこの値が「未保存」の印として載る。 */
export const DRAFT_AGENT_VERSION: SemVer = SemVer.of(0, 0, 0);

/**
 * SaveAgentUseCase と同じ形で Agent 集約を組み立てる純関数（リポジトリ参照・保存なし）。
 * 未保存 draft の診断は、保存されるものと**同じ createAgent 検証**を通った Agent を検査対象にする
 * ことで、「診断は通ったが保存で弾かれる」食い違いを避ける。
 */
export function buildDraftAgent(input: AgentDraftInput, version: SemVer = DRAFT_AGENT_VERSION): Agent {
  return buildAgentAggregate(input, version);
}
