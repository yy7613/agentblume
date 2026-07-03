import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { Agent } from '../../domain/agent/agent';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryAgentsUseCase {
  constructor(private readonly repo: AgentRepository) {}
  list(scope: TenantScope): Promise<AgentSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: string, version?: SemVer): Promise<Agent> {
    const agent = version === undefined
      ? await this.repo.findLatest(scope, internalId)
      : await this.repo.findVersion(scope, internalId, version);
    if (agent === null) throw new AgentNotFoundError(`Agent not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return agent;
  }
}
