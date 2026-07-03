import { createAgent, type Agent, type AgentKind } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentValidationError } from '../../domain/agent/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';

export interface SaveAgentInput {
  readonly scope: TenantScope;
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly kind: AgentKind;
  readonly systemPrompt: string;
  readonly tools: readonly { readonly internalId: string; readonly version: SemVer }[];
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
}

export class SaveAgentUseCase {
  constructor(private readonly agents: AgentRepository, private readonly tools: ToolRepository) {}

  async execute(input: SaveAgentInput): Promise<Agent> {
    for (const ref of input.tools) {
      if (await this.tools.findVersion(input.scope, ref.internalId, ref.version) === null) {
        throw new AgentValidationError(`SaveAgent: referenced tool not found: ${ref.internalId}@${ref.version.toString()}`);
      }
    }
    const versions = await this.agents.listVersions(input.scope, input.internalId);
    const version = versions.length === 0 ? SemVer.of(1, 0, 0) : max(versions).bump(input.bump ?? 'patch');
    const agent = createAgent({
      metadata: {
        internalId: input.internalId, workingName: input.workingName, displayName: input.displayName,
        publishName: input.publishName, version, owner: input.owner,
        state: input.state ?? 'draft', tenant: input.scope,
      },
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
    });
    await this.agents.save(agent);
    return agent;
  }
}

function max(versions: readonly SemVer[]): SemVer {
  return versions.reduce((current, version) => version.compare(current) > 0 ? version : current);
}
