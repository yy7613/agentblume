import { AgentValidationError } from '../../domain/agent/errors';
import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

export interface VersionedRef { readonly internalId: string; readonly version: SemVer }
export interface ResolvedAgentCapabilities { readonly skills: readonly Skill[]; readonly tools: readonly Tool[] }

export async function resolveAgentCapabilities(
  scope: TenantScope,
  skillRefs: readonly VersionedRef[],
  directToolRefs: readonly VersionedRef[],
  tools: ToolRepository,
  skills?: SkillRepository,
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
  return { skills: loadedSkills, tools: loadedTools };
}

export function composeAgentSystemPrompt(base: string, skills: readonly Skill[]): string {
  if (skills.length === 0) return base;
  const skillInstructions = skills.map((skill) =>
    `# Skill: ${skill.metadata.publishName}@${skill.metadata.version.toString()}\n${skill.instructions}`,
  );
  return [base, '# Bound skills', ...skillInstructions].join('\n\n');
}
