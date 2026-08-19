/**
 * domain/shared の既定検証エラーが 400 に写ることの固定(ADR-0035 の安全網)。
 * 既存の error-mapping.test.ts は変更しない(純増分)。
 */
import { describe, expect, it } from 'vitest';
import { SharedValidationError } from '../domain/shared/errors';
import { toHttpError } from './error-mapping';

describe('toHttpError (SharedValidationError)', () => {
  it('maps SharedValidationError to 400 with code DOMAIN_VALIDATION', () => {
    const result = toHttpError(new SharedValidationError('scope.tenantId must be a non-empty string'));
    expect(result).toEqual({
      status: 400,
      body: { error: { code: 'DOMAIN_VALIDATION', message: 'scope.tenantId must be a non-empty string' } },
    });
  });

  it('does not shadow the unknown-error fallback', () => {
    expect(toHttpError(new Error('boom'))).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'internal error' } },
    });
  });
});
