import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import { createAgentHarness, type AgentHarness, type AgentSlot, type HarnessOutputPolicy, type HarnessPattern, type HarnessPolicies, type HarnessTopology } from '../../domain/harness/agent-harness';
import type { AgentHarnessRepository } from '../../domain/harness/harness-repository';
import { HarnessValidationError } from '../../domain/harness/errors';
import type { HarnessId } from '../../domain/harness/ids';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';

export interface SaveHarnessInput {
  readonly scope: TenantScope;
  readonly internalId: HarnessId;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly pattern: HarnessPattern;
  readonly slots: readonly AgentSlot[];
  readonly topology: HarnessTopology;
  readonly policies?: HarnessPolicies;
  readonly output?: HarnessOutputPolicy;
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
}

export async function assertHarnessAssignments(input: SaveHarnessInput, agents: AgentRepository): Promise<void> {
  for (const slot of input.slots) {
    const agent = await agents.findVersion(input.scope, slot.assignment.internalId, slot.assignment.version);
    if (agent === null) throw new AgentNotFoundError(`SaveHarness: assigned agent not found: ${slot.assignment.internalId}@${slot.assignment.version.toString()}`);
  }
}

export function buildHarness(input: SaveHarnessInput, version: SemVer): AgentHarness {
  return createAgentHarness({
    metadata: { internalId: input.internalId, workingName: input.workingName, displayName: input.displayName, publishName: input.publishName, version, owner: input.owner, state: input.state ?? 'draft', tenant: input.scope },
    pattern: input.pattern, slots: input.slots, topology: input.topology, ...(input.policies !== undefined ? { policies: input.policies } : {}), ...(input.output !== undefined ? { output: input.output } : {}),
  });
}

export class SaveHarnessUseCase {
  constructor(private readonly harnesses: AgentHarnessRepository, private readonly agents: AgentRepository) {}
  async execute(input: SaveHarnessInput): Promise<AgentHarness> {
    await assertHarnessAssignments(input, this.agents);
    const versions = await this.harnesses.listVersions(input.scope, input.internalId);
    const version = versions.length === 0 ? SemVer.of(1, 0, 0) : latest(versions).bump(input.bump ?? 'patch');
    const harness = buildHarness(input, version);
    await this.harnesses.save(harness);
    return harness;
  }
}

function latest(versions: readonly SemVer[]): SemVer {
  if (versions.length === 0) throw new HarnessValidationError('SaveHarness: expected at least one version');
  return versions.reduce((current, value) => value.compare(current) > 0 ? value : current);
}
