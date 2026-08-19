import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { Agent, AgentKind } from '../../domain/agent/agent';
import type { AgentId } from '../../domain/agent/ids';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryAgentsUseCase {
  constructor(private readonly repo: AgentRepository) {}
  async list(scope: TenantScope, kind?: AgentKind): Promise<AgentSummary[]> {
    const agents = await this.repo.list(scope);
    return kind === undefined ? agents : agents.filter((agent) => agent.kind === kind);
  }
  versions(scope: TenantScope, internalId: AgentId): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: AgentId, version?: SemVer): Promise<Agent> {
    const agent = version === undefined
      ? await this.repo.findLatest(scope, internalId)
      : await this.repo.findVersion(scope, internalId, version);
    if (agent === null) throw new AgentNotFoundError(`Agent not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return agent;
  }
}
