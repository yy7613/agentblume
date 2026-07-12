import type { EvaluatorProfileRepository, EvaluatorProfileSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluatorProfileNotFoundError } from '../../domain/evaluation/errors';
import type { EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryEvaluatorProfilesUseCase {
  constructor(private readonly repo: EvaluatorProfileRepository) {}
  list(scope: TenantScope): Promise<EvaluatorProfileSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: string, version?: SemVer): Promise<EvaluatorProfile> {
    const profile = version === undefined ? await this.repo.findLatest(scope, internalId) : await this.repo.findVersion(scope, internalId, version);
    if (profile === null) throw new EvaluatorProfileNotFoundError(`Evaluator profile not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return profile;
  }
}
