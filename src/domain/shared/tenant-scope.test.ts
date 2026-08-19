import { describe, expect, it } from 'vitest';
import { SharedValidationError } from './errors';
import { createTenantScope, isTenantScope, tenantKey } from './tenant-scope';

/** fail 注入の検証に使う BC 固有エラーの代役。 */
class InjectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InjectedError';
  }
}

describe('tenantKey', () => {
  it('joins tenantId and workspaceId with a single space', () => {
    expect(tenantKey({ tenantId: 't1', workspaceId: 'w1' })).toBe('t1 w1');
  });

  it('produces distinct keys for distinct scopes', () => {
    expect(tenantKey({ tenantId: 't1', workspaceId: 'w2' })).not.toBe(tenantKey({ tenantId: 't1', workspaceId: 'w1' }));
  });
});

describe('isTenantScope', () => {
  it.each<[unknown, boolean]>([
    [{ tenantId: 't1', workspaceId: 'w1' }, true],
    // 構造ガードのため値の非空までは見ない(非空検証は createTenantScope が担う)。
    [{ tenantId: '', workspaceId: '' }, true],
    [{ tenantId: 't1', workspaceId: 'w1', extra: 1 }, true],
    [null, false],
    [undefined, false],
    ['t1 w1', false],
    [123, false],
    [{}, false],
    [{ tenantId: 't1' }, false],
    [{ workspaceId: 'w1' }, false],
    [{ tenantId: 1, workspaceId: 'w1' }, false],
    [{ tenantId: 't1', workspaceId: null }, false],
  ])('classifies %p as %p', (value, expected) => {
    expect(isTenantScope(value)).toBe(expected);
  });
});

describe('createTenantScope', () => {
  it('returns a frozen defensive copy', () => {
    const input = { tenantId: 't1', workspaceId: 'w1' };
    const scope = createTenantScope(input);
    expect(scope).toEqual({ tenantId: 't1', workspaceId: 'w1' });
    // 防御的コピー: 入力オブジェクトとは非同一参照で、呼び出し側の変更から隔離される。
    expect(scope).not.toBe(input);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it.each([null, undefined, 'text', 123, {}, { tenantId: 't1' }])('rejects non-TenantScope %p', (value) => {
    expect(() => createTenantScope(value)).toThrow(SharedValidationError);
    // 既定 label は 'createTenantScope: scope'。
    expect(() => createTenantScope(value)).toThrow(/^createTenantScope: scope must be a TenantScope object$/);
  });

  it('rejects an empty tenantId with the exact message', () => {
    expect(() => createTenantScope({ tenantId: '', workspaceId: 'w1' })).toThrow(
      /^createTenantScope: scope\.tenantId must be a non-empty string$/,
    );
  });

  it('rejects an empty workspaceId with the exact message', () => {
    expect(() => createTenantScope({ tenantId: 't1', workspaceId: '' })).toThrow(
      /^createTenantScope: scope\.workspaceId must be a non-empty string$/,
    );
  });

  it('rejects a whitespace-only tenantId (trim semantics)', () => {
    expect(() => createTenantScope({ tenantId: ' ', workspaceId: 'w1' })).toThrow(SharedValidationError);
  });

  // tenantKey() のスペース区切りキーが衝突しないための前提(識別子は空白を含まないトークン)の強制。
  // 例: {'a b','c'} と {'a','b c'} はどちらもキー 'a b c' になるため、生成点で拒否する。
  it.each([
    [{ tenantId: 'a b', workspaceId: 'w1' }, /^createTenantScope: scope\.tenantId must not contain whitespace$/],
    [{ tenantId: 't1', workspaceId: 'b\tc' }, /^createTenantScope: scope\.workspaceId must not contain whitespace$/],
  ])('rejects an id containing whitespace %p', (input, pattern) => {
    expect(() => createTenantScope(input)).toThrow(pattern);
  });

  it('strips extra properties in the defensive copy', () => {
    const scope = createTenantScope({ tenantId: 't1', workspaceId: 'w1', extra: 'x' });
    expect(Object.keys(scope).sort()).toEqual(['tenantId', 'workspaceId']);
  });

  it('uses the injected label as the message prefix', () => {
    expect(() => createTenantScope(null, { label: 'createAgent: metadata.tenant' })).toThrow(
      /^createAgent: metadata\.tenant must be a TenantScope object$/,
    );
    expect(() => createTenantScope({ tenantId: '', workspaceId: 'w1' }, { label: 'createAgent: metadata.tenant' })).toThrow(
      /^createAgent: metadata\.tenant\.tenantId must be a non-empty string$/,
    );
  });

  it('throws the injected error type via fail', () => {
    expect(() => createTenantScope(null, { fail: (m) => new InjectedError(m) })).toThrow(InjectedError);
    expect(() => createTenantScope({ tenantId: '', workspaceId: 'w1' }, { fail: (m) => new InjectedError(m) })).toThrow(
      InjectedError,
    );
  });
});
