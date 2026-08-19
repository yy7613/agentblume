import { assertNonEmpty } from '../shared/assert';
import { validatePublishableMetadata, type PublishableMetadata } from '../shared/publishable';
import type { ToolId } from '../tool/ids';
import { SemVer } from '../tool/semver';
import { SkillValidationError } from './errors';
import type { SkillId } from './ids';

export type SkillMetadata = PublishableMetadata<SkillId, SemVer>;
export interface SkillToolRef { readonly internalId: ToolId; readonly version: SemVer }
export interface Skill {
  readonly metadata: SkillMetadata;
  readonly responsibility: string;
  readonly activationCondition: string;
  readonly inputDescription: string;
  readonly outputDescription: string;
  readonly instructions: string;
  readonly tools: readonly SkillToolRef[];
}
export interface CreateSkillProps extends Omit<Skill, 'tools'> { readonly tools: readonly SkillToolRef[] }

function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, `createSkill: ${field}`, (m) => new SkillValidationError(m));
}

export function createSkill(props: CreateSkillProps): Skill {
  const { metadata } = props;
  const validatedMetadata = validatePublishableMetadata(metadata, 'createSkill', { fail: (m) => new SkillValidationError(m), isVersion: (v) => v instanceof SemVer });
  nonEmpty(props.responsibility, 'responsibility'); nonEmpty(props.activationCondition, 'activationCondition');
  nonEmpty(props.inputDescription, 'inputDescription'); nonEmpty(props.outputDescription, 'outputDescription');
  nonEmpty(props.instructions, 'instructions');
  const seen = new Set<string>();
  const tools = props.tools.map((tool, index) => {
    nonEmpty(tool.internalId, `tools.${index}.internalId`);
    if (!(tool.version instanceof SemVer)) throw new SkillValidationError(`createSkill: tools.${index}.version must be a SemVer instance`);
    const key = `${tool.internalId}@${tool.version.toString()}`;
    if (seen.has(key)) throw new SkillValidationError(`createSkill: duplicate tool reference: ${key}`);
    seen.add(key); return { internalId: tool.internalId, version: tool.version };
  });
  return {
    metadata: validatedMetadata,
    responsibility: props.responsibility,
    activationCondition: props.activationCondition,
    inputDescription: props.inputDescription,
    outputDescription: props.outputDescription,
    instructions: props.instructions,
    tools,
  };
}
