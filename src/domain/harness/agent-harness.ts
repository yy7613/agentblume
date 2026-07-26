import type { TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { HarnessValidationError } from './errors';

export const HARNESS_PATTERNS = ['agent-as-tools', 'sequential', 'concurrent', 'handoff', 'group-chat', 'magentic'] as const;
export type HarnessPattern = (typeof HARNESS_PATTERNS)[number];

export interface HarnessMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: SemVer;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

export interface HarnessAgentRef { readonly internalId: string; readonly version: SemVer; }
export interface AgentSlot {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  readonly assignment: HarnessAgentRef;
}

export type HarnessTopology =
  | { readonly pattern: 'agent-as-tools'; readonly coordinatorSlotId: string; readonly participantSlotIds: readonly string[] }
  | { readonly pattern: 'sequential'; readonly orderedSlotIds: readonly string[]; readonly contextMode: 'full-conversation' | 'previous-response' }
  | { readonly pattern: 'concurrent'; readonly participantSlotIds: readonly string[]; readonly aggregation: 'collect' | 'vote' | 'agent'; readonly aggregatorSlotId?: string }
  | { readonly pattern: 'handoff'; readonly startSlotId: string; readonly transitions: readonly HandoffTransition[]; readonly autonomous: boolean }
  | { readonly pattern: 'group-chat'; readonly participantSlotIds: readonly string[]; readonly selector: 'round-robin' | 'fixed-order' | 'agent'; readonly managerSlotId?: string; readonly maxRounds: number }
  | { readonly pattern: 'magentic'; readonly managerSlotId: string; readonly participantSlotIds: readonly string[]; readonly maxRounds: number; readonly maxStalls: number; readonly maxResets: number; readonly requirePlanSignoff: boolean };

export interface HandoffTransition { readonly fromSlotId: string; readonly toSlotId: string; readonly condition: string; }
export interface HarnessPolicies {
  readonly budget: { readonly maxDurationMs: number; readonly maxParticipantRuns: number; readonly maxModelRounds: number; readonly maxToolCalls: number; readonly maxParallelism: number };
  readonly context: 'task-only' | 'previous-response' | 'full-conversation';
  readonly planning: { readonly enabled: boolean; readonly requireApproval: boolean };
  readonly memory: { readonly wikiIds: readonly string[]; readonly sessionWorkspace: boolean };
  readonly approvals: { readonly mode: 'inherit-agent' | 'always' | 'disabled-in-preview' };
  readonly failure: { readonly mode: 'fail-fast' | 'collect' | 'continue-with-error' };
}

export interface HarnessOutputPolicy { readonly format: 'text'; }
export interface AgentHarness {
  readonly metadata: HarnessMetadata;
  readonly pattern: HarnessPattern;
  readonly slots: readonly AgentSlot[];
  readonly topology: HarnessTopology;
  readonly policies: HarnessPolicies;
  readonly output: HarnessOutputPolicy;
}

export interface CreateAgentHarnessProps {
  readonly metadata: HarnessMetadata;
  readonly pattern: HarnessPattern;
  readonly slots: readonly AgentSlot[];
  readonly topology: HarnessTopology;
  readonly policies?: HarnessPolicies;
  readonly output?: HarnessOutputPolicy;
}

export const DEFAULT_HARNESS_POLICIES: HarnessPolicies = {
  budget: { maxDurationMs: 120_000, maxParticipantRuns: 20, maxModelRounds: 40, maxToolCalls: 100, maxParallelism: 4 },
  context: 'task-only', planning: { enabled: false, requireApproval: false }, memory: { wikiIds: [], sessionWorkspace: true },
  approvals: { mode: 'inherit-agent' }, failure: { mode: 'fail-fast' },
};

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HarnessValidationError(`createAgentHarness: ${field} must be a non-empty string`);
}
function limit(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new HarnessValidationError(`createAgentHarness: ${field} must be an integer from ${min} to ${max}`);
}
function idsExist(slotIds: readonly string[], slots: ReadonlyMap<string, AgentSlot>, field: string, min: number): void {
  if (slotIds.length < min) throw new HarnessValidationError(`createAgentHarness: ${field} must contain at least ${min} slot(s)`);
  const seen = new Set<string>();
  for (const id of slotIds) {
    text(id, field);
    if (!slots.has(id)) throw new HarnessValidationError(`createAgentHarness: ${field} references unknown slot: ${id}`);
    if (seen.has(id)) throw new HarnessValidationError(`createAgentHarness: ${field} contains duplicate slot: ${id}`);
    seen.add(id);
  }
}
function slot(slots: ReadonlyMap<string, AgentSlot>, id: string, field: string): void {
  text(id, field);
  if (!slots.has(id)) throw new HarnessValidationError(`createAgentHarness: ${field} references unknown slot: ${id}`);
}

function validateTopology(topology: HarnessTopology, slots: ReadonlyMap<string, AgentSlot>): void {
  switch (topology.pattern) {
    case 'agent-as-tools':
      slot(slots, topology.coordinatorSlotId, 'topology.coordinatorSlotId');
      idsExist(topology.participantSlotIds, slots, 'topology.participantSlotIds', 1);
      if (topology.participantSlotIds.includes(topology.coordinatorSlotId)) throw new HarnessValidationError('createAgentHarness: coordinator must not be a participant');
      return;
    case 'sequential':
      idsExist(topology.orderedSlotIds, slots, 'topology.orderedSlotIds', 2);
      if (topology.contextMode !== 'full-conversation' && topology.contextMode !== 'previous-response') throw new HarnessValidationError('createAgentHarness: invalid sequential contextMode');
      return;
    case 'concurrent':
      idsExist(topology.participantSlotIds, slots, 'topology.participantSlotIds', 2);
      if (!['collect', 'vote', 'agent'].includes(topology.aggregation)) throw new HarnessValidationError('createAgentHarness: invalid concurrent aggregation');
      if (topology.aggregation === 'agent') {
        if (topology.aggregatorSlotId === undefined) throw new HarnessValidationError('createAgentHarness: agent aggregation requires aggregatorSlotId');
        slot(slots, topology.aggregatorSlotId, 'topology.aggregatorSlotId');
        if (topology.participantSlotIds.includes(topology.aggregatorSlotId)) throw new HarnessValidationError('createAgentHarness: aggregator must not be a participant');
      } else if (topology.aggregatorSlotId !== undefined) throw new HarnessValidationError('createAgentHarness: aggregatorSlotId is only allowed for agent aggregation');
      return;
    case 'handoff': {
      slot(slots, topology.startSlotId, 'topology.startSlotId');
      if (typeof topology.autonomous !== 'boolean') throw new HarnessValidationError('createAgentHarness: handoff autonomous must be boolean');
      if (topology.transitions.length === 0) throw new HarnessValidationError('createAgentHarness: handoff requires at least one transition');
      for (const [index, transition] of topology.transitions.entries()) {
        slot(slots, transition.fromSlotId, `topology.transitions.${index}.fromSlotId`);
        slot(slots, transition.toSlotId, `topology.transitions.${index}.toSlotId`);
        if (transition.fromSlotId === transition.toSlotId) throw new HarnessValidationError(`createAgentHarness: handoff transition ${index} cannot target itself`);
        text(transition.condition, `topology.transitions.${index}.condition`);
      }
      // 到達不能スロットを許容しない: 全スロットは startSlotId から遷移表を辿って到達できること。
      // 到達不能スロットは実行時に決して呼ばれない一方、compileでは output への辺が張られて
      // 出力に関与するように見えるため、設定ミスとして作成時に拒否する。
      const reachable = new Set<string>([topology.startSlotId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const transition of topology.transitions) {
          if (reachable.has(transition.fromSlotId) && !reachable.has(transition.toSlotId)) { reachable.add(transition.toSlotId); grew = true; }
        }
      }
      const unreachable = [...slots.keys()].filter((id) => !reachable.has(id));
      if (unreachable.length > 0) throw new HarnessValidationError(`createAgentHarness: handoff slots unreachable from start: ${unreachable.join(', ')}`);
      return;
    }
    case 'group-chat':
      idsExist(topology.participantSlotIds, slots, 'topology.participantSlotIds', 2);
      if (!['round-robin', 'fixed-order', 'agent'].includes(topology.selector)) throw new HarnessValidationError('createAgentHarness: invalid group-chat selector');
      limit(topology.maxRounds, 'topology.maxRounds', 1, 100);
      if (topology.selector === 'agent' && topology.managerSlotId === undefined) throw new HarnessValidationError('createAgentHarness: agent selector requires managerSlotId');
      if (topology.managerSlotId !== undefined) {
        slot(slots, topology.managerSlotId, 'topology.managerSlotId');
        // magenticと同じ不変条件: 進行役は参加者を兼ねない(実行時に進行役が発話者として二重に回るのを防ぎ、compileの自己辺も排除する)。
        if (topology.participantSlotIds.includes(topology.managerSlotId)) throw new HarnessValidationError('createAgentHarness: group-chat manager must not be a participant');
      }
      return;
    case 'magentic':
      slot(slots, topology.managerSlotId, 'topology.managerSlotId');
      idsExist(topology.participantSlotIds, slots, 'topology.participantSlotIds', 2);
      if (topology.participantSlotIds.includes(topology.managerSlotId)) throw new HarnessValidationError('createAgentHarness: magentic manager must not be a participant');
      limit(topology.maxRounds, 'topology.maxRounds', 1, 100);
      limit(topology.maxStalls, 'topology.maxStalls', 0, 100);
      limit(topology.maxResets, 'topology.maxResets', 0, 100);
      if (typeof topology.requirePlanSignoff !== 'boolean') throw new HarnessValidationError('createAgentHarness: requirePlanSignoff must be boolean');
      return;
  }
}

function validatePolicies(policies: HarnessPolicies): HarnessPolicies {
  limit(policies.budget.maxDurationMs, 'policies.budget.maxDurationMs', 1_000, 3_600_000);
  limit(policies.budget.maxParticipantRuns, 'policies.budget.maxParticipantRuns', 1, 100);
  limit(policies.budget.maxModelRounds, 'policies.budget.maxModelRounds', 1, 200);
  limit(policies.budget.maxToolCalls, 'policies.budget.maxToolCalls', 1, 500);
  limit(policies.budget.maxParallelism, 'policies.budget.maxParallelism', 1, 32);
  if (!['task-only', 'previous-response', 'full-conversation'].includes(policies.context)) throw new HarnessValidationError('createAgentHarness: invalid policies.context');
  if (typeof policies.planning?.enabled !== 'boolean' || typeof policies.planning?.requireApproval !== 'boolean') throw new HarnessValidationError('createAgentHarness: invalid policies.planning');
  if (!Array.isArray(policies.memory?.wikiIds) || typeof policies.memory?.sessionWorkspace !== 'boolean') throw new HarnessValidationError('createAgentHarness: invalid policies.memory');
  if (!['inherit-agent', 'always', 'disabled-in-preview'].includes(policies.approvals?.mode)) throw new HarnessValidationError('createAgentHarness: invalid policies.approvals.mode');
  if (!['fail-fast', 'collect', 'continue-with-error'].includes(policies.failure?.mode)) throw new HarnessValidationError('createAgentHarness: invalid policies.failure.mode');
  return {
    budget: { ...policies.budget }, context: policies.context, planning: { ...policies.planning },
    memory: { wikiIds: [...policies.memory.wikiIds], sessionWorkspace: policies.memory.sessionWorkspace },
    approvals: { ...policies.approvals }, failure: { ...policies.failure },
  };
}

export function createAgentHarness(props: CreateAgentHarnessProps): AgentHarness {
  const { metadata } = props;
  if (metadata === null || typeof metadata !== 'object') throw new HarnessValidationError('createAgentHarness: metadata is required');
  text(metadata.internalId, 'metadata.internalId'); text(metadata.workingName, 'metadata.workingName'); text(metadata.displayName, 'metadata.displayName');
  text(metadata.publishName, 'metadata.publishName'); text(metadata.owner, 'metadata.owner'); text(metadata.tenant?.tenantId, 'metadata.tenant.tenantId'); text(metadata.tenant?.workspaceId, 'metadata.tenant.workspaceId');
  if (!(metadata.version instanceof SemVer)) throw new HarnessValidationError('createAgentHarness: metadata.version must be a SemVer instance');
  if (!isPublishState(metadata.state)) throw new HarnessValidationError(`createAgentHarness: invalid state: ${String(metadata.state)}`);
  if (!(HARNESS_PATTERNS as readonly unknown[]).includes(props.pattern)) throw new HarnessValidationError(`createAgentHarness: invalid pattern: ${String(props.pattern)}`);
  if (props.topology === null || props.topology.pattern !== props.pattern) throw new HarnessValidationError('createAgentHarness: topology pattern must match pattern');
  const slotMap = new Map<string, AgentSlot>();
  const slots = props.slots.map((item, index) => {
    text(item.id, `slots.${index}.id`); text(item.label, `slots.${index}.label`); text(item.purpose, `slots.${index}.purpose`); text(item.assignment?.internalId, `slots.${index}.assignment.internalId`);
    if (!(item.assignment?.version instanceof SemVer)) throw new HarnessValidationError(`createAgentHarness: slots.${index}.assignment.version must be a SemVer instance`);
    if (slotMap.has(item.id)) throw new HarnessValidationError(`createAgentHarness: duplicate slot id: ${item.id}`);
    const copy = { id: item.id, label: item.label, purpose: item.purpose, assignment: { internalId: item.assignment.internalId, version: item.assignment.version } };
    slotMap.set(item.id, copy); return copy;
  });
  validateTopology(props.topology, slotMap);
  const policies = validatePolicies(props.policies ?? DEFAULT_HARNESS_POLICIES);
  return {
    metadata: { ...metadata, tenant: { ...metadata.tenant } }, pattern: props.pattern, slots,
    topology: structuredClone(props.topology), policies, output: { format: props.output?.format ?? 'text' },
  };
}
