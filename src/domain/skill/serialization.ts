import { z } from 'zod';
import { PUBLISH_STATES, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { SkillValidationError } from './errors';
import { createSkill, type Skill } from './skill';

export interface SerializedSkill {
  readonly metadata: { readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly version: string; readonly owner: string; readonly state: PublishState; readonly tenant: { readonly tenantId: string; readonly workspaceId: string } };
  readonly responsibility: string; readonly activationCondition: string;
  readonly inputDescription: string; readonly outputDescription: string;
  readonly instructions: string;
  readonly tools: readonly { readonly internalId: string; readonly version: string }[];
}
const schema = z.object({
  metadata: z.object({ internalId: z.string(), workingName: z.string(), displayName: z.string(), publishName: z.string(), version: z.string(), owner: z.string(), state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]), tenant: z.object({ tenantId: z.string(), workspaceId: z.string() }) }),
  responsibility: z.string(), activationCondition: z.string(), inputDescription: z.string(), outputDescription: z.string(), instructions: z.string(),
  tools: z.array(z.object({ internalId: z.string(), version: z.string() })),
});
export function serializeSkill(skill: Skill): SerializedSkill {
  return { metadata: { ...skill.metadata, version: skill.metadata.version.toString(), tenant: { ...skill.metadata.tenant } }, responsibility: skill.responsibility, activationCondition: skill.activationCondition, inputDescription: skill.inputDescription, outputDescription: skill.outputDescription, instructions: skill.instructions, tools: skill.tools.map((tool) => ({ internalId: tool.internalId, version: tool.version.toString() })) };
}
export function deserializeSkill(value: unknown): Skill {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SkillValidationError(`deserializeSkill: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const skill = parsed.data;
  return createSkill({ ...skill, metadata: { ...skill.metadata, version: SemVer.parse(skill.metadata.version), tenant: { ...skill.metadata.tenant } }, tools: skill.tools.map((tool) => ({ internalId: tool.internalId, version: SemVer.parse(tool.version) })) });
}
