import { describe, expect, it } from 'vitest';
import { SharedValidationError } from './errors';
import { assertIsoDateTime, isIsoDateTime, isoDateTime } from './time';

/** fail 注入の検証に使う BC 固有エラーの代役。 */
class InjectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InjectedError';
  }
}

describe('isoDateTime', () => {
  it('wraps Date#toISOString()', () => {
    const date = new Date('2026-01-02T03:04:05.678Z');
    expect(isoDateTime(date)).toBe(date.toISOString());
    expect(isoDateTime(date)).toBe('2026-01-02T03:04:05.678Z');
  });

  it('produces a value that satisfies isIsoDateTime', () => {
    expect(isIsoDateTime(isoDateTime(new Date()))).toBe(true);
  });
});

describe('isIsoDateTime', () => {
  it.each([
    '2026-01-02T03:04:05.678Z',
    '2026-01-02T03:04:05Z',
    '2026-01-02T03:04:05+09:00',
    '2026-01-02T03:04:05-05:00',
    '2026-01-02T03:04:05.123456789Z',
  ])('accepts the ISO 8601 date-time %p', (value) => {
    expect(isIsoDateTime(value)).toBe(true);
  });

  it.each([
    '',
    'not a date',
    '2026-01-02', // 日付のみ（時刻なし）
    '2026-01-02T03:04Z', // 秒なし
    '2026-01-02T03:04:05', // タイムゾーンなし
    '2026-01-02 03:04:05Z', // 区切りが空白
    '2026-01-02T03:04:05.1234567890Z', // 小数秒10桁（上限9桁）
    '2026-13-01T00:00:00Z', // 桁は合うが13月（Date.parse が NaN）
  ])('rejects the non-ISO string %p', (value) => {
    expect(isIsoDateTime(value)).toBe(false);
  });

  it.each([undefined, null, 123, {}, [], new Date()])('rejects the non-string %p', (value) => {
    expect(isIsoDateTime(value)).toBe(false);
  });
});

describe('assertIsoDateTime', () => {
  it('accepts an ISO 8601 date-time string', () => {
    expect(() => assertIsoDateTime('2026-01-02T03:04:05.678Z', 'label')).not.toThrow();
  });

  it('throws SharedValidationError with code DOMAIN_VALIDATION by default', () => {
    let caught: unknown;
    try {
      assertIsoDateTime('not a date', 'label');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SharedValidationError);
    expect((caught as SharedValidationError).code).toBe('DOMAIN_VALIDATION');
    expect((caught as SharedValidationError).name).toBe('SharedValidationError');
  });

  it('message is exactly `${label} must be an ISO 8601 date-time string`', () => {
    expect(() => assertIsoDateTime('not a date', 'label')).toThrow(/^label must be an ISO 8601 date-time string$/);
    // label に BC の前置詞を含めて渡す運用(createAgent: startedAt 等)でもそのまま前置される。
    expect(() => assertIsoDateTime(undefined, 'createAgent: startedAt')).toThrow(
      /^createAgent: startedAt must be an ISO 8601 date-time string$/,
    );
  });

  it('throws the injected error type via fail', () => {
    expect(() => assertIsoDateTime('not a date', 'label', (m) => new InjectedError(m))).toThrow(InjectedError);
    expect(() => assertIsoDateTime('not a date', 'label', (m) => new InjectedError(m))).not.toThrow(SharedValidationError);
  });
});
