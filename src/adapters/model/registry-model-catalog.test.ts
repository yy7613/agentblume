import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogError } from '../../application/model-settings/model-catalog';
import { MODEL_CATALOG_MODEL_LIMIT, RegistryModelCatalog } from './registry-model-catalog';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => handler(String(url), init)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('RegistryModelCatalog#providers', () => {
  it('バンドル済み登録簿からプロバイダを組み立てる（ネットワーク不要）', () => {
    stubFetch(() => { throw new Error('network must not be used'); });
    const providers = new RegistryModelCatalog().providers();

    expect(providers.length).toBeGreaterThan(10);
    const openai = providers.find((provider) => provider.id === 'openai');
    expect(openai).toMatchObject({ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY' });
    expect(openai?.models).toContain('gpt-4o');
    // モデルIDは provider を除いた形（設定値は `${id}/${model}`）。
    expect(openai?.models.every((model) => !model.startsWith('openai/'))).toBe(true);
  });

  it('1プロバイダあたりの提示数を上限で切る', () => {
    for (const provider of new RegistryModelCatalog().providers()) {
      expect(provider.models.length).toBeLessThanOrEqual(MODEL_CATALOG_MODEL_LIMIT);
    }
  });

  it('二度目以降は同じ配列を返す（静的データのキャッシュ）', () => {
    const catalog = new RegistryModelCatalog();
    expect(catalog.providers()).toBe(catalog.providers());
  });
});

describe('RegistryModelCatalog#listOpenAiCompatibleModels', () => {
  it('/models を叩き、重複を除いて昇順に返す', async () => {
    let seenUrl = ''; let seenHeaders: Record<string, string> = {};
    stubFetch((url, init) => {
      seenUrl = url; seenHeaders = (init.headers ?? {}) as Record<string, string>;
      return jsonResponse({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }, { id: '' }, { nope: true }] });
    });

    const models = await new RegistryModelCatalog().listOpenAiCompatibleModels('http://127.0.0.1:1234/v1/', 'sk-local-key');

    expect(models).toEqual(['alpha', 'zeta']);
    expect(seenUrl).toBe('http://127.0.0.1:1234/v1/models');
    expect(seenHeaders['Authorization']).toBe('Bearer sk-local-key');
  });

  it('APIキーが無ければ Authorization を付けない（URLにも載せない）', async () => {
    let seenUrl = ''; let seenHeaders: Record<string, string> = {};
    stubFetch((url, init) => { seenUrl = url; seenHeaders = (init.headers ?? {}) as Record<string, string>; return jsonResponse({ data: [] }); });

    await new RegistryModelCatalog().listOpenAiCompatibleModels('http://127.0.0.1:1234/v1');

    expect(seenHeaders['Authorization']).toBeUndefined();
    expect(seenUrl).not.toContain('sk-');
  });

  it('HTTPエラーは空配列でなく ModelCatalogError（キーは含まない）', async () => {
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));

    const catalog = new RegistryModelCatalog();
    await expect(catalog.listOpenAiCompatibleModels('http://127.0.0.1:1234/v1', 'sk-secret-key')).rejects.toThrow(ModelCatalogError);
    await expect(catalog.listOpenAiCompatibleModels('http://127.0.0.1:1234/v1', 'sk-secret-key')).rejects.toThrow(/status 401/);
  });

  it('接続失敗も ModelCatalogError にする', async () => {
    stubFetch(() => { throw new Error('ECONNREFUSED'); });

    await expect(new RegistryModelCatalog().listOpenAiCompatibleModels('http://127.0.0.1:9/v1')).rejects.toThrow(/Could not list models from http:\/\/127.0.0.1:9\/v1\/models/);
  });

  it('data 配列が無い応答は ModelCatalogError', async () => {
    stubFetch(() => jsonResponse({ models: ['a'] }));

    await expect(new RegistryModelCatalog().listOpenAiCompatibleModels('http://127.0.0.1:1234/v1')).rejects.toThrow(/data array/);
  });

  it('呼び出し側の中断シグナルで打ち切る', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch((_url, init) => {
      if ((init.signal as AbortSignal | undefined)?.aborted === true) throw new Error('aborted');
      return jsonResponse({ data: [] });
    });

    await expect(new RegistryModelCatalog().listOpenAiCompatibleModels('http://127.0.0.1:1234/v1', undefined, controller.signal)).rejects.toThrow(ModelCatalogError);
  });
});
