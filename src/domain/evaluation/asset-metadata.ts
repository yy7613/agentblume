import { assertNonEmpty } from '../shared/assert';
import { validatePublishableMetadata, type PublishableMetadata } from '../shared/publishable';
import { SemVer } from '../tool/semver';
import { EvaluationDomainError } from './errors';

export type EvaluationAssetMetadata = PublishableMetadata<string, SemVer>;

export function evaluationNonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, field, (m) => new EvaluationDomainError(m));
}

export function validateEvaluationMetadata(metadata: EvaluationAssetMetadata, label: string): EvaluationAssetMetadata {
  return validatePublishableMetadata(metadata, label, {
    fail: (m) => new EvaluationDomainError(m),
    isVersion: (v) => v instanceof SemVer,
  });
}
