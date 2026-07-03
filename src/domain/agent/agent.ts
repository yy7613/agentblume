import type { ToolId, TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { AgentValidationError } from './errors';

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

export interface Agent {
  readonly metadata: AgentMetadata;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly tools: readonly AgentToolRef[];
}

export interface CreateAgentProps {
  readonly metadata: AgentMetadata;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly tools: readonly AgentToolRef[];
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
    tools,
  };
}
