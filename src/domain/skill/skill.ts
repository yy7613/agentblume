import type { TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { SkillValidationError } from './errors';

export interface SkillMetadata {
  readonly internalId: string; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly version: SemVer; readonly owner: string;
  readonly state: PublishState; readonly tenant: TenantScope;
}
export interface SkillToolRef { readonly internalId: string; readonly version: SemVer }
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
  if (typeof value !== 'string' || value.trim().length === 0) throw new SkillValidationError(`createSkill: ${field} must be a non-empty string`);
}

export function createSkill(props: CreateSkillProps): Skill {
  const { metadata } = props;
  nonEmpty(metadata?.internalId, 'metadata.internalId'); nonEmpty(metadata.workingName, 'metadata.workingName');
  nonEmpty(metadata.displayName, 'metadata.displayName'); nonEmpty(metadata.publishName, 'metadata.publishName');
  nonEmpty(metadata.owner, 'metadata.owner'); nonEmpty(metadata.tenant?.tenantId, 'metadata.tenant.tenantId');
  nonEmpty(metadata.tenant?.workspaceId, 'metadata.tenant.workspaceId');
  nonEmpty(props.responsibility, 'responsibility'); nonEmpty(props.activationCondition, 'activationCondition');
  nonEmpty(props.inputDescription, 'inputDescription'); nonEmpty(props.outputDescription, 'outputDescription');
  nonEmpty(props.instructions, 'instructions');
  if (!(metadata.version instanceof SemVer)) throw new SkillValidationError('createSkill: metadata.version must be a SemVer instance');
  if (!isPublishState(metadata.state)) throw new SkillValidationError(`createSkill: invalid state: ${String(metadata.state)}`);
  const seen = new Set<string>();
  const tools = props.tools.map((tool, index) => {
    nonEmpty(tool.internalId, `tools.${index}.internalId`);
    if (!(tool.version instanceof SemVer)) throw new SkillValidationError(`createSkill: tools.${index}.version must be a SemVer instance`);
    const key = `${tool.internalId}@${tool.version.toString()}`;
    if (seen.has(key)) throw new SkillValidationError(`createSkill: duplicate tool reference: ${key}`);
    seen.add(key); return { internalId: tool.internalId, version: tool.version };
  });
  return {
    metadata: { ...metadata, tenant: { ...metadata.tenant } },
    responsibility: props.responsibility,
    activationCondition: props.activationCondition,
    inputDescription: props.inputDescription,
    outputDescription: props.outputDescription,
    instructions: props.instructions,
    tools,
  };
}
