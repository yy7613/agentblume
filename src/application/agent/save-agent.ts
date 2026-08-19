import { createAgent, type Agent, type AgentKind, type AgentPersonaRef, type AgentRuntimeHarness, type AgentSubAgentRef } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { AgentId } from '../../domain/agent/ids';
import type { StructuredOutputDefinition } from '../../domain/agent/structured-output';
import { AgentValidationError } from '../../domain/agent/errors';
import type { WikiSpaceId } from '../../domain/memory/ids';
import type { SkillId } from '../../domain/skill/ids';
import type { ToolId, TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { resolveAgentCapabilities, resolveEffectiveSideEffect } from './resolve-agent-capabilities';
import type { WikiRepository } from '../../domain/memory/wiki-repository';

export interface SaveAgentInput {
  readonly scope: TenantScope;
  readonly internalId: AgentId;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly skills?: readonly { readonly internalId: SkillId; readonly version: SemVer }[];
  readonly tools: readonly { readonly internalId: ToolId; readonly version: SemVer }[];
  readonly agents?: readonly AgentSubAgentRef[];
  readonly wikis?: readonly { readonly wikiId: WikiSpaceId }[];
  /** ツールを注入する保存済みMCPサーバー名。未指定・空は従来動作（MCPツールなし）。 */
  readonly mcpServers?: readonly string[];
  /** ランタイムハーネス設定（Agent単位のopt-in）。未指定は従来動作。 */
  readonly harness?: AgentRuntimeHarness;
  readonly persona?: AgentPersonaRef;
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
  readonly output?: StructuredOutputDefinition;
}

export class SaveAgentUseCase {
  constructor(private readonly agents: AgentRepository, private readonly tools: ToolRepository, private readonly skills?: SkillRepository, private readonly wiki?: WikiRepository) {}

  async execute(input: SaveAgentInput): Promise<Agent> {
    const subAgents = input.agents ?? [];
    for (const ref of input.wikis ?? []) {
      if (this.wiki === undefined || await this.wiki.findSpace(input.scope, ref.wikiId) === null) throw new AgentValidationError(`SaveAgent: wiki not found: ${ref.wikiId}`);
    }
    // Tool/Skill/サブエージェント参照の存在と ask_ 名衝突を保存前に検証する。
    try { await resolveAgentCapabilities(input.scope, input.skills ?? [], input.tools, this.tools, this.skills, subAgents, this.agents); }
    catch (error) { throw error instanceof AgentValidationError ? new AgentValidationError(`SaveAgent: ${error.message}`) : error; }
    const versions = await this.agents.listVersions(input.scope, input.internalId);
    const version = versions.length === 0 ? SemVer.of(1, 0, 0) : max(versions).bump(input.bump ?? 'patch');
    const agent = createAgent({
      metadata: {
        internalId: input.internalId, workingName: input.workingName, displayName: input.displayName,
        publishName: input.publishName, version, owner: input.owner,
        state: input.state ?? 'draft', tenant: input.scope,
      },
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      skills: input.skills ?? [],
      tools: input.tools,
      agents: subAgents,
      wikis: input.wikis ?? [],
      mcpServers: input.mcpServers ?? [],
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
    });
    // 実効副作用が深さ上限内で算出できることを確認（循環・過深の委譲を保存時に弾く）。
    try { await resolveEffectiveSideEffect(input.scope, agent, { tools: this.tools, agents: this.agents, skills: this.skills }); }
    catch (error) { throw error instanceof AgentValidationError ? new AgentValidationError(`SaveAgent: ${error.message}`) : error; }
    await this.agents.save(agent);
    return agent;
  }
}

function max(versions: readonly SemVer[]): SemVer {
  return versions.reduce((current, version) => version.compare(current) > 0 ? version : current);
}
