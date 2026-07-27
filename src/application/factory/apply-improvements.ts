/**
 * application層: Agent Factory 改善提案の適用 `ApplyImprovementsUseCase`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §5.3, M4）。
 *
 * Analystが提案した `ImprovementProposal[]` を検証・適用し、Skill/Toolのdraft新版を既存Save系ユースケース
 * 経由で作った上で、参照を新版へ差し替えた新Agent版を1件だけ作る（既存版は不変・回帰比較・巻き戻しが常に可能。
 * docs/16 §5.3）。`tool-graph-revision` はStage 2と同じ `SaveToolUseCase`（engine検証・read-only/session-write
 * 制約）を通す。検証に落ちた提案は破棄し `RejectedProposal` として理由を残す（Run全体をクラッシュさせない）。
 *
 * `add-tool` / `add-skill` は「Agentに無い能力を足す」提案で、Tool/Skillを新規に保存した上でAgent新版の
 * `tools` / `skills` へ**追加**する（既存参照のバージョン差替とは別経路）。`add-tool` はStage 2と同じ
 * ToolSmith修復ループ（`generateToolWithRepair`）を通し、副作用が read-only/session-write でない計画は
 * 却下する。修復ループに必要な依存（ToolSmith / データソース解決 / プロファイル）が注入されていない配線では
 * `add-tool` は「未設定」として却下する（`add-skill` は追加依存なしで動く）。
 *
 * 1イテレーションで複数の提案が同じSkill/Toolを対象にする場合は連鎖して適用する（各提案は直前の適用結果の
 * バージョンを土台にする）。`system-prompt-revision` は1イテレーションにつき1件のみ適用する（複数あれば
 * 最初の1件を採用し、以降は破棄する）。
 *
 * Agent新版は既存版の設定（`kind` / サブエージェント / `mcpServers` / `harness` / `output` / `persona` /
 * `wikis` / 公開状態）をすべて引き継ぐ。改善対象がFactory生成Agentとは限らない（既存Agentの強化）ため、
 * 引き継ぎ漏れは設定の消失に直結する。
 */
import { randomUUID } from 'node:crypto';
import type { Agent, AgentSkillRef, AgentToolRef } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { FactoryAddSkillPlan } from '../../domain/factory/factory-plan';
import type { AppliedProposal, ImprovementProposal, RejectedProposal } from '../../domain/factory/improvement-proposal';
import type { VersionRef } from '../../domain/factory/refs';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { EtlEngine } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import {
  agentToolArgumentsOf,
  FACTORY_OWNER,
  generateToolWithRepair,
  makeArgumentsOptional,
  makePublishName,
  mergeAgentInputDeclarations,
} from './generate-agent-assets';
import type { ProfileDataSourcesUseCase } from './profile-data-sources';
import type { ToolSmithRole } from './roles/tool-smith-role';
import { NoopUnitOfWork, type UnitOfWorkPort } from '../persistence/unit-of-work';

/**
 * `add-tool` 適用に必要な追加依存（Stage 2の修復ループと同じ顔ぶれ）。
 * 未注入の配線では `add-tool` を「未設定」として却下し、それ以外の提案種別は従来どおり動く。
 */
export interface ApplyImprovementsToolCreation {
  readonly toolSmith: ToolSmithRole;
  readonly resolveDataSources: ResolveDataSourceGraphUseCase;
  /** `add-tool` の `plan.dataSourceId` を Stage 0 と同じ規律でプロファイルする。 */
  readonly profiler: ProfileDataSourcesUseCase;
}

/** `add-tool` の修復再試行の既定回数（`DEFAULT_FACTORY_BUDGET_LIMITS.maxRepairAttempts` と同値）。 */
const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

export interface ApplyImprovementsInput {
  readonly scope: TenantScope;
  readonly agentRef: VersionRef;
  readonly proposals: readonly ImprovementProposal[];
  readonly maxProposals: number;
  /** `add-tool` のToolSmith再提案回数。未指定は `DEFAULT_MAX_REPAIR_ATTEMPTS`。 */
  readonly maxRepairAttempts?: number;
}

export interface ApplyImprovementsResult {
  readonly newAgentRef: VersionRef;
  readonly applied: readonly AppliedProposal[];
  readonly rejected: readonly RejectedProposal[];
}

interface PromptRevisionState {
  readonly proposal: ImprovementProposal;
  readonly role: string;
  readonly rules: string;
}

export class ApplyImprovementsUseCase {
  constructor(
    private readonly agents: AgentRepository,
    private readonly skills: SkillRepository,
    private readonly tools: ToolRepository,
    private readonly saveAgent: SaveAgentUseCase,
    private readonly saveSkill: SaveSkillUseCase,
    private readonly saveTool: SaveToolUseCase,
    private readonly generateAgentPrompt: GenerateAgentPromptUseCase,
    // 改訂系（tool-contract/tool-graph-revision）では `SaveToolUseCase` 自体がengine検証
    // （+ read-only/session-write制約）を内包するため直接は呼ばないが、`add-tool` の修復ループ
    // （`generateToolWithRepair`）はスキーマ伝播とプレビューをここで回すため engine を使う。
    private readonly engine: EtlEngine,
    private readonly now: () => Date = () => new Date(),
    /** `add-tool` 適用に必要な追加依存。未注入なら `add-tool` は却下する（既存配線を壊さない）。 */
    private readonly toolCreation?: ApplyImprovementsToolCreation,
    private readonly makeId: () => string = randomUUID,
    /**
     * 「整合性のためのSkill引き上げ + Agent新版」をまとめてコミットするための境界。
     * 未注入（InMemory配線・単体テスト）ではそのまま実行する。
     */
    private readonly unitOfWork: UnitOfWorkPort = new NoopUnitOfWork(),
  ) {}

  async execute(input: ApplyImprovementsInput): Promise<ApplyImprovementsResult> {
    const currentAgent = await this.agents.findVersion(input.scope, input.agentRef.internalId, SemVer.parse(input.agentRef.version));
    if (currentAgent === null) throw new FactoryValidationError(`ApplyImprovements: agent not found: ${input.agentRef.internalId}@${input.agentRef.version}`);

    const applied: AppliedProposal[] = [];
    const rejected: RejectedProposal[] = [];
    const newSkillVersions = new Map<string, SemVer>();
    const newToolVersions = new Map<string, SemVer>();
    // 新規に生成してAgentへ追加するTool/Skill（既存参照の差替ではなく和集合として足す）。
    const addedToolIds: string[] = [];
    const addedSkillIds: string[] = [];
    // `add-skill` の `toolRefs` が同一イテレーションの `add-tool` を指せるようにする（plan.key → internalId）。
    const addedToolKeys = new Map<string, string>();
    let promptRevision: PromptRevisionState | undefined;

    const maxProposals = Math.max(0, input.maxProposals);
    const toApply = input.proposals.slice(0, maxProposals);
    for (const proposal of input.proposals.slice(maxProposals)) {
      rejected.push({ proposal, reason: 'exceeds maxProposalsPerIteration' });
    }

    for (const proposal of toApply) {
      switch (proposal.kind) {
        case 'skill-instructions-revision':
          await this.applySkillRevision(input.scope, proposal, currentAgent, newSkillVersions, applied, rejected);
          break;
        case 'tool-contract-revision':
          await this.applyToolContractRevision(input.scope, proposal, currentAgent, newToolVersions, applied, rejected);
          break;
        case 'tool-graph-revision':
          await this.applyToolGraphRevision(input.scope, proposal, currentAgent, newToolVersions, applied, rejected);
          break;
        case 'system-prompt-revision':
          promptRevision = this.applySystemPromptRevision(proposal, promptRevision, rejected);
          break;
        case 'add-tool':
          await this.applyAddTool(input, proposal, newToolVersions, addedToolIds, addedToolKeys, applied, rejected);
          break;
        case 'add-skill':
          await this.applyAddSkill(input.scope, proposal, currentAgent, newToolVersions, addedToolIds, addedToolKeys, newSkillVersions, addedSkillIds, applied, rejected);
          break;
      }
    }

    if (applied.length === 0 && promptRevision === undefined) {
      return { newAgentRef: input.agentRef, applied, rejected };
    }

    // Agent新版が指すSkill/Toolの内訳: 現行参照（バージョンは改訂結果で差替）+ 新規生成分の追加（和集合）。
    const baseSkillVersions = new Map(currentAgent.skills.map((ref) => [ref.internalId, ref.version] as const));
    const baseToolVersions = new Map(currentAgent.tools.map((ref) => [ref.internalId, ref.version] as const));
    const skillIds = uniqueIds([...currentAgent.skills.map((ref) => ref.internalId), ...addedSkillIds]);
    const toolIds = uniqueIds([...currentAgent.tools.map((ref) => ref.internalId), ...addedToolIds]);

    // ここから先は「Skillの引き上げ」と「Agent新版」が**セットで初めて意味を持つ**書き込みになる。
    // 途中で落ちると、どのAgentからも参照されない新Skill版だけがDBに残り（孤児）、Agentは旧Tool版を
    // 指したままになる。モデル呼び出しを含まない純粋な永続化区間なので、1トランザクションで括る。
    const savedAgent = await this.unitOfWork.withTransaction(async () => {
      // 整合性の確保: `resolveAgentCapabilities`（SaveAgentUseCase内部）はAgentの直接tools参照と、参照する
      // 各Skillが持つtools参照とで、同じToolのバージョンが食い違うと「ambiguous tool versions」で拒否する。
      // tool-contract-revision/tool-graph-revisionで対象Toolを改訂した場合、そのToolを使う現行Skillも
      // 新Tool版を指す新Skill版へ引き上げてから、Agentの新版を組み立てる（Analystの提案には現れない、
      // 適用の副次的な整合性維持であり `applied` へは記録しない）。追加したばかりのSkillも同じ対象に含める
      // （add-skill より後の tool-graph-revision が同じToolを改訂しうるため）。
      if (newToolVersions.size > 0) {
        for (const skillId of skillIds) {
          const skillVersion = newSkillVersions.get(skillId) ?? baseSkillVersions.get(skillId);
          if (skillVersion === undefined) continue;
          const skill = await this.skills.findVersion(input.scope, skillId, skillVersion);
          if (skill === null) continue;
          const needsRetarget = skill.tools.some((toolRef) => {
            const override = newToolVersions.get(toolRef.internalId);
            return override !== undefined && !override.equals(toolRef.version);
          });
          if (!needsRetarget) continue;
          const retargetedTools = skill.tools.map((toolRef) => ({ internalId: toolRef.internalId, version: newToolVersions.get(toolRef.internalId) ?? toolRef.version }));
          const saved = await this.saveSkill.execute({
            scope: input.scope,
            internalId: skill.metadata.internalId,
            workingName: skill.metadata.workingName,
            displayName: skill.metadata.displayName,
            publishName: skill.metadata.publishName,
            owner: skill.metadata.owner,
            responsibility: skill.responsibility,
            activationCondition: skill.activationCondition,
            inputDescription: skill.inputDescription,
            outputDescription: skill.outputDescription,
            instructions: skill.instructions,
            tools: retargetedTools,
          });
          newSkillVersions.set(skillId, saved.metadata.version);
        }
      }

      const newSkills: AgentSkillRef[] = resolveRefs(skillIds, newSkillVersions, baseSkillVersions);
      const newTools: AgentToolRef[] = resolveRefs(toolIds, newToolVersions, baseToolVersions);

      let systemPrompt = currentAgent.systemPrompt;
      if (promptRevision !== undefined) {
        const promptDraft = await this.generateAgentPrompt.execute({ scope: input.scope, displayName: currentAgent.metadata.displayName, kind: currentAgent.kind, skills: newSkills, tools: newTools });
        systemPrompt = [promptRevision.role, promptDraft.sections.skillGuide, promptDraft.sections.toolUsageGuide, promptRevision.rules].join('\n\n');
      }

      // 既存Agentの設定はすべて引き継ぐ（Factory生成Agentは持たないが、既存Agentの強化では持ちうる）。
      return this.saveAgent.execute({
        scope: input.scope,
        internalId: currentAgent.metadata.internalId,
        workingName: currentAgent.metadata.workingName,
        displayName: currentAgent.metadata.displayName,
        publishName: currentAgent.metadata.publishName,
        owner: currentAgent.metadata.owner,
        kind: currentAgent.kind,
        systemPrompt,
        skills: newSkills,
        tools: newTools,
        agents: currentAgent.agents,
        wikis: currentAgent.wikis ?? [],
        ...(currentAgent.mcpServers === undefined ? {} : { mcpServers: currentAgent.mcpServers }),
        ...(currentAgent.harness === undefined ? {} : { harness: currentAgent.harness }),
        ...(currentAgent.persona === undefined ? {} : { persona: currentAgent.persona }),
        ...(currentAgent.output === undefined ? {} : { output: currentAgent.output }),
        state: currentAgent.metadata.state,
      });
    });
    const newAgentRef: VersionRef = { internalId: savedAgent.metadata.internalId, version: savedAgent.metadata.version.toString() };
    if (promptRevision !== undefined) applied.push({ proposal: promptRevision.proposal, resultingVersion: newAgentRef });

    return { newAgentRef, applied, rejected };
  }

  private async applySkillRevision(
    scope: TenantScope,
    proposal: Extract<ImprovementProposal, { kind: 'skill-instructions-revision' }>,
    currentAgent: Agent,
    newSkillVersions: Map<string, SemVer>,
    applied: AppliedProposal[],
    rejected: RejectedProposal[],
  ): Promise<void> {
    try {
      const currentVersion = resolveCurrentVersion(proposal.skillId, currentAgent.skills, newSkillVersions);
      if (currentVersion === undefined) throw new FactoryValidationError(`skill not referenced by the current agent: ${proposal.skillId}`);
      const currentSkill = await this.skills.findVersion(scope, proposal.skillId, currentVersion);
      if (currentSkill === null) throw new FactoryValidationError(`skill version not found: ${proposal.skillId}@${currentVersion.toString()}`);
      const saved = await this.saveSkill.execute({
        scope,
        internalId: currentSkill.metadata.internalId,
        workingName: currentSkill.metadata.workingName,
        displayName: currentSkill.metadata.displayName,
        publishName: currentSkill.metadata.publishName,
        owner: currentSkill.metadata.owner,
        responsibility: currentSkill.responsibility,
        activationCondition: proposal.activationCondition ?? currentSkill.activationCondition,
        inputDescription: currentSkill.inputDescription,
        outputDescription: currentSkill.outputDescription,
        instructions: proposal.instructions,
        tools: currentSkill.tools,
      });
      newSkillVersions.set(proposal.skillId, saved.metadata.version);
      applied.push({ proposal, resultingVersion: { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() } });
    } catch (error) {
      rejected.push({ proposal, reason: describeError(error) });
    }
  }

  private async applyToolContractRevision(
    scope: TenantScope,
    proposal: Extract<ImprovementProposal, { kind: 'tool-contract-revision' }>,
    currentAgent: Agent,
    newToolVersions: Map<string, SemVer>,
    applied: AppliedProposal[],
    rejected: RejectedProposal[],
  ): Promise<void> {
    try {
      const currentVersion = resolveCurrentVersion(proposal.toolId, currentAgent.tools, newToolVersions);
      if (currentVersion === undefined) throw new FactoryValidationError(`tool not referenced by the current agent: ${proposal.toolId}`);
      const currentTool = await this.tools.findVersion(scope, proposal.toolId, currentVersion);
      if (currentTool === null) throw new FactoryValidationError(`tool version not found: ${proposal.toolId}@${currentVersion.toString()}`);
      const saved = await this.saveTool.execute({
        scope,
        internalId: currentTool.metadata.internalId,
        workingName: currentTool.metadata.workingName,
        displayName: currentTool.metadata.displayName,
        publishName: currentTool.metadata.publishName,
        owner: currentTool.metadata.owner,
        sideEffect: currentTool.sideEffect,
        graph: currentTool.graph,
        ...(currentTool.inputSchema !== undefined ? { inputSchema: currentTool.inputSchema } : {}),
        ...(currentTool.outputSchema !== undefined ? { outputSchema: currentTool.outputSchema } : {}),
        agentTool: {
          name: proposal.agentTool.name ?? currentTool.agentTool?.name ?? currentTool.metadata.publishName,
          description: proposal.agentTool.description ?? currentTool.agentTool?.description ?? currentTool.metadata.displayName,
        },
      });
      newToolVersions.set(proposal.toolId, saved.metadata.version);
      applied.push({ proposal, resultingVersion: { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() } });
    } catch (error) {
      rejected.push({ proposal, reason: describeError(error) });
    }
  }

  private async applyToolGraphRevision(
    scope: TenantScope,
    proposal: Extract<ImprovementProposal, { kind: 'tool-graph-revision' }>,
    currentAgent: Agent,
    newToolVersions: Map<string, SemVer>,
    applied: AppliedProposal[],
    rejected: RejectedProposal[],
  ): Promise<void> {
    try {
      const currentVersion = resolveCurrentVersion(proposal.toolId, currentAgent.tools, newToolVersions);
      if (currentVersion === undefined) throw new FactoryValidationError(`tool not referenced by the current agent: ${proposal.toolId}`);
      const currentTool = await this.tools.findVersion(scope, proposal.toolId, currentVersion);
      if (currentTool === null) throw new FactoryValidationError(`tool version not found: ${proposal.toolId}@${currentVersion.toString()}`);
      // SaveToolUseCase が engine.propagateSchemas/preview + read-only/session-write 制約を検証する
      // （不正なグラフは ToolValidationError を投げる → catch して rejected へ落とす）。
      // 生成時と同じ正規化（複数agent-inputのマージ・全引数optional化）を適用し、
      // inputSchema は改訂後グラフの agent-input から再導出する（引数付きToolの改訂で
      // 実行時の schemasEqual 検査と binding 検証が一致し続けるように）。
      const revisedGraph = makeArgumentsOptional(mergeAgentInputDeclarations(proposal.graph));
      const revisedArguments = agentToolArgumentsOf(revisedGraph);
      const saved = await this.saveTool.execute({
        scope,
        internalId: currentTool.metadata.internalId,
        workingName: currentTool.metadata.workingName,
        displayName: currentTool.metadata.displayName,
        publishName: currentTool.metadata.publishName,
        owner: currentTool.metadata.owner,
        sideEffect: currentTool.sideEffect,
        graph: revisedGraph,
        ...(revisedArguments !== undefined ? { inputSchema: revisedArguments } : {}),
        ...(currentTool.agentTool !== undefined ? { agentTool: currentTool.agentTool } : {}),
      });
      newToolVersions.set(proposal.toolId, saved.metadata.version);
      applied.push({ proposal, resultingVersion: { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() } });
    } catch (error) {
      rejected.push({ proposal, reason: describeError(error) });
    }
  }

  /**
   * `add-tool`: Stage 2と同じToolSmith修復ループでToolを1件生成し、Agent新版の `tools` へ追加する。
   * 依存未注入・副作用違反・データソース解決失敗・修復上限までの失敗は、いずれもRunを止めず却下する。
   */
  private async applyAddTool(
    input: ApplyImprovementsInput,
    proposal: Extract<ImprovementProposal, { kind: 'add-tool' }>,
    newToolVersions: Map<string, SemVer>,
    addedToolIds: string[],
    addedToolKeys: Map<string, string>,
    applied: AppliedProposal[],
    rejected: RejectedProposal[],
  ): Promise<void> {
    const creation = this.toolCreation;
    if (creation === undefined) {
      rejected.push({ proposal, reason: 'add-tool is not configured' });
      return;
    }
    const plan = proposal.plan;
    // 生成フローは write/external-action を read-only へ丸めるが、既存Agentの強化では「意図しない
    // 副作用のToolを黙って別物へ差し替える」方が危ういため、ここでは却下する（docs/16 §8）。
    if (plan.sideEffect !== 'read-only' && plan.sideEffect !== 'session-write') {
      rejected.push({ proposal, reason: `add-tool sideEffect must be 'read-only' or 'session-write', got '${String(plan.sideEffect)}'` });
      return;
    }
    try {
      const profile = await creation.profiler.execute(input.scope, plan.dataSourceId);
      const outcome = await generateToolWithRepair(
        { toolSmith: creation.toolSmith, resolveDataSources: creation.resolveDataSources, engine: this.engine, saveTool: this.saveTool },
        {
          scope: input.scope,
          toolPlan: plan,
          profile,
          sideEffect: plan.sideEffect,
          maxRepairAttempts: input.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
          // publishNameの一意性は払い出したinternalId由来の接尾辞で担保する（Run/イテレーションを跨いで衝突しない）。
          identity: () => {
            const internalId = this.makeId();
            return {
              internalId,
              workingName: `${plan.displayName} (factory draft)`,
              displayName: `${plan.displayName} (Factory)`,
              publishName: makePublishName('tool', plan.displayName, internalId, plan.key),
              owner: FACTORY_OWNER,
            };
          },
        },
      );
      const tool = outcome.tool;
      if (tool === undefined) throw new FactoryValidationError(`add-tool could not be generated: ${outcome.lastError ?? 'unknown error'}`);

      const internalId = tool.metadata.internalId;
      newToolVersions.set(internalId, tool.metadata.version);
      addedToolIds.push(internalId);
      addedToolKeys.set(plan.key, internalId);
      applied.push({ proposal, resultingVersion: { internalId, version: tool.metadata.version.toString() } });
    } catch (error) {
      rejected.push({ proposal, reason: describeError(error) });
    }
  }

  /**
   * `add-skill`: 新しいSkillを1件保存し、Agent新版の `skills` へ追加する。
   * `plan.toolRefs` は「対象Agentが今持っているTool」か「同一イテレーションで追加したTool」だけを指せる
   * （それ以外は却下）。Skill本文はAnalystが書いたものをそのまま使う（`skill-instructions-revision` と同じ規律）。
   */
  private async applyAddSkill(
    scope: TenantScope,
    proposal: Extract<ImprovementProposal, { kind: 'add-skill' }>,
    currentAgent: Agent,
    newToolVersions: Map<string, SemVer>,
    addedToolIds: readonly string[],
    addedToolKeys: ReadonlyMap<string, string>,
    newSkillVersions: Map<string, SemVer>,
    addedSkillIds: string[],
    applied: AppliedProposal[],
    rejected: RejectedProposal[],
  ): Promise<void> {
    const plan = proposal.plan;
    try {
      const candidates = await this.loadCandidateTools(scope, currentAgent, newToolVersions, addedToolIds);
      const toolRefs = resolveSkillToolRefs(plan, candidates, addedToolKeys);
      const internalId = this.makeId();
      const saved = await this.saveSkill.execute({
        scope,
        internalId,
        workingName: `${plan.displayName} (factory draft)`,
        displayName: `${plan.displayName} (Factory)`,
        publishName: makePublishName('skill', plan.displayName, internalId, plan.key),
        owner: FACTORY_OWNER,
        responsibility: plan.responsibility,
        activationCondition: plan.activationCondition,
        inputDescription: plan.inputDescription ?? `${plan.responsibility} を求める依頼。`,
        outputDescription: plan.outputDescription ?? `${plan.responsibility} の結果。`,
        instructions: plan.instructions,
        tools: toolRefs,
      });
      newSkillVersions.set(internalId, saved.metadata.version);
      addedSkillIds.push(internalId);
      applied.push({ proposal, resultingVersion: { internalId, version: saved.metadata.version.toString() } });
    } catch (error) {
      rejected.push({ proposal, reason: describeError(error) });
    }
  }

  /** `add-skill` の `toolRefs` 解決に使う「今この瞬間Agentが持てるTool」の実体を、最新版で読み込む。 */
  private async loadCandidateTools(
    scope: TenantScope,
    currentAgent: Agent,
    newToolVersions: ReadonlyMap<string, SemVer>,
    addedToolIds: readonly string[],
  ): Promise<Tool[]> {
    const baseVersions = new Map(currentAgent.tools.map((ref) => [ref.internalId, ref.version] as const));
    const loaded: Tool[] = [];
    for (const internalId of uniqueIds([...baseVersions.keys(), ...addedToolIds])) {
      const version = newToolVersions.get(internalId) ?? baseVersions.get(internalId);
      if (version === undefined) continue;
      const tool = await this.tools.findVersion(scope, internalId, version);
      if (tool !== null) loaded.push(tool);
    }
    return loaded;
  }

  private applySystemPromptRevision(
    proposal: Extract<ImprovementProposal, { kind: 'system-prompt-revision' }>,
    existing: PromptRevisionState | undefined,
    rejected: RejectedProposal[],
  ): PromptRevisionState | undefined {
    if (existing !== undefined) {
      rejected.push({ proposal, reason: 'a system-prompt-revision was already applied for this iteration' });
      return existing;
    }
    if (proposal.sections.role === undefined || proposal.sections.rules === undefined) {
      rejected.push({ proposal, reason: 'system-prompt-revision requires both sections.role and sections.rules (full replacement text)' });
      return existing;
    }
    return { proposal, role: proposal.sections.role, rules: proposal.sections.rules };
  }
}

function resolveCurrentVersion(internalId: string, refs: readonly { readonly internalId: string; readonly version: SemVer }[], overrides: ReadonlyMap<string, SemVer>): SemVer | undefined {
  return overrides.get(internalId) ?? refs.find((ref) => ref.internalId === internalId)?.version;
}

/** 出現順を保ったまま internalId を一意化する（`createAgent` は同一参照の重複を拒否する）。 */
function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** internalId列を「改訂後バージョン → 現行バージョン」の順に解決して参照配列へ写す。 */
function resolveRefs(ids: readonly string[], overrides: ReadonlyMap<string, SemVer>, base: ReadonlyMap<string, SemVer>): { internalId: string; version: SemVer }[] {
  return ids
    .map((internalId) => {
      const version = overrides.get(internalId) ?? base.get(internalId);
      return version === undefined ? undefined : { internalId, version };
    })
    .filter((ref): ref is { internalId: string; version: SemVer } => ref !== undefined);
}

/**
 * `add-skill` の `toolRefs` を実際のTool参照へ解決する。
 * 解決順は internalId → publishName → Tool契約名（`agentTool.name`）→ 同一イテレーションの `add-tool` の `plan.key`。
 * 1つでも解決できなければ提案ごと却下する（存在しないToolを指すSkillを保存しない）。
 */
function resolveSkillToolRefs(
  plan: FactoryAddSkillPlan,
  candidates: readonly Tool[],
  addedToolKeys: ReadonlyMap<string, string>,
): { internalId: string; version: SemVer }[] {
  const byId = new Map(candidates.map((tool) => [tool.metadata.internalId, tool] as const));
  const resolved = new Map<string, SemVer>();
  for (const ref of plan.toolRefs) {
    const tool = byId.get(ref)
      ?? candidates.find((candidate) => candidate.metadata.publishName === ref)
      ?? candidates.find((candidate) => (candidate.agentTool?.name ?? candidate.metadata.publishName) === ref)
      ?? byId.get(addedToolKeys.get(ref) ?? '');
    if (tool === undefined) {
      throw new FactoryValidationError(`add-skill references a tool that the agent does not have: ${ref}`);
    }
    resolved.set(tool.metadata.internalId, tool.metadata.version);
  }
  return [...resolved].map(([internalId, version]) => ({ internalId, version }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
