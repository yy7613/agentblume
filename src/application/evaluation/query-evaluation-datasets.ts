import type { EvaluationDatasetRepository, EvaluationDatasetSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationDatasetNotFoundError } from '../../domain/evaluation/errors';
import type { EvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryEvaluationDatasetsUseCase {
  constructor(private readonly repo: EvaluationDatasetRepository) {}
  list(scope: TenantScope): Promise<EvaluationDatasetSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, internalId: string): Promise<SemVer[]> { return this.repo.listVersions(scope, internalId); }
  async get(scope: TenantScope, internalId: string, version?: SemVer): Promise<EvaluationDataset> {
    const dataset = version === undefined ? await this.repo.findLatest(scope, internalId) : await this.repo.findVersion(scope, internalId, version);
    if (dataset === null) throw new EvaluationDatasetNotFoundError(`Evaluation dataset not found: ${internalId}${version === undefined ? '' : `@${version.toString()}`}`);
    return dataset;
  }
}
