import { describe, expect, it } from 'vitest';
import { assertHttpUrl, assertNonEmpty } from './assert';
import { SharedValidationError } from './errors';

/** fail 注入の検証に使う BC 固有エラーの代役。 */
class InjectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InjectedError';
  }
}

describe('assertNonEmpty', () => {
  it('accepts a non-empty string', () => {
    expect(() => assertNonEmpty('value', 'label')).not.toThrow();
  });

  it.each([undefined, null, 123, {}, '', ' ', '\t\n'])('rejects %p by default', (value) => {
    expect(() => assertNonEmpty(value, 'label')).toThrow(SharedValidationError);
  });

  it('allows a whitespace-only string when trim: false', () => {
    // tool BC の createTool は歴史的に trim しない(空白のみを許す)ための分岐。
    expect(() => assertNonEmpty(' ', 'label', undefined, { trim: false })).not.toThrow();
  });

  it('still rejects the empty string when trim: false', () => {
    expect(() => assertNonEmpty('', 'label', undefined, { trim: false })).toThrow(SharedValidationError);
  });

  it('throws SharedValidationError with code DOMAIN_VALIDATION by default', () => {
    let caught: unknown;
    try {
      assertNonEmpty('', 'label');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SharedValidationError);
    expect((caught as SharedValidationError).code).toBe('DOMAIN_VALIDATION');
    expect((caught as SharedValidationError).name).toBe('SharedValidationError');
  });

  it('throws the injected error type via fail', () => {
    expect(() => assertNonEmpty('', 'label', (m) => new InjectedError(m))).toThrow(InjectedError);
    expect(() => assertNonEmpty('', 'label', (m) => new InjectedError(m))).not.toThrow(SharedValidationError);
  });

  it('message is exactly `${label} must be a non-empty string`', () => {
    expect(() => assertNonEmpty('', 'label')).toThrow(/^label must be a non-empty string$/);
    // label に BC の前置詞を含めて渡す運用(createAgent: name 等)でもそのまま前置される。
    expect(() => assertNonEmpty('', 'createAgent: name')).toThrow(/^createAgent: name must be a non-empty string$/);
  });
});

describe('assertHttpUrl', () => {
  it.each(['https://example.com', 'http://localhost:1234/v1', '  https://example.com/path?q=1  '])(
    'accepts %p and returns the trimmed URL',
    (value) => {
      expect(assertHttpUrl(value, 'label')).toBe(value.trim());
    },
  );

  it('rejects a non-string / empty value with the nonEmpty message', () => {
    expect(() => assertHttpUrl(undefined, 'label')).toThrow(/^label must be a non-empty string$/);
    expect(() => assertHttpUrl(' ', 'label')).toThrow(/^label must be a non-empty string$/);
  });

  it('rejects an unparsable URL with the exact message', () => {
    expect(() => assertHttpUrl('not a url', 'label')).toThrow(/^label must be a valid URL: not a url$/);
    // `localhost:1234` は protocol が `localhost:` の相対省略形として URL 解釈されるため、次の http(s) 検査で落ちる。
    expect(() => assertHttpUrl('localhost:1234', 'label')).toThrow(/^label must use http\(s\): localhost:1234$/);
  });

  it.each(['ftp://example.com', 'file:///tmp/x', 'ws://example.com'])('rejects non-http(s) protocol %p', (value) => {
    expect(() => assertHttpUrl(value, 'label')).toThrow(/^label must use http\(s\): /);
  });

  it.each(['https://user:pass@example.com', 'https://user@example.com'])(
    'rejects embedded credentials %p without echoing the URL',
    (value) => {
      expect(() => assertHttpUrl(value, 'label')).toThrow(/^label must not embed credentials \(user:password@host\)$/);
    },
  );

  it('enforces maxLength after trimming with the exact message', () => {
    const url = `https://example.com/${'a'.repeat(10)}`;
    expect(() => assertHttpUrl(url, 'label', undefined, { maxLength: 20 })).toThrow(
      /^label must be at most 20 characters$/,
    );
    expect(assertHttpUrl(url, 'label', undefined, { maxLength: 512 })).toBe(url);
  });

  it('throws SharedValidationError by default and the injected error via fail', () => {
    class InjectedUrlError extends Error {}
    expect(() => assertHttpUrl('ftp://x', 'label')).toThrow(SharedValidationError);
    expect(() => assertHttpUrl('ftp://x', 'label', (m) => new InjectedUrlError(m))).toThrow(InjectedUrlError);
  });
});
