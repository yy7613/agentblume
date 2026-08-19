import { z } from 'zod';
import { deserializePublishableMetadata, serializePublishableMetadata, serializedPublishableMetadataSchema, type SerializedPublishableMetadata } from '../shared/publishable';
import { SemVer } from '../tool/semver';
import { SkillValidationError } from './errors';
import { createSkill, type Skill } from './skill';

export interface SerializedSkill {
  readonly metadata: SerializedPublishableMetadata;
  readonly responsibility: string; readonly activationCondition: string;
  readonly inputDescription: string; readonly outputDescription: string;
  readonly instructions: string;
  readonly tools: readonly { readonly internalId: string; readonly version: string }[];
}
const schema = z.object({
  metadata: serializedPublishableMetadataSchema,
  responsibility: z.string(), activationCondition: z.string(), inputDescription: z.string(), outputDescription: z.string(), instructions: z.string(),
  tools: z.array(z.object({ internalId: z.string(), version: z.string() })),
});
export function serializeSkill(skill: Skill): SerializedSkill {
  return { metadata: serializePublishableMetadata(skill.metadata), responsibility: skill.responsibility, activationCondition: skill.activationCondition, inputDescription: skill.inputDescription, outputDescription: skill.outputDescription, instructions: skill.instructions, tools: skill.tools.map((tool) => ({ internalId: tool.internalId, version: tool.version.toString() })) };
}
export function deserializeSkill(value: unknown): Skill {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SkillValidationError(`deserializeSkill: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const skill = parsed.data;
  return createSkill({ ...skill, metadata: deserializePublishableMetadata(skill.metadata, (text) => SemVer.parse(text)), tools: skill.tools.map((tool) => ({ internalId: tool.internalId, version: SemVer.parse(tool.version) })) });
}
