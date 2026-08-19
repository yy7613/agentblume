import { z } from 'zod';
import { deserializePublishableMetadata, serializePublishableMetadata, serializedPublishableMetadataSchema, type SerializedPublishableMetadata } from '../shared/publishable';
import { SemVer } from '../tool/semver';
import { HARNESS_PATTERNS, createAgentHarness, type AgentHarness, type HarnessPattern } from './agent-harness';
import { HarnessValidationError } from './errors';

export interface SerializedAgentHarness {
  readonly metadata: SerializedPublishableMetadata;
  readonly pattern: HarnessPattern;
  readonly slots: readonly { readonly id: string; readonly label: string; readonly purpose: string; readonly assignment: { readonly internalId: string; readonly version: string } }[];
  readonly topology: unknown;
  readonly policies: unknown;
  readonly output: { readonly format: 'text' };
}

const slotSchema = z.object({ id: z.string(), label: z.string(), purpose: z.string(), assignment: z.object({ internalId: z.string(), version: z.string() }) });
const topologySchema = z.discriminatedUnion('pattern', [
  z.object({ pattern: z.literal('agent-as-tools'), coordinatorSlotId: z.string(), participantSlotIds: z.array(z.string()) }),
  z.object({ pattern: z.literal('sequential'), orderedSlotIds: z.array(z.string()), contextMode: z.enum(['full-conversation', 'previous-response']) }),
  z.object({ pattern: z.literal('concurrent'), participantSlotIds: z.array(z.string()), aggregation: z.enum(['collect', 'vote', 'agent']), aggregatorSlotId: z.string().optional() }),
  z.object({ pattern: z.literal('handoff'), startSlotId: z.string(), transitions: z.array(z.object({ fromSlotId: z.string(), toSlotId: z.string(), condition: z.string() })), autonomous: z.boolean() }),
  z.object({ pattern: z.literal('group-chat'), participantSlotIds: z.array(z.string()), selector: z.enum(['round-robin', 'fixed-order', 'agent']), managerSlotId: z.string().optional(), maxRounds: z.number() }),
  z.object({ pattern: z.literal('magentic'), managerSlotId: z.string(), participantSlotIds: z.array(z.string()), maxRounds: z.number(), maxStalls: z.number(), maxResets: z.number(), requirePlanSignoff: z.boolean() }),
]);
const policiesSchema = z.object({
  budget: z.object({ maxDurationMs: z.number(), maxParticipantRuns: z.number(), maxModelRounds: z.number(), maxToolCalls: z.number(), maxParallelism: z.number() }),
  context: z.enum(['task-only', 'previous-response', 'full-conversation']),
  planning: z.object({ enabled: z.boolean(), requireApproval: z.boolean() }),
  memory: z.object({ wikiIds: z.array(z.string()), sessionWorkspace: z.boolean() }),
  approvals: z.object({ mode: z.enum(['inherit-agent', 'always', 'disabled-in-preview']) }),
  failure: z.object({ mode: z.enum(['fail-fast', 'collect', 'continue-with-error']) }),
});
const schema = z.object({
  metadata: serializedPublishableMetadataSchema,
  pattern: z.enum(HARNESS_PATTERNS), slots: z.array(slotSchema), topology: topologySchema, policies: policiesSchema, output: z.object({ format: z.literal('text') }),
});

export function serializeAgentHarness(harness: AgentHarness): SerializedAgentHarness {
  return {
    metadata: serializePublishableMetadata(harness.metadata),
    pattern: harness.pattern,
    slots: harness.slots.map((slot) => ({ ...slot, assignment: { internalId: slot.assignment.internalId, version: slot.assignment.version.toString() } })),
    topology: structuredClone(harness.topology), policies: structuredClone(harness.policies), output: { format: 'text' },
  };
}

export function deserializeAgentHarness(value: unknown): AgentHarness {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HarnessValidationError(`deserializeAgentHarness: invalid SerializedAgentHarness: ${issues}`);
  }
  const harness = parsed.data;
  return createAgentHarness({
    metadata: deserializePublishableMetadata(harness.metadata, (text) => SemVer.parse(text)),
    pattern: harness.pattern,
    slots: harness.slots.map((slot) => ({ ...slot, assignment: { internalId: slot.assignment.internalId, version: SemVer.parse(slot.assignment.version) } })),
    topology: harness.topology, policies: harness.policies, output: harness.output,
  });
}
