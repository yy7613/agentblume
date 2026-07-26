import { describe, expect, it } from 'vitest';
import { ModelSettingsValidationError } from './errors';
import { createModelSettings, createModelSlotSettings, modelSlot } from './model-settings';
import { createSealedSecret, isSealedSecret, secretHint } from './sealed-secret';
import { deserializeModelSettings, serializeModelSettings } from './serialization';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const sealed = { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: 'ZGF0YQ==', hint: 'cdef' } as const;

describe('SealedSecret', () => {
  it('形状を検証して複製する', () => {
    expect(createSealedSecret({ ...sealed, extra: 'ignored' })).toEqual(sealed);
    expect(isSealedSecret(sealed)).toBe(true);
  });

  it('不正な形状を拒否する', () => {
    expect(() => createSealedSecret(null)).toThrow(ModelSettingsValidationError);
    expect(() => createSealedSecret([])).toThrow(ModelSettingsValidationError);
    expect(() => createSealedSecret({ ...sealed, v: 2 })).toThrow(/v must be 1/);
    expect(() => createSealedSecret({ ...sealed, alg: 'aes-128-gcm' })).toThrow(/alg/);
    expect(() => createSealedSecret({ ...sealed, iv: '' })).toThrow(/iv/);
    expect(() => createSealedSecret({ ...sealed, tag: 'not base64!!' })).toThrow(/tag/);
    expect(() => createSealedSecret({ ...sealed, hint: 'too-long' })).toThrow(/hint/);
    expect(isSealedSecret({ ...sealed, iv: 1 })).toBe(false);
  });

  it('hint は平文の末尾4文字だけ（先頭は残さない）', () => {
    expect(secretHint('sk-super-secret-value-1234')).toBe('1234');
    expect(secretHint('ab')).toBe('ab');
    expect(secretHint('')).toBe('');
  });

  it('空の暗号文（空文字の封緘）は許す', () => {
    expect(createSealedSecret({ ...sealed, data: '' }).data).toBe('');
  });
});

describe('createModelSettings', () => {
  it('registry / openai-compatible の両スロットを検証して複製する', () => {
    const settings = createModelSettings({
      scope,
      main: { source: 'registry', model: 'openai/gpt-4o', apiKey: sealed },
      judge: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b' },
      updatedAt: '2026-07-26T00:00:00.000Z',
    });

    expect(settings.main).toEqual({ source: 'registry', model: 'openai/gpt-4o', apiKey: sealed });
    expect(settings.judge).toEqual({ source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-4b' });
    expect(modelSlot(settings, 'main')).toEqual(settings.main);
    expect(modelSlot(null, 'main')).toBeUndefined();
  });

  it('スロット未指定は「env既定を使う」を意味し、キーを持たない', () => {
    const settings = createModelSettings({ scope, updatedAt: '2026-07-26T00:00:00.000Z' });
    expect(settings.main).toBeUndefined();
    expect(settings.judge).toBeUndefined();
    expect(Object.keys(settings)).toEqual(['scope', 'updatedAt']);
  });

  it('scope / updatedAt の不正を拒否する', () => {
    expect(() => createModelSettings(null as never)).toThrow(/props is required/);
    expect(() => createModelSettings({ scope: { tenantId: '', workspaceId: 'w' }, updatedAt: 'x' })).toThrow(/scope.tenantId/);
    expect(() => createModelSettings({ scope: { tenantId: 't', workspaceId: ' ' }, updatedAt: 'x' })).toThrow(/scope.workspaceId/);
    expect(() => createModelSettings({ scope, updatedAt: '' })).toThrow(/updatedAt/);
  });

  it("registry の model は 'provider/model' 形式を要求する", () => {
    for (const model of ['gpt-4o', '/gpt-4o', 'openai/', '']) {
      expect(() => createModelSlotSettings({ source: 'registry', model }, 'main')).toThrow(ModelSettingsValidationError);
    }
    // ネストしたIDは modelId 側に残る（最初の / で分割する）。
    expect(createModelSlotSettings({ source: 'registry', model: 'fireworks/accounts/x/models/y' })).toEqual({ source: 'registry', model: 'fireworks/accounts/x/models/y' });
  });

  it('openai-compatible の baseUrl は http(s) のみ', () => {
    expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'ftp://host/v1', model: 'm' })).toThrow(/http\(s\)/);
    expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'not a url', model: 'm' })).toThrow(/valid URL/);
    expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'http://h/v1', model: '  ' })).toThrow(/model/);
    expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl: `http://h/${'x'.repeat(600)}`, model: 'm' })).toThrow(/at most/);
    expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'http://h/v1', model: 'x'.repeat(300) })).toThrow(/at most/);
  });

  it('未知の source / 非オブジェクトを拒否する', () => {
    expect(() => createModelSlotSettings({ source: 'anthropic-direct', model: 'x' })).toThrow(/source/);
    expect(() => createModelSlotSettings('main')).toThrow(/must be an object/);
    expect(() => createModelSlotSettings(null)).toThrow(/must be an object/);
  });
});

describe('serialization', () => {
  it('封緘済みキーを含めて往復する', () => {
    const settings = createModelSettings({
      scope,
      main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: sealed },
      judge: { source: 'registry', model: 'openai/gpt-4o-mini' },
      updatedAt: '2026-07-26T00:00:00.000Z',
    });

    const json = JSON.parse(JSON.stringify(serializeModelSettings(settings)));
    expect(deserializeModelSettings(json)).toEqual(settings);
    // 直列化結果に平文の入る余地はない（apiKey は SealedSecret の形のみ）。
    expect(JSON.stringify(json)).toContain('"hint":"cdef"');
  });

  it('スロット無しも往復する', () => {
    const settings = createModelSettings({ scope, updatedAt: '2026-07-26T00:00:00.000Z' });
    expect(deserializeModelSettings(serializeModelSettings(settings))).toEqual(settings);
  });

  it('壊れたデータは ModelSettingsValidationError（原因を含む）', () => {
    expect(() => deserializeModelSettings({ scope, updatedAt: 1 })).toThrow(ModelSettingsValidationError);
    expect(() => deserializeModelSettings({ scope, main: { source: 'registry' }, updatedAt: 'x' })).toThrow(/main.model/);
    expect(() => deserializeModelSettings({ scope, main: { source: 'registry', model: 'p/m', apiKey: { v: 1 } }, updatedAt: 'x' })).toThrow(ModelSettingsValidationError);
  });
});
