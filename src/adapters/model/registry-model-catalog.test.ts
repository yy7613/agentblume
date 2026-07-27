import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogError } from '../../application/model-settings/model-catalog';
import { RegistryModelCatalog, isChatModelId } from './registry-model-catalog';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => handler(String(url), init)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isChatModelId', () => {
  it('チャット以外の慣用パターンを除外する', () => {
    for (const id of ['text-embedding-3-small', 'nomic-embed-text', 'whisper-large-v3', 'gpt-image-1', 'dall-e-3', 'veo-3-video', 'tts-1-hd', 'gpt-4o-audio-preview', 'rerank-v3.5', 'omni-moderation-latest', '   ']) {
      expect(isChatModelId(id)).toBe(false);
    }
  });

  it('チャットモデルは通す（大文字小文字を問わない）', () => {
    for (const id of ['gpt-4o', 'GPT-4O-MINI', 'openai/gpt-4o', 'qwen/qwen3-4b', 'claude-sonnet-4-5', 'gemini-2.5-pro']) {
      expect(isChatModelId(id)).toBe(true);
    }
  });
});

describe('RegistryModelCatalog#providers', () => {
  it('バンドル済み登録簿からプロバイダの見出しを組み立てる（ネットワーク不要・モデル一覧は含めない）', () => {
    stubFetch(() => { throw new Error('network must not be used'); });
    const providers = new RegistryModelCatalog().providers();

    expect(providers.length).toBeGreaterThan(10);
    const openai = providers.find((provider) => provider.id === 'openai');
    expect(openai).toMatchObject({ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY' });
    expect(openai?.modelCount).toBeGreaterThan(0);
    // 応答を軽くするため一覧は入れない（`GET /model-catalog/:providerId/models` で取る）。
    expect(openai).not.toHaveProperty('models');
  });

  it('モデル一覧は件数で切らない（辞書順クリップで主要モデルを落とさない）', () => {
    const catalog = new RegistryModelCatalog();
    const openai = catalog.providerModels('openai') ?? [];

    expect(openai).toContain('gpt-4o');
    // モデルIDは provider を除いた形（設定値は `${id}/${model}`）。
    expect(openai.every((model) => !model.startsWith('openai/'))).toBe(true);
    // 昇順で、件数は modelCount と一致する。
    expect([...openai].sort((left, right) => left.localeCompare(right))).toEqual([...openai]);
    expect(catalog.providers().find((provider) => provider.id === 'openai')?.modelCount).toBe(openai.length);

    // かつて50件の辞書順クリップで全滅していた openrouter の主要ベンダーが残る。
    const openrouter = catalog.providerModels('openrouter');
    if (openrouter !== undefined && openrouter.length > 50) {
      for (const vendor of ['openai/', 'google/', 'qwen/']) {
        expect(openrouter.some((model) => model.startsWith(vendor))).toBe(true);
      }
    }
  });

  it('非チャットモデルは一覧にも件数にも含めない', () => {
    const catalog = new RegistryModelCatalog();
    for (const provider of catalog.providers()) {
      expect((catalog.providerModels(provider.id) ?? []).every(isChatModelId)).toBe(true);
    }
    expect(catalog.providerModels('openai')).not.toContain('text-embedding-3-small');
  });

  it('未知のプロバイダは undefined', () => {
    expect(new RegistryModelCatalog().providerModels('no-such-provider')).toBeUndefined();
  });

  it('二度目以降は同じ配列を返す（静的データのキャッシュ）', () => {
    const catalog = new RegistryModelCatalog();
    expect(catalog.providers()).toBe(catalog.providers());
    expect(catalog.providerModels('openai')).toBe(catalog.providerModels('openai'));
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
