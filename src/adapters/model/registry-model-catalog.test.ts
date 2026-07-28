import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogError } from '../../application/model-settings/model-catalog';
import { RegistryModelCatalog } from './registry-model-catalog';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => handler(String(url), init)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('RegistryModelCatalog#providers', () => {
  it('主要プロバイダの見出しだけを、宣言順で返す（ネットワーク不要）', () => {
    stubFetch(() => { throw new Error('network must not be used'); });
    const providers = new RegistryModelCatalog().providers();

    // 登録簿の138プロバイダを並べない（選択肢は主要どころに絞る）。
    expect(providers.map((provider) => provider.id)).toEqual([
      'openai', 'anthropic', 'google', 'azure-ai-foundry', 'aws-bedrock', 'google-vertex', 'openai-compatible',
    ]);
    // registry の表示名・環境変数名・docUrl は登録簿由来（手書きの固定値を増やさない）。
    expect(providers[0]).toMatchObject({ id: 'openai', name: 'OpenAI', source: 'registry', envVar: 'OPENAI_API_KEY' });
    expect(providers[0]?.docUrl).toMatch(/^https:\/\//);
  });

  it('モデル名は一切配らない（陳腐化する固定値を持たない）', () => {
    const serialized = JSON.stringify(new RegistryModelCatalog().providers());
    for (const provider of new RegistryModelCatalog().providers()) {
      expect(provider).not.toHaveProperty('models');
      expect(provider).not.toHaveProperty('modelCount');
    }
    // 具体的なモデル名が紛れ込んでいないことを、代表的な名前で押さえる（docUrl は一次情報への導線なので別）。
    for (const model of ['gpt-4', 'gpt-5', 'claude-sonnet', 'claude-opus', 'gemini-2']) expect(serialized).not.toContain(model);
  });

  it('主要クラウドは登録簿に無いのでOpenAI互換の接続先プリセットとして持つ', () => {
    const providers = new RegistryModelCatalog().providers();
    const azure = providers.find((provider) => provider.id === 'azure-ai-foundry');

    expect(azure).toMatchObject({ source: 'openai-compatible', name: 'Microsoft Azure AI Foundry' });
    // 雛形の穴は利用者が埋める（そのままでは保存できない形にしてある）。
    expect(azure?.baseUrlTemplate).toContain('<resource>');
    expect(azure?.baseUrlHosts).toContain('.services.ai.azure.com');
    // 受け皿だけは雛形がそのまま使える（ローカルの既定）。
    expect(providers.find((provider) => provider.id === 'openai-compatible')).toMatchObject({
      source: 'openai-compatible', baseUrlTemplate: 'http://127.0.0.1:1234/v1',
    });
    expect(providers.every((provider) => provider.source === 'registry' || provider.baseUrlTemplate !== undefined)).toBe(true);
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
