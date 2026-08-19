import type { EvaluatorProfileRepository, EvaluatorProfileSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluatorProfileNotFoundError } from '../../domain/evaluation/errors';
import type { EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { EvaluatorProfileId } from '../../domain/evaluation/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { SemVer } from '../../domain/tool/semver';

export class QueryEvaluatorProfilesUseCase {
  constructor(private readonly repo: EvaluatorProfileRepository) {}
  list(scope: TenantScope): Promise<EvaluatorProfileSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: EvaluatorProfileId): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: EvaluatorProfileId, version?: SemVer): Promise<EvaluatorProfile> {
    const profile = version === undefined ? await this.repo.findLatest(scope, internalId) : await this.repo.findVersion(scope, internalId, version);
    if (profile === null) throw new EvaluatorProfileNotFoundError(`Evaluator profile not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return profile;
  }
}

/** 保存済みEvaluator Profileの論理削除。repository.delete が false(未存在/削除済み)なら EvaluatorProfileNotFoundError。 */
export class DeleteEvaluatorProfileUseCase {
  constructor(private readonly repo: EvaluatorProfileRepository) {}
  async execute(scope: TenantScope, internalId: EvaluatorProfileId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new EvaluatorProfileNotFoundError(`DeleteEvaluatorProfile: profile not found: ${internalId}`);
  }
}
