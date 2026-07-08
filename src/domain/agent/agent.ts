import type { ToolId, TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { AgentValidationError } from './errors';
import { createStructuredOutput, type StructuredOutputDefinition } from './structured-output';

export const AGENT_KINDS = ['normal', 'pseudo-user', 'evaluator'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: SemVer;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

export interface AgentToolRef {
  readonly internalId: ToolId;
  readonly version: SemVer;
}

export interface AgentSkillRef {
  readonly internalId: string;
  readonly version: SemVer;
}

export interface AgentSubAgentRef {
  readonly internalId: string;
  readonly version: SemVer;
  /** 委譲基準（非空）。LLMへ提示するサブエージェント委譲ツールの説明文になる。 */
  readonly usage: string;
}

export interface Agent {
  readonly metadata: AgentMetadata;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly skills: readonly AgentSkillRef[];
  readonly tools: readonly AgentToolRef[];
  readonly agents: readonly AgentSubAgentRef[];
  readonly output?: StructuredOutputDefinition;
}

export interface CreateAgentProps {
  readonly metadata: AgentMetadata;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly skills?: readonly AgentSkillRef[];
  readonly tools: readonly AgentToolRef[];
  readonly agents?: readonly AgentSubAgentRef[];
  readonly output?: StructuredOutputDefinition;
}

/** サブエージェント委譲ツールの名前。LLMへは ask_{publishName} として提示する。 */
export function subAgentToolName(publishName: string): string {
  return `ask_${publishName}`;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentValidationError(`createAgent: ${field} must be a non-empty string`);
  }
}

export function createAgent(props: CreateAgentProps): Agent {
  const { metadata } = props;
  if (metadata === null || typeof metadata !== 'object') {
    throw new AgentValidationError('createAgent: metadata is required');
  }
  nonEmpty(metadata.internalId, 'metadata.internalId');
  nonEmpty(metadata.workingName, 'metadata.workingName');
  nonEmpty(metadata.displayName, 'metadata.displayName');
  nonEmpty(metadata.publishName, 'metadata.publishName');
  nonEmpty(metadata.owner, 'metadata.owner');
  nonEmpty(metadata.tenant?.tenantId, 'metadata.tenant.tenantId');
  nonEmpty(metadata.tenant?.workspaceId, 'metadata.tenant.workspaceId');
  if (!(metadata.version instanceof SemVer)) {
    throw new AgentValidationError('createAgent: metadata.version must be a SemVer instance');
  }
  if (!isPublishState(metadata.state)) {
    throw new AgentValidationError(`createAgent: invalid state: ${String(metadata.state)}`);
  }
  if (!(AGENT_KINDS as readonly unknown[]).includes(props.kind)) {
    throw new AgentValidationError(`createAgent: invalid kind: ${String(props.kind)}`);
  }
  nonEmpty(props.systemPrompt, 'systemPrompt');

  const seenSkills = new Set<string>();
  const skills = (props.skills ?? []).map((skill, index) => {
    nonEmpty(skill.internalId, `skills.${index}.internalId`);
    if (!(skill.version instanceof SemVer)) {
      throw new AgentValidationError(`createAgent: skills.${index}.version must be a SemVer instance`);
    }
    const key = `${skill.internalId}@${skill.version.toString()}`;
    if (seenSkills.has(key)) throw new AgentValidationError(`createAgent: duplicate skill reference: ${key}`);
    seenSkills.add(key);
    return { internalId: skill.internalId, version: skill.version };
  });

  const seen = new Set<string>();
  const tools = props.tools.map((tool, index) => {
    nonEmpty(tool.internalId, `tools.${index}.internalId`);
    if (!(tool.version instanceof SemVer)) {
      throw new AgentValidationError(`createAgent: tools.${index}.version must be a SemVer instance`);
    }
    const key = `${tool.internalId}@${tool.version.toString()}`;
    if (seen.has(key)) throw new AgentValidationError(`createAgent: duplicate tool reference: ${key}`);
    seen.add(key);
    return { internalId: tool.internalId, version: tool.version };
  });

  const seenSubAgents = new Set<string>();
  const agents = (props.agents ?? []).map((sub, index) => {
    nonEmpty(sub.internalId, `agents.${index}.internalId`);
    if (!(sub.version instanceof SemVer)) {
      throw new AgentValidationError(`createAgent: agents.${index}.version must be a SemVer instance`);
    }
    nonEmpty(sub.usage, `agents.${index}.usage`);
    if (sub.internalId === metadata.internalId) {
      throw new AgentValidationError(`createAgent: agent cannot reference itself as a sub-agent: ${sub.internalId}`);
    }
    // 同一 internalId は（バージョン違いでも）1参照に限る。
    if (seenSubAgents.has(sub.internalId)) {
      throw new AgentValidationError(`createAgent: duplicate sub-agent reference: ${sub.internalId}`);
    }
    seenSubAgents.add(sub.internalId);
    return { internalId: sub.internalId, version: sub.version, usage: sub.usage };
  });

  return {
    metadata: {
      internalId: metadata.internalId,
      workingName: metadata.workingName,
      displayName: metadata.displayName,
      publishName: metadata.publishName,
      version: metadata.version,
      owner: metadata.owner,
      state: metadata.state,
      tenant: { tenantId: metadata.tenant.tenantId, workspaceId: metadata.tenant.workspaceId },
    },
    kind: props.kind,
    systemPrompt: props.systemPrompt,
    skills,
    tools,
    agents,
    ...(props.output !== undefined ? { output: createStructuredOutput(props.output) } : {}),
  };
}
