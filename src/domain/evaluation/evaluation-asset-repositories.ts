import type { TenantScope } from '../shared/tenant-scope';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { EvaluationDataset } from './evaluation-dataset';
import type { EvaluatorProfile } from './evaluator-profile';
import type { DatasetId, EvaluatorProfileId, JudgeRubricId } from './ids';
import type { JudgeRubric } from './judge-rubric';

export interface EvaluationDatasetSummary {
  readonly internalId: DatasetId;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly caseCount: number;
}

export interface EvaluatorProfileSummary {
  readonly internalId: EvaluatorProfileId;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly metricCount: number;
}

export interface JudgeRubricSummary {
  readonly internalId: JudgeRubricId;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly criterionCount: number;
}

export interface EvaluationDatasetRepository {
  save(dataset: EvaluationDataset): Promise<void>;
  findVersion(scope: TenantScope, internalId: DatasetId, version: SemVer): Promise<EvaluationDataset | null>;
  findLatest(scope: TenantScope, internalId: DatasetId): Promise<EvaluationDataset | null>;
  listVersions(scope: TenantScope, internalId: DatasetId): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<EvaluationDatasetSummary[]>;
  /** 論理削除。list/findLatestからは除外し、listVersionsは空配列を返す。findVersionは削除後も既存versionを返し続ける。戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, internalId: DatasetId): Promise<boolean>;
}

export interface EvaluatorProfileRepository {
  save(profile: EvaluatorProfile): Promise<void>;
  findVersion(scope: TenantScope, internalId: EvaluatorProfileId, version: SemVer): Promise<EvaluatorProfile | null>;
  findLatest(scope: TenantScope, internalId: EvaluatorProfileId): Promise<EvaluatorProfile | null>;
  listVersions(scope: TenantScope, internalId: EvaluatorProfileId): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<EvaluatorProfileSummary[]>;
  /** 論理削除。list/findLatestからは除外し、listVersionsは空配列を返す。findVersionは削除後も既存versionを返し続ける。戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, internalId: EvaluatorProfileId): Promise<boolean>;
}

export interface JudgeRubricRepository {
  save(rubric: JudgeRubric): Promise<void>;
  findVersion(scope: TenantScope, internalId: JudgeRubricId, version: SemVer): Promise<JudgeRubric | null>;
  findLatest(scope: TenantScope, internalId: JudgeRubricId): Promise<JudgeRubric | null>;
  listVersions(scope: TenantScope, internalId: JudgeRubricId): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<JudgeRubricSummary[]>;
  /** 論理削除。list/findLatestからは除外し、listVersionsは空配列を返す。findVersionは削除後も既存versionを返し続ける。戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, internalId: JudgeRubricId): Promise<boolean>;
}
