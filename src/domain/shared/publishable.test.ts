import { describe, expect, it } from 'vitest';
import { SharedValidationError } from './errors';
import {
  PUBLISH_STATES,
  deserializePublishableMetadata,
  isPublishState,
  serializePublishableMetadata,
  serializedPublishableMetadataSchema,
  validatePublishableMetadata,
  type PublishableMetadata,
} from './publishable';

/** fail 注入の検証に使う BC 固有エラーの代役。 */
class InjectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InjectedError';
  }
}

/** SemVer の代役(shared は tool の SemVer に依存しないため、テストも注入前提で書く)。 */
class FakeVersion {
  toString(): string {
    return '1.2.3';
  }
}

const fail = (m: string) => new InjectedError(m);
const isVersion = (v: unknown) => v instanceof FakeVersion;

function validMetadata(): PublishableMetadata<string, FakeVersion> {
  return {
    internalId: 'asset-1',
    workingName: 'work',
    displayName: 'Display',
    publishName: 'publish.name',
    version: new FakeVersion(),
    owner: 'alice',
    state: 'draft',
    tenant: { tenantId: 't1', workspaceId: 'w1' },
  };
}

describe('isPublishState / PUBLISH_STATES', () => {
  it.each(PUBLISH_STATES)('accepts %p', (state) => {
    expect(isPublishState(state)).toBe(true);
  });

  it.each(['live', '', 1, undefined])('rejects %p', (value) => {
    expect(isPublishState(value)).toBe(false);
  });
});

describe('validatePublishableMetadata', () => {
  it('returns a defensive copy that drops extra properties', () => {
    const input = { ...validMetadata(), extra: 'x' };
    const result = validatePublishableMetadata(input, 'createAsset', { fail, isVersion });
    expect(result).not.toBe(input);
    expect(result.tenant).not.toBe(input.tenant);
    expect(Object.keys(result).sort()).toEqual([
      'displayName',
      'internalId',
      'owner',
      'publishName',
      'state',
      'tenant',
      'version',
      'workingName',
    ]);
  });

  it.each<[string, Partial<PublishableMetadata<string, FakeVersion>>, RegExp]>([
    ['internalId', { internalId: '' }, /^createAsset: metadata\.internalId must be a non-empty string$/],
    ['workingName', { workingName: ' ' }, /^createAsset: metadata\.workingName must be a non-empty string$/],
    ['displayName', { displayName: '' }, /^createAsset: metadata\.displayName must be a non-empty string$/],
    ['publishName', { publishName: '' }, /^createAsset: metadata\.publishName must be a non-empty string$/],
    ['owner', { owner: '' }, /^createAsset: metadata\.owner must be a non-empty string$/],
    [
      'tenant.tenantId',
      { tenant: { tenantId: '', workspaceId: 'w1' } },
      /^createAsset: metadata\.tenant\.tenantId must be a non-empty string$/,
    ],
    [
      'tenant.workspaceId',
      { tenant: { tenantId: 't1', workspaceId: '' } },
      /^createAsset: metadata\.tenant\.workspaceId must be a non-empty string$/,
    ],
    ['version', { version: '1.2.3' as unknown as FakeVersion }, /^createAsset: metadata\.version must be a SemVer instance$/],
    ['state', { state: 'live' as never }, /^createAsset: invalid state: live$/],
  ])('rejects invalid %s with the exact message', (_field, patch, pattern) => {
    expect(() => validatePublishableMetadata({ ...validMetadata(), ...patch }, 'createAsset', { fail, isVersion })).toThrow(
      pattern,
    );
    expect(() => validatePublishableMetadata({ ...validMetadata(), ...patch }, 'createAsset', { fail, isVersion })).toThrow(
      InjectedError,
    );
  });

  it('validates internalId first (order contract pinned by golden tests)', () => {
    const input = { internalId: '' } as unknown as PublishableMetadata<string, FakeVersion>;
    expect(() => validatePublishableMetadata(input, 'createAsset', { fail, isVersion })).toThrow(
      /^createAsset: metadata\.internalId must be a non-empty string$/,
    );
  });

  it('throws tenantGuardMessage when tenant is not an object and the option is given (tool 互換)', () => {
    const input = { ...validMetadata(), tenant: undefined } as unknown as PublishableMetadata<string, FakeVersion>;
    expect(() =>
      validatePublishableMetadata(input, 'createTool', { fail, isVersion, tenantGuardMessage: 'createTool: metadata.tenant is required' }),
    ).toThrow(/^createTool: metadata\.tenant is required$/);
    // オプション未指定の BC は tenantId の非空エラーへ落ちる。
    expect(() => validatePublishableMetadata(input, 'createAsset', { fail, isVersion })).toThrow(
      /^createAsset: metadata\.tenant\.tenantId must be a non-empty string$/,
    );
  });

  it('honors trim: false (tool の非trim意味論)', () => {
    const input = { ...validMetadata(), internalId: ' ' };
    expect(() => validatePublishableMetadata(input, 'createTool', { fail, isVersion, trim: false })).not.toThrow();
    expect(() => validatePublishableMetadata(input, 'createAsset', { fail, isVersion })).toThrow(InjectedError);
  });

  it('throws SharedValidationError when fail is the default', () => {
    const input = { ...validMetadata(), internalId: '' };
    expect(() =>
      validatePublishableMetadata(input, 'createAsset', { fail: (m) => new SharedValidationError(m), isVersion }),
    ).toThrow(SharedValidationError);
  });
});

describe('serialize / deserialize round-trip', () => {
  it('serializes version via toString and copies tenant', () => {
    const serialized = serializePublishableMetadata(validMetadata());
    expect(serialized.version).toBe('1.2.3');
    expect(serialized.tenant).toEqual({ tenantId: 't1', workspaceId: 'w1' });
    expect(serializedPublishableMetadataSchema.safeParse(serialized).success).toBe(true);
  });

  it('deserializes via the injected parseVersion', () => {
    const serialized = serializePublishableMetadata(validMetadata());
    const restored = deserializePublishableMetadata(serialized, (text) => `parsed:${text}`);
    expect(restored.version).toBe('parsed:1.2.3');
    expect(restored.internalId).toBe('asset-1');
    expect(restored.tenant).not.toBe(serialized.tenant);
  });

  it('schema rejects an invalid state', () => {
    const serialized = { ...serializePublishableMetadata(validMetadata()), state: 'live' };
    expect(serializedPublishableMetadataSchema.safeParse(serialized).success).toBe(false);
  });
});
