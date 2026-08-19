/**
 * ドメイン: 検証コンテキスト共通のバージョン付きメタデータ（v16 実装契約 §2）
 *
 * 共通メタ形の実体は shared/publishable.ts へ統合済み(M3)。ここでは
 * ValidationDomainError と SemVer 検査を注入した BC 別名・委譲のみを残す。
 */
import { assertNonEmpty } from '../shared/assert';
import { validatePublishableMetadata, type PublishableMetadata } from '../shared/publishable';
import { SemVer } from '../tool/semver';
import { ValidationDomainError } from './errors';

export type ValidationMetadata = PublishableMetadata<string, SemVer>;

/** 非空文字列を検証する（違反 → ValidationDomainError）。 */
export function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, field, (m) => new ValidationDomainError(m));
}

/** 共通メタデータの不変条件を検証し、防御的コピーを返す。 */
export function validateMetadata(metadata: ValidationMetadata, label: string): ValidationMetadata {
  return validatePublishableMetadata(metadata, label, {
    fail: (m) => new ValidationDomainError(m),
    isVersion: (v) => v instanceof SemVer,
  });
}
