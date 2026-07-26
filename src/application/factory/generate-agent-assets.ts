/**
 * application層: Agent Factory Stage 2-4 資産生成 `GenerateAgentAssetsUseCase`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §4 Stage 2-4）。
 *
 * ToolSmith（+修復ループ）→ SkillWriter → Assembler（+ `GenerateAgentPromptUseCase` の決定的合成）の
 * 順に既存Save系ユースケースへ委譲し、Tool/Skill/Agentをdraftとして保存する。`FactoryRun` レコードには
 * 触れない（`RunFactoryUseCase` が呼び出し後に `artifacts`/`budget` を更新する）。
 *
 * Stage 2 既存Tool再利用: 計画に `reuse.internalId` があり、渡された既存ツールカタログ（`existingTools`）で
 * 解決できる場合はToolSmithを呼ばず、その既存Toolの最新版をAgent/Skillの参照へそのまま載せる
 * （`tool_reused` イベント）。解決できない場合は理由をイベントへ残して新規生成へフォールバックする。
 *
 * Stage 2 修復ループ: ToolSmithの提案を `ResolveDataSourceGraphUseCase` + `EtlEngine.propagateSchemas`/
 * `preview` で検証し、失敗したらエラーメッセージを添えて再提案させる（`maxRepairAttempts` 回まで）。
 * 修復上限まで失敗したToolは欠落として記録し、計画から除外して続行する（依存するSkillは残る依存Toolだけへ
 * 縮退する。依存Toolを全て失ったSkillはドロップする）。全Toolが欠落した場合はRunを失敗させる。
 */
import { randomUUID } from 'node:crypto';
import type { Column, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryEvent, FactoryGoalInput } from '../../domain/factory/factory-run';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { VersionRef } from '../../domain/factory/refs';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { EtlEngine, PropagationResult } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { SaveAgentUseCase } from '../agent/save-agent';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import type { DataProfile } from './profile-data-sources';
import { isReusableSideEffect, type ExistingToolCatalogEntry } from './tool-catalog';
import { AssemblerRole } from './roles/assembler-role';
import { SkillWriterRole, type SkillWriterToolContract } from './roles/skill-writer-role';
import { ToolSmithRole } from './roles/tool-smith-role';

/** Factory生成物の owner（docs/16 §8: 既存資産の名前空間を汚染しない出所ラベル）。`run-factory.ts` のStage 5でも再利用する。 */
export const FACTORY_OWNER = 'agent-factory';

export interface GenerateAgentAssetsInput {
  readonly scope: TenantScope;
  readonly runId: string;
  readonly goal: FactoryGoalInput;
  readonly plan: FactoryPlan;
  readonly profiles: readonly DataProfile[];
  readonly maxRepairAttempts: number;
  /**
   * 再利用候補の既存Tool（`buildExistingToolCatalog` の結果 `entries`）。計画の `reuse.internalId` は
   * このカタログ内でだけ解決する（Stage 1でPlannerへ提示した集合と、実際に参照する集合を一致させる）。
   */
  readonly existingTools?: readonly ExistingToolCatalogEntry[];
  readonly onEvent?: (event: Omit<FactoryEvent, 'sequence'>) => void;
}

export interface GenerateAgentAssetsResult {
  readonly toolRefs: readonly VersionRef[];
  readonly skillRefs: readonly VersionRef[];
  readonly agentRef: VersionRef;
  readonly toolKeyToRef: Map<string, VersionRef>;
  /** Tool計画キー → 生成済みToolの公開名（Stage 5でScenario.expectedToolsへ解決するために使う）。 */
  readonly toolKeyToPublishName: ReadonlyMap<string, string>;
  readonly roleCallsUsed: number;
}

export class GenerateAgentAssetsUseCase {
  constructor(
    private readonly toolSmith: ToolSmithRole,
    private readonly skillWriter: SkillWriterRole,
    private readonly assembler: AssemblerRole,
    private readonly saveTool: SaveToolUseCase,
    private readonly saveSkill: SaveSkillUseCase,
    private readonly saveAgent: SaveAgentUseCase,
    private readonly generateAgentPrompt: GenerateAgentPromptUseCase,
    private readonly engine: EtlEngine,
    private readonly resolveDataSources: ResolveDataSourceGraphUseCase,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: GenerateAgentAssetsInput): Promise<GenerateAgentAssetsResult> {
    let roleCallsUsed = 0;
    const emit = (event: Omit<FactoryEvent, 'sequence'>): void => { input.onEvent?.(event); };
    const profileByDataSourceId = new Map(input.profiles.map((profile) => [profile.dataSourceId, profile] as const));

    // Stage 2: Tool生成（ToolSmith + 修復ループ）。
    const toolRefs: VersionRef[] = [];
    const toolKeyToRef = new Map<string, VersionRef>();
    const toolKeyToPublishName = new Map<string, string>();
    const toolKeyToContract = new Map<string, SkillWriterToolContract>();
    const reusable = input.existingTools ?? [];

    for (const toolPlan of input.plan.tools) {
      // 再利用計画（Stage 1の「既存Toolで足りるか」の判断結果）は、ToolSmithを呼ばずに既存Toolを参照する。
      // 解決できない（削除済み・カタログ外・許可されない副作用）場合は理由を記録して新規生成へフォールバックする。
      const reuse = toolPlan.reuse;
      if (reuse !== undefined) {
        const existing = resolveReuseTarget(reusable, reuse.internalId);
        if (existing !== undefined && isReusableSideEffect(existing.sideEffect)) {
          const ref: VersionRef = { internalId: existing.internalId, version: existing.latestVersion };
          toolRefs.push(ref);
          toolKeyToRef.set(toolPlan.key, ref);
          toolKeyToPublishName.set(toolPlan.key, existing.publishName);
          toolKeyToContract.set(toolPlan.key, { name: existing.toolName, description: existing.description });
          emit({ kind: 'tool_reused', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key}: ${existing.publishName}`, ref });
          continue;
        }
        emit({ kind: 'tool_repair_attempted', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key}: reuse target '${reuse.internalId}' is not available for reuse; generating a new tool instead` });
      }

      const profile = profileByDataSourceId.get(toolPlan.dataSourceId);
      if (profile === undefined) {
        emit({ kind: 'tool_repair_attempted', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key}: no data profile available for dataSourceId '${toolPlan.dataSourceId}'` });
        continue;
      }
      // 保存前に read-only/session-write のみへ強制する（docs/16 §8: write/external-actionは保存前に拒否）。
      const sideEffect = toolPlan.sideEffect === 'read-only' || toolPlan.sideEffect === 'session-write' ? toolPlan.sideEffect : 'read-only';
      const attempts = 1 + Math.max(0, input.maxRepairAttempts);
      let priorError: string | undefined;
      let saved: Tool | undefined;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        roleCallsUsed += 1;
        try {
          const proposal = await this.toolSmith.propose({ toolPlan, profile, ...(priorError === undefined ? {} : { priorError }) });
          const graph = mergeAgentInputDeclarations(proposal.graph);
          const resolvedGraph = await this.resolveDataSources.execute(input.scope, graph);
          const propagation = this.engine.propagateSchemas(resolvedGraph);
          if (propagation.hasErrors) throw new FactoryValidationError(describePropagationErrors(propagation));
          this.engine.preview(resolvedGraph);

          const inputSchema = agentToolArgumentsOf(graph);
          const internalId = this.makeId();
          saved = await this.saveTool.execute({
            scope: input.scope,
            internalId,
            workingName: `${toolPlan.displayName} (factory draft)`,
            displayName: `${toolPlan.displayName} (Factory)`,
            publishName: makePublishName('tool', toolPlan.displayName, input.runId, toolPlan.key),
            owner: FACTORY_OWNER,
            sideEffect,
            graph,
            ...(inputSchema === undefined ? {} : { inputSchema }),
            agentTool: proposal.agentTool,
          });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          priorError = message;
          emit({ kind: 'tool_repair_attempted', at: this.now().toISOString(), stage: 'generating-tools', message: `${toolPlan.key} attempt ${attempt}/${attempts}: ${message}` });
        }
      }

      if (saved === undefined) continue; // 修復上限まで失敗 → 欠落として記録し計画から除外して続行。

      const ref: VersionRef = { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() };
      toolRefs.push(ref);
      toolKeyToRef.set(toolPlan.key, ref);
      toolKeyToPublishName.set(toolPlan.key, saved.metadata.publishName);
      toolKeyToContract.set(toolPlan.key, { name: saved.agentTool?.name ?? saved.metadata.publishName, description: saved.agentTool?.description ?? saved.metadata.displayName });
      emit({ kind: 'tool_generated', at: this.now().toISOString(), stage: 'generating-tools', message: toolPlan.key, ref });
      emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-tools', ref });
    }

    if (toolRefs.length === 0) throw new FactoryValidationError('GenerateAgentAssets: no tools could be generated');

    // Stage 3: Skill生成（SkillWriter）。依存Toolを全て失ったSkillはドロップし、一部生存なら縮退する。
    const skillRefs: VersionRef[] = [];
    for (const skillPlan of input.plan.skills) {
      const resolvedToolKeys = skillPlan.toolKeys.filter((key) => toolKeyToRef.has(key));
      if (skillPlan.toolKeys.length > 0 && resolvedToolKeys.length === 0) continue;

      const toolContracts = resolvedToolKeys
        .map((key) => toolKeyToContract.get(key))
        .filter((contract): contract is SkillWriterToolContract => contract !== undefined);
      const skillToolRefs = resolvedToolKeys
        .map((key) => toolKeyToRef.get(key))
        .filter((ref): ref is VersionRef => ref !== undefined)
        .map((ref) => ({ internalId: ref.internalId, version: SemVer.parse(ref.version) }));

      roleCallsUsed += 1;
      const proposal = await this.skillWriter.propose({ skillPlan, toolContracts });
      const savedSkill = await this.saveSkill.execute({
        scope: input.scope,
        internalId: this.makeId(),
        workingName: `${skillPlan.displayName} (factory draft)`,
        displayName: `${skillPlan.displayName} (Factory)`,
        publishName: makePublishName('skill', skillPlan.displayName, input.runId, skillPlan.key),
        owner: FACTORY_OWNER,
        responsibility: proposal.responsibility,
        activationCondition: proposal.activationCondition,
        inputDescription: proposal.inputDescription,
        outputDescription: proposal.outputDescription,
        instructions: proposal.instructions,
        tools: skillToolRefs,
      });
      const ref: VersionRef = { internalId: savedSkill.metadata.internalId, version: savedSkill.metadata.version.toString() };
      skillRefs.push(ref);
      emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'generating-skills', ref });
    }

    // Stage 4: Agent組み立て（決定的合成 + Assembler）。
    const skillPromptRefs = skillRefs.map((ref) => ({ internalId: ref.internalId, version: SemVer.parse(ref.version) }));
    const toolPromptRefs = toolRefs.map((ref) => ({ internalId: ref.internalId, version: SemVer.parse(ref.version) }));

    const promptDraft = await this.generateAgentPrompt.execute({
      scope: input.scope,
      displayName: input.plan.agentBrief.displayName,
      kind: 'normal',
      skills: skillPromptRefs,
      tools: toolPromptRefs,
    });

    roleCallsUsed += 1;
    const assembled = await this.assembler.propose({
      goal: input.goal,
      agentBrief: input.plan.agentBrief,
      skillGuide: promptDraft.sections.skillGuide,
      toolUsageGuide: promptDraft.sections.toolUsageGuide,
    });

    // Tool使用ガイド・Skillガイドはassemblerが上書き生成しない（出所を機械的に追跡できる部分を保つ）。
    const systemPrompt = [assembled.role, promptDraft.sections.skillGuide, promptDraft.sections.toolUsageGuide, assembled.rules].join('\n\n');

    const savedAgent = await this.saveAgent.execute({
      scope: input.scope,
      internalId: this.makeId(),
      workingName: `${input.plan.agentBrief.displayName} (factory draft)`,
      displayName: `${input.plan.agentBrief.displayName} (Factory)`,
      publishName: makePublishName('agent', input.plan.agentBrief.displayName, input.runId, 'agent'),
      owner: FACTORY_OWNER,
      kind: 'normal',
      systemPrompt,
      skills: skillPromptRefs,
      tools: toolPromptRefs,
    });
    const agentRef: VersionRef = { internalId: savedAgent.metadata.internalId, version: savedAgent.metadata.version.toString() };
    emit({ kind: 'artifact_saved', at: this.now().toISOString(), stage: 'assembling-agent', ref: agentRef });

    return { toolRefs, skillRefs, agentRef, toolKeyToRef, toolKeyToPublishName, roleCallsUsed };
  }
}

/** Tool引数として宣言できる列型（Tool Callingの引数へそのまま写せるものだけ）。 */
const AGENT_ARGUMENT_TYPES: readonly string[] = ['string', 'number', 'boolean', 'date'];

/**
 * 未接続の `agent-input` ノードが宣言する Tool引数スキーマを取り出す（宣言が無ければ `undefined`）。
 *
 * これを `SaveToolUseCase.inputSchema` に渡すことで Tool Calling契約（`toolToModelDefinition` が
 * inputSchema から導出するJSON Schema）と Tool使用ガイドの `input [...]` 表記が引数付きになり、
 * 実行時は `RunAgentPreviewUseCase` が filter条件の `valueBinding` を実引数へ差し替える。
 *
 * 宣言が壊れている場合は `FactoryValidationError` を投げ、呼び出し側の修復ループへ回す:
 * - agent-input が2つ以上（実行時に inputSchema と一致検査するノードは1つに限る）
 * - schema.columns / sample が無い、引数型が扱えない、非nullable引数のサンプル値が無い
 * - 宣言したのに filter から参照されない引数がある（エージェントに無意味な引数を要求しない）
 *
 * サンプル値の型不一致は `EtlEngine.propagateSchemas`/`preview`（agent-input ノード自身の検証）が
 * 先に検出するため、ここでは存在確認だけを行う。
 */
/**
 * 計画の `reuse.internalId` をカタログから寛容に解決する。モデルは internalId と publishName /
 * Tool契約名を混同しやすい（実測: `builtin-current-datetime` を `builtin-current_datetime` と書く）ため、
 * 完全一致(internalId → publishName → toolName) → 正規化一致(小文字化+英数字以外を除去)の順で探す。
 * 正規化一致が複数候補に当たる場合は誤参照を避けるため解決しない。
 */
export function resolveReuseTarget(catalog: readonly ExistingToolCatalogEntry[], requested: string): ExistingToolCatalogEntry | undefined {
  const exact = catalog.find((entry) => entry.internalId === requested)
    ?? catalog.find((entry) => entry.publishName === requested)
    ?? catalog.find((entry) => entry.toolName === requested);
  if (exact !== undefined) return exact;
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = normalize(requested);
  if (wanted === '') return undefined;
  const matches = catalog.filter((entry) =>
    normalize(entry.internalId) === wanted || normalize(entry.publishName) === wanted || normalize(entry.toolName) === wanted);
  const unique = new Set(matches.map((entry) => entry.internalId));
  return unique.size === 1 ? matches[0] : undefined;
}

/**
 * モデルが「引数1つにつき agent-input ノード1つ」と誤解して複数ノードを生成するケースを
 * 決定的に正規化する: **未接続の** agent-input が2つ以上あれば、schema.columns と sample を
 * 先勝ちマージして1ノードへ統合する（同名列は先の宣言を採用）。エッジで接続された agent-input が
 * 混ざっている場合はデータ経路を変えないよう正規化を行わず、そのまま検証エラーに委ねる。
 */
export function mergeAgentInputDeclarations(graph: ToolGraph): ToolGraph {
  const declarations = graph.nodes.filter((node) => node.type === 'agent-input');
  if (declarations.length <= 1) return graph;
  const connected = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  if (declarations.some((node) => connected.has(node.id))) return graph;

  const mergedColumns: unknown[] = [];
  const seenNames = new Set<string>();
  const mergedSample: Record<string, unknown> = {};
  for (const node of declarations) {
    const config = (node.config ?? {}) as { schema?: { columns?: unknown }; sample?: unknown };
    const columns = Array.isArray(config.schema?.columns) ? config.schema.columns : [];
    for (const column of columns) {
      const name = (column as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || seenNames.has(name)) continue;
      seenNames.add(name);
      mergedColumns.push(column);
    }
    const sample = config.sample;
    if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
      for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
        if (!Object.prototype.hasOwnProperty.call(mergedSample, key)) mergedSample[key] = value;
      }
    }
  }

  const first = declarations[0]!;
  const rest = new Set(declarations.slice(1).map((node) => node.id));
  return {
    nodes: graph.nodes
      .filter((node) => !rest.has(node.id))
      .map((node) => node.id === first.id ? { ...node, config: { schema: { columns: mergedColumns }, sample: mergedSample } } : node),
    edges: graph.edges,
  };
}

export function agentToolArgumentsOf(graph: ToolGraph): Schema | undefined {
  const declarations = graph.nodes.filter((node) => node.type === 'agent-input');
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) {
    throw new FactoryValidationError('tool graph declares Tool arguments more than once: keep exactly one agent-input node');
  }
  const config = (declarations[0]?.config ?? {}) as { schema?: { columns?: unknown }; sample?: unknown };
  const columns = config.schema?.columns;
  const sample = config.sample;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new FactoryValidationError('agent-input node must declare config.schema.columns with at least one argument');
  }
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
    throw new FactoryValidationError('agent-input node must declare a config.sample object with one representative value per argument');
  }
  const schema: Schema = { columns: columns.map((column) => toArgumentColumn(column, sample as Record<string, unknown>)) };
  const bound = new Set(graph.nodes.filter((node) => node.type === 'filter').flatMap((node) => agentInputBindingFields(node.config)));
  const unused = schema.columns.filter((column) => !bound.has(column.name)).map((column) => column.name);
  if (unused.length > 0) {
    throw new FactoryValidationError(`agent-input argument(s) never used by a filter: ${unused.join(', ')}. Bind each argument with valueBinding { "source": "agent-input", "field": "<argument name>" }`);
  }
  return schema;
}

/** agent-input の宣言列1つを Tool引数の列へ写す（型・サンプル値の存在を検査する）。 */
function toArgumentColumn(raw: unknown, sample: Record<string, unknown>): Column {
  const column = (raw ?? {}) as { name?: unknown; type?: unknown; nullable?: unknown };
  if (typeof column.name !== 'string' || column.name.trim() === '') {
    throw new FactoryValidationError('agent-input argument requires a non-empty name');
  }
  if (typeof column.type !== 'string' || !AGENT_ARGUMENT_TYPES.includes(column.type)) {
    throw new FactoryValidationError(`agent-input argument '${column.name}' must use type ${AGENT_ARGUMENT_TYPES.join('|')}`);
  }
  const nullable = column.nullable === true;
  if (!nullable && !Object.prototype.hasOwnProperty.call(sample, column.name)) {
    throw new FactoryValidationError(`agent-input sample is missing a representative value for '${column.name}'`);
  }
  return { name: column.name, type: column.type as Column['type'], nullable };
}

/** filter config（旧形式のフラット1条件 / 新形式の conditions）が参照する agent-input のfield名。 */
function agentInputBindingFields(config: unknown): string[] {
  const conditions = (config as { conditions?: unknown } | null)?.conditions;
  const sources = Array.isArray(conditions) ? conditions : [config];
  return sources
    .map((condition) => (condition as { valueBinding?: { source?: unknown; field?: unknown } } | null)?.valueBinding)
    .filter((binding): binding is { source: 'agent-input'; field: string } => binding?.source === 'agent-input' && typeof binding.field === 'string')
    .map((binding) => binding.field);
}

function describePropagationErrors(propagation: PropagationResult): string {
  const messages = Object.values(propagation.nodes)
    .flatMap((node) => node.issues.filter((issue) => issue.severity === 'error').map((issue) => `${node.nodeId}: ${issue.message}`))
    .join('; ');
  return `graph validation failed: ${messages}`;
}

/**
 * 決定的slug（a-z0-9_のみ）+ runId由来の短い連番でFactory生成物のpublishName衝突を避ける（docs/16 §8）。
 * `run-factory.ts` のStage 5（Persona/Scenario materialize）でも同じ命名規約を再利用する。
 */
export function slugify(text: string): string {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'asset';
}

export function makePublishName(kind: 'tool' | 'skill' | 'agent' | 'persona' | 'scenario', displayName: string, runId: string, key: string): string {
  const runSuffix = slugify(runId).slice(-8) || 'run';
  return `factory_${kind}_${slugify(displayName)}_${slugify(key)}_${runSuffix}`.slice(0, 80);
}
