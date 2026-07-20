/**
 * application層: Agent Factory 改善提案の適用 `ApplyImprovementsUseCase`
 * （v33 実装契約 §3 / docs/16-agent-factory.md §5.3, M4）。
 *
 * Analystが提案した `ImprovementProposal[]` を検証・適用し、Skill/Toolのdraft新版を既存Save系ユースケース
 * 経由で作った上で、参照を新版へ差し替えた新Agent版を1件だけ作る（既存版は不変・回帰比較・巻き戻しが常に可能。
 * docs/16 §5.3）。`tool-graph-revision` はStage 2と同じ `SaveToolUseCase`（engine検証・read-only/session-write
 * 制約）を通す。検証に落ちた提案は破棄し `RejectedProposal` として理由を残す（Run全体をクラッシュさせない）。
 *
 * `add-tool` はM4のスコープ外（新規Tool 1件の生成はStage 2のToolSmith修復ループと同等の作業が必要なため、
 * 後続スライスへ回す。docs/16 §12 M5候補）。常に却下する。
 *
 * 1イテレーションで複数の提案が同じSkill/Toolを対象にする場合は連鎖して適用する（各提案は直前の適用結果の
 * バージョンを土台にする）。`system-prompt-revision` は1イテレーションにつき1件のみ適用する（複数あれば
 * 最初の1件を採用し、以降は破棄する）。
 */
import type { Agent, AgentSkillRef, AgentToolRef } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { AppliedProposal, ImprovementProposal, RejectedProposal } from '../../domain/factory/improvement-proposal';
import type { VersionRef } from '../../domain/factory/refs';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { EtlEngine } from '../etl/engine';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';

export interface ApplyImprovementsInput {
  readonly scope: TenantScope;
  readonly agentRef: VersionRef;
  readonly proposals: readonly ImprovementProposal[];
  readonly maxProposals: number;
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
    // `SaveToolUseCase` 自体がengine検証（+ read-only/session-write制約）を内包するため、本クラスは
    // engineを直接は呼ばない。Stage 2生成ワイヤリング（`GenerateAgentAssetsUseCase`）との並びを保つために
    // 依存として保持する（将来 add-tool 実装時に修復ループへ使う想定）。
    private readonly engine: EtlEngine,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ApplyImprovementsInput): Promise<ApplyImprovementsResult> {
    const currentAgent = await this.agents.findVersion(input.scope, input.agentRef.internalId, SemVer.parse(input.agentRef.version));
    if (currentAgent === null) throw new FactoryValidationError(`ApplyImprovements: agent not found: ${input.agentRef.internalId}@${input.agentRef.version}`);

    const applied: AppliedProposal[] = [];
    const rejected: RejectedProposal[] = [];
    const newSkillVersions = new Map<string, SemVer>();
    const newToolVersions = new Map<string, SemVer>();
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
          rejected.push({ proposal, reason: 'add-tool application is a later slice' });
          break;
      }
    }

    if (applied.length === 0 && promptRevision === undefined) {
      return { newAgentRef: input.agentRef, applied, rejected };
    }

    // 整合性の確保: `resolveAgentCapabilities`（SaveAgentUseCase内部）はAgentの直接tools参照と、参照する
    // 各Skillが持つtools参照とで、同じToolのバージョンが食い違うと「ambiguous tool versions」で拒否する。
    // tool-contract-revision/tool-graph-revisionで対象Toolを改訂した場合、そのToolを使う現行Skillも
    // 新Tool版を指す新Skill版へ引き上げてから、Agentの新版を組み立てる（Analystの提案には現れない、
    // 適用の副次的な整合性維持であり `applied` へは記録しない）。
    if (newToolVersions.size > 0) {
      for (const skillRef of currentAgent.skills) {
        const skillVersion = newSkillVersions.get(skillRef.internalId) ?? skillRef.version;
        const skill = await this.skills.findVersion(input.scope, skillRef.internalId, skillVersion);
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
        newSkillVersions.set(skillRef.internalId, saved.metadata.version);
      }
    }

    const newSkills: AgentSkillRef[] = currentAgent.skills.map((ref) => ({ internalId: ref.internalId, version: newSkillVersions.get(ref.internalId) ?? ref.version }));
    const newTools: AgentToolRef[] = currentAgent.tools.map((ref) => ({ internalId: ref.internalId, version: newToolVersions.get(ref.internalId) ?? ref.version }));

    let systemPrompt = currentAgent.systemPrompt;
    if (promptRevision !== undefined) {
      const promptDraft = await this.generateAgentPrompt.execute({ scope: input.scope, displayName: currentAgent.metadata.displayName, kind: 'normal', skills: newSkills, tools: newTools });
      systemPrompt = [promptRevision.role, promptDraft.sections.skillGuide, promptDraft.sections.toolUsageGuide, promptRevision.rules].join('\n\n');
    }

    const savedAgent = await this.saveAgent.execute({
      scope: input.scope,
      internalId: currentAgent.metadata.internalId,
      workingName: currentAgent.metadata.workingName,
      displayName: currentAgent.metadata.displayName,
      publishName: currentAgent.metadata.publishName,
      owner: currentAgent.metadata.owner,
      kind: 'normal',
      systemPrompt,
      skills: newSkills,
      tools: newTools,
      wikis: currentAgent.wikis ?? [],
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
      const saved = await this.saveTool.execute({
        scope,
        internalId: currentTool.metadata.internalId,
        workingName: currentTool.metadata.workingName,
        displayName: currentTool.metadata.displayName,
        publishName: currentTool.metadata.publishName,
        owner: currentTool.metadata.owner,
        sideEffect: currentTool.sideEffect,
        graph: proposal.graph,
        ...(currentTool.agentTool !== undefined ? { agentTool: currentTool.agentTool } : {}),
      });
      newToolVersions.set(proposal.toolId, saved.metadata.version);
      applied.push({ proposal, resultingVersion: { internalId: saved.metadata.internalId, version: saved.metadata.version.toString() } });
    } catch (error) {
      rejected.push({ proposal, reason: describeError(error) });
    }
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
