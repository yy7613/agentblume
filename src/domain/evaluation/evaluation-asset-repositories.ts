import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { EvaluationDataset } from './evaluation-dataset';
import type { EvaluatorProfile } from './evaluator-profile';
import type { JudgeRubric } from './judge-rubric';

export interface EvaluationDatasetSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly caseCount: number;
}

export interface EvaluatorProfileSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly metricCount: number;
}

export interface JudgeRubricSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly criterionCount: number;
}

export interface EvaluationDatasetRepository {
  save(dataset: EvaluationDataset): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<EvaluationDataset | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<EvaluationDataset | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<EvaluationDatasetSummary[]>;
}

export interface EvaluatorProfileRepository {
  save(profile: EvaluatorProfile): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<EvaluatorProfile | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<EvaluatorProfile | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<EvaluatorProfileSummary[]>;
}

export interface JudgeRubricRepository {
  save(rubric: JudgeRubric): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<JudgeRubric | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<JudgeRubric | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<JudgeRubricSummary[]>;
}
