/**
 * アプリ層: Agent Tool 呼び出しのプリフライト診断。
 *
 * 「作った Tool がエージェントから呼び出せない」とき、原因は参照切れ・名前衝突・スキーマ
 * 不整合・データソース欠落など複数の層に分かれて潜むが、実行時には**最初に踏んだ1つ**が
 * Run 失敗の1行になって返るだけで全体像が見えない。ここでは実行経路と同じ関数
 * （`toolToModelDefinition` / `schemasEqual` / `propagateSchemas` / `preview` /
 * `schemaIncompatibility` / `operatorArgumentSummaries`）で各段階を**個別に**検査し、
 * どの段階で何が壊れているかの一覧を返す。検証ロジックは実行側と共有し、二重実装を作らない
 * — 診断が ok の項目は、実行時にも同じ理由では落ちない。
 *
 * 検査は静的（モデル呼び出しなし・副作用なし）。engine.preview は設計時サンプル値での
 * ドライランで、sink の副作用は application 層の dispatcher が担うため発生しない。
 */
import type { Agent } from '../../domain/agent/agent';
import { subAgentToolName } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { schemaIncompatibility } from '../../domain/data/schema';
import type { Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { operatorArgumentSummaries } from '../../domain/etl/nodes/filter';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { EtlEngine } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { schemasEqual, toolToModelDefinition } from './tool-schema';

export type DiagnosticStatus = 'ok' | 'warning' | 'error';

/** Agent単位の検査項目。 */
export type AgentCheckId = 'skills' | 'tool-versions' | 'sub-agents' | 'function-names';
/** Tool単位の検査項目。実行時に対応する失敗地点がある順に並べる。 */
export type ToolCheckId =
  | 'resolved'            // Tool version が存在するか（AgentValidationError: referenced tool not found）
  | 'function-definition' // LLMへ公開する function definition を組めるか（AgentRunError: invalid function name 等）
  | 'agent-input'         // inputSchema と agent-input ノードの一致（graphWithArguments の実行時検査と同一）
  | 'data-sources'        // データソース参照の解決（DataSourceValidationError）
  | 'graph'               // 解決済みグラフのスキーマ伝播（GraphError / schema issue）
  | 'execution'           // 設計時サンプル値でのドライラン（ノード実行エラー）
  | 'output-schema'       // 宣言 outputSchema と推論終端の整合（assertOutputMatchesSchema と同一規則）
  | 'operator-arguments'  // opBinding の許可リスト・既定演算子・引数宣言の整合
  | 'side-effect';        // 非 read-only は承認ゲートで停止する（失敗ではないので warning）

export interface DiagnosticCheck<Id extends string = string> {
  readonly id: Id;
  readonly status: DiagnosticStatus;
  /** 原因の生メッセージ（実行時エラーと同じ英語文）。ok のときは省略。 */
  readonly detail?: string;
}

export interface ToolDiagnostics {
  readonly internalId: string;
  readonly version: string;
  /** 参照の出所。skill 経由なら skillId を持つ。 */
  readonly source: 'direct' | 'skill';
  readonly skillId?: string;
  /** LLMへ公開される function 名（定義を組めた場合のみ）。 */
  readonly functionName?: string;
  readonly status: DiagnosticStatus;
  readonly checks: readonly DiagnosticCheck<ToolCheckId>[];
}

export interface AgentDiagnostics {
  readonly agent: { readonly internalId: string; readonly version: string };
  readonly status: DiagnosticStatus;
  readonly checks: readonly DiagnosticCheck<AgentCheckId>[];
  readonly tools: readonly ToolDiagnostics[];
}

interface EffectiveToolRef {
  readonly internalId: string;
  readonly version: SemVer;
  readonly source: 'direct' | 'skill';
  readonly skillId?: string;
}

function worst(statuses: readonly DiagnosticStatus[]): DiagnosticStatus {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function ok<Id extends string>(id: Id): DiagnosticCheck<Id> { return { id, status: 'ok' }; }
function error<Id extends string>(id: Id, detail: string): DiagnosticCheck<Id> { return { id, status: 'error', detail }; }
function warning<Id extends string>(id: Id, detail: string): DiagnosticCheck<Id> { return { id, status: 'warning', detail }; }
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

export class DiagnoseAgentToolsUseCase {
  constructor(
    private readonly tools: ToolRepository,
    private readonly engine: EtlEngine,
    private readonly skills?: SkillRepository,
    private readonly agents?: AgentRepository,
    private readonly resolveDataSources?: ResolveDataSourceGraphUseCase,
  ) {}

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
      const { diagnostics, tool } = await this.diagnoseTool(scope, ref);
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
      askNames.push(toolName);
    }
    return { askNames, subAgentIssues };
  }

  private async diagnoseTool(scope: TenantScope, ref: EffectiveToolRef): Promise<{ diagnostics: ToolDiagnostics; tool?: Tool }> {
    const checks: DiagnosticCheck<ToolCheckId>[] = [];
    const base = { internalId: ref.internalId, version: ref.version.toString(), source: ref.source, ...(ref.skillId === undefined ? {} : { skillId: ref.skillId }) };

    const tool = await this.tools.findVersion(scope, ref.internalId, ref.version);
    if (tool === null) {
      checks.push(error('resolved', `referenced tool not found: ${ref.internalId}@${ref.version.toString()}`));
      return { diagnostics: { ...base, status: 'error', checks } };
    }
    checks.push(ok('resolved'));

    // LLMへ公開する function definition（名前の形式・引数スキーマ）。
    let functionName: string | undefined;
    try {
      functionName = toolToModelDefinition(tool).name;
      checks.push(ok('function-definition'));
    } catch (cause) {
      checks.push(error('function-definition', messageOf(cause)));
    }

    checks.push(this.checkAgentInput(tool));

    // データソース解決 → グラフ検証 → ドライラン → 出力スキーマ整合。
    // 前段が失敗したら後段は検査しない（解決できないグラフは検証も実行もできない）。
    const resolved = await this.checkDataSources(scope, tool, checks);
    if (resolved !== undefined) this.checkGraph(tool, resolved, checks);

    checks.push(...this.checkOperatorArguments(tool));

    if (tool.sideEffect !== 'read-only') {
      checks.push(warning('side-effect', `side effect '${tool.sideEffect}' pauses the run for approval before this tool executes`));
    }

    return {
      diagnostics: {
        ...base,
        ...(functionName === undefined ? {} : { functionName }),
        status: worst(checks.map((check) => check.status)),
        checks,
      },
      tool,
    };
  }

  /** 実行時 `graphWithArguments` が投げる2つの検査を、実行せずに同じメッセージで再現する。 */
  private checkAgentInput(tool: Tool): DiagnosticCheck<ToolCheckId> {
    const inputNodes = tool.graph.nodes.filter((node) => node.type === 'agent-input');
    if ((tool.inputSchema?.columns.length ?? 0) > 0 && inputNodes.length === 0) {
      return error('agent-input', 'tool declares inputSchema but has no agent-input node');
    }
    for (const node of inputNodes) {
      const config = node.config as { schema?: Schema };
      if (!schemasEqual(tool.inputSchema, config.schema)) {
        return error('agent-input', `tool inputSchema does not match agent-input node '${node.id}'`);
      }
    }
    return ok('agent-input');
  }

  private async checkDataSources(scope: TenantScope, tool: Tool, checks: DiagnosticCheck<ToolCheckId>[]): Promise<ToolGraph | undefined> {
    if (this.resolveDataSources === undefined) {
      // 実行側も resolver 未配線ならグラフをそのまま流す。診断も同じ前提に立つ。
      checks.push(ok('data-sources'));
      return tool.graph;
    }
    try {
      const resolved = await this.resolveDataSources.execute(scope, tool.graph);
      checks.push(ok('data-sources'));
      return resolved;
    } catch (cause) {
      checks.push(error('data-sources', messageOf(cause)));
      return undefined;
    }
  }

  private checkGraph(tool: Tool, resolved: ToolGraph, checks: DiagnosticCheck<ToolCheckId>[]): void {
    try {
      const propagation = this.engine.propagateSchemas(resolved);
      if (propagation.hasErrors) {
        const messages = Object.values(propagation.nodes)
          .flatMap((node) => node.issues.filter((issue) => issue.severity === 'error').map((issue) => `${node.nodeId}: ${issue.message}`))
          .join('; ');
        checks.push(error('graph', messages));
        return;
      }
      checks.push(ok('graph'));

      // 設計時サンプル値でのドライラン（副作用なし。ノード実行時にしか出ないエラーを拾う）。
      try {
        this.engine.preview(resolved, { rowLimit: 100 });
        checks.push(ok('execution'));
      } catch (cause) {
        checks.push(error('execution', messageOf(cause)));
      }

      if (tool.outputSchema !== undefined) {
        const terminalSchema = propagation.nodes[propagation.terminalId]?.schema;
        const incompatibility = terminalSchema === undefined ? undefined : schemaIncompatibility(terminalSchema, tool.outputSchema);
        checks.push(incompatibility === undefined
          ? ok('output-schema')
          : error('output-schema', `declared output schema does not match the graph's inferred output (${incompatibility}) — the run fails after the tool executes; re-save the tool to refresh its output schema`));
      }
    } catch (cause) {
      // GraphError（構造違反）等。伝播自体ができないグラフはドライランも出力整合も検査できない。
      checks.push(error('graph', messageOf(cause)));
    }
  }

  private checkOperatorArguments(tool: Tool): DiagnosticCheck<ToolCheckId>[] {
    const summaries = operatorArgumentSummaries(
      tool.graph.nodes.filter((node) => node.type === 'filter').map((node) => node.config),
    );
    if (summaries.length === 0) return [];
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const summary of summaries) {
      const column = tool.inputSchema?.columns.find((candidate) => candidate.name === summary.field);
      if (summary.allowed.length === 0) errors.push(`operator argument '${summary.field}' has no operator that every condition allows`);
      if (summary.defaultOpMixed) errors.push(`operator argument '${summary.field}' has conflicting default operators across conditions`);
      if (column === undefined) warnings.push(`operator argument '${summary.field}' is not declared in the input schema, so the binding is inactive at run time`);
      else if (column.type !== 'string') errors.push(`operator argument '${summary.field}' must be declared as a string argument, but it is '${column.type}'`);
    }
    if (errors.length > 0) return [error('operator-arguments', [...errors, ...warnings].join('; '))];
    if (warnings.length > 0) return [warning('operator-arguments', warnings.join('; '))];
    return [ok('operator-arguments')];
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
