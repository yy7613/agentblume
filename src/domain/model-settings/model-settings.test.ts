import { describe, expect, it } from 'vitest';
import { ModelSettingsValidationError } from './errors';
import { createModelSettings, createModelSlotSettings, isHttpBaseUrl, modelSlot, normalizeBaseUrl, sameBaseUrl, sameModelDestination } from './model-settings';
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
    expect(secretHint('abcde')).toBe('bcde');
  });

  it('4文字以下の平文は hint を作らない（平文が丸ごとマスク表示に載るため）', () => {
    for (const plaintext of ['', 'a', 'ab', 'abc', 'abcd']) expect(secretHint(plaintext)).toBe('');
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

  it('baseUrl に資格情報（userinfo）を埋め込めない（平文でDB・応答・ログに残るため）', () => {
    for (const baseUrl of ['https://user:pass@host/v1', 'https://user@host/v1', 'http://:pass@host/v1']) {
      expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl, model: 'm' })).toThrow(/credentials/);
    }
    // エラー文言に資格情報を載せない。
    try { createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'https://user:hunter2@host/v1', model: 'm' }); }
    catch (error) { expect((error as Error).message).not.toContain('hunter2'); }
  });

  it('未知の source / 非オブジェクトを拒否する', () => {
    expect(() => createModelSlotSettings({ source: 'anthropic-direct', model: 'x' })).toThrow(/source/);
    expect(() => createModelSlotSettings('main')).toThrow(/must be an object/);
    expect(() => createModelSlotSettings(null)).toThrow(/must be an object/);
  });
});

describe('isHttpBaseUrl', () => {
  it('http(s) かつ資格情報を含まないURLだけを受け入れる', () => {
    for (const value of ['http://127.0.0.1:1234/v1', 'https://api.example.com/v1', ' https://api.example.com/v1 ']) {
      expect(isHttpBaseUrl(value)).toBe(true);
    }
    for (const value of ['ftp://host/v1', 'file:///c:/x', 'javascript:alert(1)', 'not a url', '', '   ', 'https://user:pass@host/v1', 'https://user@host/v1', 42, undefined]) {
      expect(isHttpBaseUrl(value)).toBe(false);
    }
    expect(isHttpBaseUrl(`http://h/${'x'.repeat(600)}`)).toBe(false);
  });

  it('リンクローカル（クラウドメタデータ）宛は拒否する', () => {
    for (const value of ['http://169.254.169.254/latest/meta-data/', 'http://169.254.1.2:8080/v1', 'http://[fe80::1]/v1']) {
      expect(isHttpBaseUrl(value)).toBe(false);
    }
  });

  it('LANのLM Studioは許可したままにする（既定で塞ぐと既存環境が壊れる）', () => {
    for (const value of ['http://192.168.1.20:1234/v1', 'http://10.0.0.5:1234/v1']) {
      expect(isHttpBaseUrl(value)).toBe(true);
    }
  });
});

describe('createModelSlotSettings の baseUrl 検証', () => {
  it('リンクローカル宛は保存できない', () => {
    expect(() => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'http://169.254.169.254/v1', model: 'x' }))
      .toThrow(/link-local/);
  });
});

describe('normalizeBaseUrl / sameBaseUrl / sameModelDestination', () => {
  it('origin + pathname だけを小文字で見る（末尾スラッシュ・既定ポート・query は無視）', () => {
    expect(normalizeBaseUrl('HTTP://127.0.0.1:1234/V1/')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(sameBaseUrl('https://API.example.com/v1/', 'https://api.example.com:443/v1')).toBe(true);
    expect(sameBaseUrl('http://127.0.0.1:1234/v1?x=1#f', 'http://127.0.0.1:1234/v1')).toBe(true);
  });

  it('ホスト・ポート・パス・スキームが違えば別の宛先', () => {
    expect(sameBaseUrl('http://127.0.0.1:1234/v1', 'http://127.0.0.1:5678/v1')).toBe(false);
    expect(sameBaseUrl('http://127.0.0.1:1234/v1', 'https://127.0.0.1:1234/v1')).toBe(false);
    expect(sameBaseUrl('http://127.0.0.1:1234/v1', 'http://evil.example.com/v1')).toBe(false);
    expect(sameBaseUrl('http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/other')).toBe(false);
  });

  it('URLとして読めない値も落ちずに文字列比較へ倒れる', () => {
    expect(normalizeBaseUrl('  Not A Url/  ')).toBe('not a url');
    expect(sameBaseUrl('not a url', 'NOT A URL')).toBe(true);
  });

  it('宛先の同一性は source / provider接頭辞 / baseUrl で決まる', () => {
    const stored = { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local' } as const;
    expect(sameModelDestination(stored, { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1/', model: 'other' })).toBe(true);
    expect(sameModelDestination(stored, { source: 'openai-compatible', baseUrl: 'https://evil.example.com/v1', model: 'local' })).toBe(false);
    expect(sameModelDestination(stored, { source: 'registry', model: 'openai/gpt-4o' })).toBe(false);

    const registry = { source: 'registry', model: 'openai/gpt-4o' } as const;
    expect(sameModelDestination(registry, { source: 'registry', model: 'openai/o4-mini' })).toBe(true);
    expect(sameModelDestination(registry, { source: 'registry', model: 'OpenAI/gpt-4o' })).toBe(true);
    expect(sameModelDestination(registry, { source: 'registry', model: 'anthropic/claude-sonnet-4-5' })).toBe(false);
    expect(sameModelDestination(registry, { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'x' })).toBe(false);
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
