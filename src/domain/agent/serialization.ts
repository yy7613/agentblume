import { z } from 'zod';
import { PUBLISH_STATES, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { AGENT_KINDS, createAgent, type Agent, type AgentKind } from './agent';
import { AgentValidationError } from './errors';
import { STRUCTURED_OUTPUT_TYPES, type StructuredOutputDefinition } from './structured-output';

export interface SerializedAgent {
  readonly metadata: {
    readonly internalId: string;
    readonly workingName: string;
    readonly displayName: string;
    readonly publishName: string;
    readonly version: string;
    readonly owner: string;
    readonly state: PublishState;
    readonly tenant: { readonly tenantId: string; readonly workspaceId: string };
  };
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly skills: readonly { readonly internalId: string; readonly version: string }[];
  readonly tools: readonly { readonly internalId: string; readonly version: string }[];
  readonly output?: StructuredOutputDefinition;
}

const schema = z.object({
  metadata: z.object({
    internalId: z.string(), workingName: z.string(), displayName: z.string(), publishName: z.string(),
    version: z.string(), owner: z.string(),
    state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]),
    tenant: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  }),
  kind: z.enum(AGENT_KINDS),
  systemPrompt: z.string(),
  skills: z.array(z.object({ internalId: z.string(), version: z.string() })).default([]),
  tools: z.array(z.object({ internalId: z.string(), version: z.string() })),
  output: z.object({
    name: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.enum(STRUCTURED_OUTPUT_TYPES),
      required: z.boolean(),
      description: z.string().optional(),
    })),
  }).optional(),
});

export function serializeAgent(agent: Agent): SerializedAgent {
  return {
    metadata: {
      ...agent.metadata,
      version: agent.metadata.version.toString(),
      tenant: { ...agent.metadata.tenant },
    },
    kind: agent.kind,
    systemPrompt: agent.systemPrompt,
    skills: agent.skills.map((skill) => ({ internalId: skill.internalId, version: skill.version.toString() })),
    tools: agent.tools.map((tool) => ({ internalId: tool.internalId, version: tool.version.toString() })),
    ...(agent.output !== undefined ? { output: structuredClone(agent.output) } : {}),
  };
}

export function deserializeAgent(value: unknown): Agent {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new AgentValidationError(`deserializeAgent: invalid SerializedAgent: ${issues}`);
  }
  const agent = parsed.data;
  return createAgent({
    metadata: {
      ...agent.metadata,
      version: SemVer.parse(agent.metadata.version),
      tenant: { ...agent.metadata.tenant },
    },
    kind: agent.kind,
    systemPrompt: agent.systemPrompt,
    skills: agent.skills.map((skill) => ({ internalId: skill.internalId, version: SemVer.parse(skill.version) })),
    tools: agent.tools.map((tool) => ({ internalId: tool.internalId, version: SemVer.parse(tool.version) })),
    ...(agent.output !== undefined ? { output: agent.output } : {}),
  });
}
