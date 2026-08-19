/**
 * ドメイン: 検証コンテキスト共通のバージョン付きメタデータ（v16 実装契約 §2）
 *
 * Tool/Skill/Agent と同じ共通メタ形。検証は skill と同じ流儀（非空・SemVerインスタンス・state）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../tool/ids';
import { isPublishState, type PublishState } from '../tool/metadata';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';

export interface ValidationMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: SemVer;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

/** 非空文字列を検証する（違反 → ValidationDomainError）。 */
export function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, field, (m) => new ValidationDomainError(m));
}

/** 共通メタデータの不変条件を検証し、防御的コピーを返す。 */
export function validateMetadata(metadata: ValidationMetadata, label: string): ValidationMetadata {
  nonEmpty(metadata?.internalId, `${label}: metadata.internalId`);
  nonEmpty(metadata.workingName, `${label}: metadata.workingName`);
  nonEmpty(metadata.displayName, `${label}: metadata.displayName`);
  nonEmpty(metadata.publishName, `${label}: metadata.publishName`);
  nonEmpty(metadata.owner, `${label}: metadata.owner`);
  nonEmpty(metadata.tenant?.tenantId, `${label}: metadata.tenant.tenantId`);
  nonEmpty(metadata.tenant?.workspaceId, `${label}: metadata.tenant.workspaceId`);
  if (!(metadata.version instanceof SemVer)) {
    throw new ValidationDomainError(`${label}: metadata.version must be a SemVer instance`);
  }
  if (!isPublishState(metadata.state)) {
    throw new ValidationDomainError(`${label}: invalid state: ${String(metadata.state)}`);
  }
  return { ...metadata, tenant: { ...metadata.tenant } };
}
