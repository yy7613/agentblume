/**
 * application層: Agent Factory Stage 2-4 資産生成 `GenerateAgentAssetsUseCase`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §4 Stage 2-4）。
 *
 * ToolSmith（+修復ループ）→ SkillWriter → Assembler（+ `GenerateAgentPromptUseCase` の決定的合成）の
 * 順に既存Save系ユースケースへ委譲し、Tool/Skill/Agentをdraftとして保存する。`FactoryRun` レコードには
 * 触れない（`RunFactoryUseCase` が呼び出し後に `artifacts`/`budget` を更新する）。
 *
 * Stage 2 修復ループ: ToolSmithの提案を `ResolveDataSourceGraphUseCase` + `EtlEngine.propagateSchemas`/
 * `preview` で検証し、失敗したらエラーメッセージを添えて再提案させる（`maxRepairAttempts` 回まで）。
 * 修復上限まで失敗したToolは欠落として記録し、計画から除外して続行する（依存するSkillは残る依存Toolだけへ
 * 縮退する。依存Toolを全て失ったSkillはドロップする）。全Toolが欠落した場合はRunを失敗させる。
 */
import { randomUUID } from 'node:crypto';
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

    for (const toolPlan of input.plan.tools) {
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
          const resolvedGraph = await this.resolveDataSources.execute(input.scope, proposal.graph);
          const propagation = this.engine.propagateSchemas(resolvedGraph);
          if (propagation.hasErrors) throw new FactoryValidationError(describePropagationErrors(propagation));
          this.engine.preview(resolvedGraph);

          const internalId = this.makeId();
          saved = await this.saveTool.execute({
            scope: input.scope,
            internalId,
            workingName: `${toolPlan.displayName} (factory draft)`,
            displayName: `${toolPlan.displayName} (Factory)`,
            publishName: makePublishName('tool', toolPlan.displayName, input.runId, toolPlan.key),
            owner: FACTORY_OWNER,
            sideEffect,
            graph: proposal.graph,
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
