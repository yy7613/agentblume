import type { TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { EvaluationDomainError } from './errors';

export interface EvaluationAssetMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: SemVer;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

export function evaluationNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EvaluationDomainError(`${field} must be a non-empty string`);
  }
}

export function validateEvaluationMetadata(metadata: EvaluationAssetMetadata, label: string): EvaluationAssetMetadata {
  evaluationNonEmpty(metadata?.internalId, `${label}: metadata.internalId`);
  evaluationNonEmpty(metadata.workingName, `${label}: metadata.workingName`);
  evaluationNonEmpty(metadata.displayName, `${label}: metadata.displayName`);
  evaluationNonEmpty(metadata.publishName, `${label}: metadata.publishName`);
  evaluationNonEmpty(metadata.owner, `${label}: metadata.owner`);
  evaluationNonEmpty(metadata.tenant?.tenantId, `${label}: metadata.tenant.tenantId`);
  evaluationNonEmpty(metadata.tenant?.workspaceId, `${label}: metadata.tenant.workspaceId`);
  if (!(metadata.version instanceof SemVer)) {
    throw new EvaluationDomainError(`${label}: metadata.version must be a SemVer instance`);
  }
  if (!isPublishState(metadata.state)) {
    throw new EvaluationDomainError(`${label}: invalid state: ${String(metadata.state)}`);
  }
  return { ...metadata, tenant: { ...metadata.tenant } };
}
