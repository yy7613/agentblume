import type { AgentHarness } from '../../domain/harness/agent-harness';
import type { AgentHarnessRepository, HarnessSummary } from '../../domain/harness/harness-repository';
import { HarnessNotFoundError } from '../../domain/harness/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryHarnessesUseCase {
  constructor(private readonly repo: AgentHarnessRepository) {}
  list(scope: TenantScope): Promise<HarnessSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: string, version?: SemVer): Promise<AgentHarness> {
    const harness = version === undefined ? await this.repo.findLatest(scope, internalId) : await this.repo.findVersion(scope, internalId, version);
    if (harness === null) throw new HarnessNotFoundError(`Harness not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return harness;
  }
}
