import type { Agent, AgentSubAgentRef } from '../../domain/agent/agent';
import { subAgentToolName } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentValidationError } from '../../domain/agent/errors';
import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SideEffect } from '../../domain/tool/metadata';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

export interface VersionedRef { readonly internalId: string; readonly version: SemVer }
export interface ResolvedSubAgent {
  readonly ref: AgentSubAgentRef;
  readonly agent: Agent;
  readonly toolName: string;   // ask_{publishName}
}
export interface ResolvedAgentCapabilities {
  readonly skills: readonly Skill[];
  readonly tools: readonly Tool[];
  readonly subAgents: readonly ResolvedSubAgent[];
}

/** 委譲の絶対上限深さ。実行時のバジェット既定(2)とは別に、循環・暴走を止める安全弁。 */
export const HARD_MAX_DEPTH = 3;

const SIDE_EFFECT_RANK: Record<SideEffect, number> = { 'read-only': 0, 'session-write': 1, write: 2, 'external-action': 3 };
function maxSideEffect(a: SideEffect, b: SideEffect): SideEffect {
  return SIDE_EFFECT_RANK[a] >= SIDE_EFFECT_RANK[b] ? a : b;
}

export async function resolveAgentCapabilities(
  scope: TenantScope,
  skillRefs: readonly VersionedRef[],
  directToolRefs: readonly VersionedRef[],
  tools: ToolRepository,
  skills?: SkillRepository,
  subAgentRefs: readonly AgentSubAgentRef[] = [],
  agents?: AgentRepository,
): Promise<ResolvedAgentCapabilities> {
  const loadedSkills: Skill[] = [];
  for (const ref of skillRefs) {
    if (skills === undefined) throw new AgentValidationError('Skill repository is not configured');
    const skill = await skills.findVersion(scope, ref.internalId, ref.version);
    if (skill === null) throw new AgentValidationError(`referenced skill not found: ${ref.internalId}@${ref.version.toString()}`);
    loadedSkills.push(skill);
  }

  const effective = new Map<string, VersionedRef>();
  for (const ref of [...directToolRefs, ...loadedSkills.flatMap((skill) => skill.tools)]) {
    const existing = effective.get(ref.internalId);
    if (existing !== undefined && !existing.version.equals(ref.version)) {
      throw new AgentValidationError(`ambiguous tool versions: ${ref.internalId}@${existing.version.toString()} and ${ref.internalId}@${ref.version.toString()}`);
    }
    effective.set(ref.internalId, ref);
  }

  const loadedTools: Tool[] = [];
  for (const ref of effective.values()) {
    const tool = await tools.findVersion(scope, ref.internalId, ref.version);
    if (tool === null) throw new AgentValidationError(`referenced tool not found: ${ref.internalId}@${ref.version.toString()}`);
    loadedTools.push(tool);
  }

  // サブエージェントを解決し、委譲ツール名(ask_{publishName})の衝突を検証する。
  const takenToolNames = new Set(loadedTools.map((tool) => tool.metadata.publishName));
  const subAgents: ResolvedSubAgent[] = [];
  for (const ref of subAgentRefs) {
    if (agents === undefined) throw new AgentValidationError('Agent repository is not configured');
    const sub = await agents.findVersion(scope, ref.internalId, ref.version);
    if (sub === null) throw new AgentValidationError(`referenced sub-agent not found: ${ref.internalId}@${ref.version.toString()}`);
    const toolName = subAgentToolName(sub.metadata.publishName);
    if (takenToolNames.has(toolName)) {
      throw new AgentValidationError(`sub-agent tool name collides with an existing tool or sub-agent: ${toolName}`);
    }
    takenToolNames.add(toolName);
    subAgents.push({ ref, agent: sub, toolName });
  }

  return { skills: loadedSkills, tools: loadedTools, subAgents };
}

export interface EffectiveSideEffectDeps {
  readonly tools: ToolRepository;
  readonly agents: AgentRepository;
  readonly skills?: SkillRepository;
}

/**
 * Agentの実効副作用: 自身の(直接+Skill由来)Tool群と、委譲する全サブエージェントの
 * 実効値の最大。`read-only < write < external-action`。同一 internalId@version はメモ化で
 * 1回だけ算出し、深さ上限(HARD_MAX_DEPTH)超過は循環・暴走とみなして拒否する。
 */
export async function resolveEffectiveSideEffect(
  scope: TenantScope,
  agent: Agent,
  deps: EffectiveSideEffectDeps,
  depth = 0,
  effectMemo = new Map<string, SideEffect>(),
  loadMemo = new Map<string, Agent>(),
): Promise<SideEffect> {
  if (depth > HARD_MAX_DEPTH) {
    throw new AgentValidationError(`sub-agent delegation exceeds max depth ${HARD_MAX_DEPTH}`);
  }
  const key = `${agent.metadata.internalId}@${agent.metadata.version.toString()}`;
  const cached = effectMemo.get(key);
  if (cached !== undefined) return cached;

  // 自Tool群のみ解決（サブは下で別途辿るため subAgentRefs は渡さない）。
  const { tools } = await resolveAgentCapabilities(scope, agent.skills, agent.tools, deps.tools, deps.skills);
  let effect: SideEffect = 'read-only';
  for (const tool of tools) effect = maxSideEffect(effect, tool.sideEffect);

  for (const ref of agent.agents) {
    const sub = await loadSubAgent(scope, ref, deps.agents, loadMemo);
    effect = maxSideEffect(effect, await resolveEffectiveSideEffect(scope, sub, deps, depth + 1, effectMemo, loadMemo));
  }

  effectMemo.set(key, effect);
  return effect;
}

async function loadSubAgent(
  scope: TenantScope,
  ref: AgentSubAgentRef,
  agents: AgentRepository,
  loadMemo: Map<string, Agent>,
): Promise<Agent> {
  const key = `${ref.internalId}@${ref.version.toString()}`;
  const cached = loadMemo.get(key);
  if (cached !== undefined) return cached;
  const sub = await agents.findVersion(scope, ref.internalId, ref.version);
  if (sub === null) throw new AgentValidationError(`referenced sub-agent not found: ${key}`);
  loadMemo.set(key, sub);
  return sub;
}

export function composeAgentSystemPrompt(base: string, skills: readonly Skill[]): string {
  if (skills.length === 0) return base;
  const skillInstructions = skills.map((skill) =>
    `# Skill: ${skill.metadata.publishName}@${skill.metadata.version.toString()}\n${skill.instructions}`,
  );
  return [base, '# Bound skills', ...skillInstructions].join('\n\n');
}
