import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelCatalogError, type ModelCatalogPort, type ModelCatalogProvider } from '../application/model-settings/model-catalog';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from '../application/model-settings/model-provider-factory';
import { ModelProviderError, type ModelCapability, type ModelCompletion, type ModelProviderPort } from '../application/model/model-provider';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const SECRET = 'sk-route-secret-4242';

class FakeFactory implements ModelProviderFactoryPort {
  readonly created: ResolvedSlotOptions[] = [];
  failure: Error | undefined;
  create(options: ResolvedSlotOptions): ModelProviderPort {
    this.created.push(options);
    const self = this;
    return {
      async complete(): Promise<ModelCompletion> {
        if (self.failure !== undefined) throw self.failure;
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
      capabilities(): readonly ModelCapability[] { return ['chat']; },
    };
  }
}

class FakeCatalog implements ModelCatalogPort {
  lastKey: string | undefined;
  lastBaseUrl = '';
  calls = 0;
  failure: Error | undefined;
  providers(): readonly ModelCatalogProvider[] {
    return [{ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', modelCount: 2 }];
  }
  providerModels(providerId: string): readonly string[] | undefined {
    return providerId === 'openai' ? ['gpt-4o', 'o4-mini'] : undefined;
  }
  async listOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<readonly string[]> {
    this.calls += 1;
    this.lastBaseUrl = baseUrl; this.lastKey = apiKey;
    if (this.failure !== undefined) throw this.failure;
    return ['local-a', 'local-b'];
  }
}

describe('model settings routes', () => {
  let app: App; let server: FastifyInstance; let factory: FakeFactory; let catalog: FakeCatalog;

  beforeEach(() => {
    factory = new FakeFactory();
    catalog = new FakeCatalog();
    app = createApp({ profile: 'test', modelProviderFactory: factory, modelCatalog: catalog });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
  });
  afterEach(async () => { await server.close(); app.close(); });

  const registrySlot = { source: 'registry', model: 'openai/gpt-4o' } as const;

  it('未保存ならスコープと保存先の種別だけを返す（env 既定を使う状態）', async () => {
    const response = await server.inject({ method: 'GET', url: '/model-settings', query: scope });
    expect(response.statusCode).toBe(200);
    // testプロファイルはInMemory＝再起動で消えるので ephemeral。
    expect(response.json()).toEqual({ settings: { scope, storage: 'ephemeral' } });
  });

  it('保存・参照ともに応答へ平文キーも封緘済みデータも現れない', async () => {
    const saved = await server.inject({
      method: 'PUT', url: '/model-settings',
      payload: { scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: SECRET }, judge: registrySlot },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({
      scope,
      main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: { configured: true, hint: '4242' } },
      judge: { source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } },
    });

    const fetched = await server.inject({ method: 'GET', url: '/model-settings', query: scope });
    for (const body of [saved.body, fetched.body]) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('sk-route');
      expect(body).not.toContain('aes-256-gcm');
      expect(body).not.toContain('"iv"');
      expect(body).not.toContain('"data"');
    }
    // 保存自体は行われている（偽陰性の排除）。
    expect(fetched.json().settings.main.apiKey).toEqual({ configured: true, hint: '4242' });
  });

  it('apiKey 省略は維持、空文字はクリア、スロット null は env 既定へ戻す', async () => {
    await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { ...registrySlot, apiKey: SECRET } } });

    const kept = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'registry', model: 'openai/o4-mini' } } });
    expect(kept.json().settings.main).toEqual({ source: 'registry', model: 'openai/o4-mini', apiKey: { configured: true, hint: '4242' } });

    const cleared = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'registry', model: 'openai/o4-mini', apiKey: '' } } });
    expect(cleared.json().settings.main.apiKey).toEqual({ configured: false });

    const removed = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: null } });
    expect(removed.json().settings.main).toBeUndefined();
  });

  it('ドメイン検証違反は400（MODEL_SETTINGS_VALIDATION）', async () => {
    const response = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'registry', model: 'gpt-4o' } } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('MODEL_SETTINGS_VALIDATION');
  });

  it('スキーマ違反は400（BAD_REQUEST）', async () => {
    const response = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'unknown', model: 'x' } } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');

    // scope 自体はもう読まれないが、空文字のような明らかな打ち間違いは従来どおり400で返す。
    const blankScope = await server.inject({ method: 'GET', url: '/model-settings', query: { tenantId: '' } });
    expect(blankScope.statusCode).toBe(400);
  });

  it('疎通テストは成功も失敗も200（ok フラグで区別する）', async () => {
    const ok = await server.inject({ method: 'POST', url: '/model-settings/test', payload: { scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: SECRET } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, reply: 'ok', usedStoredKey: false });
    expect(factory.created.at(-1)?.model).toMatchObject({ id: 'local-model', url: 'http://127.0.0.1:1234/v1', apiKey: SECRET });

    factory.failure = new ModelProviderError(`Model request failed: bad key ${SECRET}`);
    const failed = await server.inject({ method: 'POST', url: '/model-settings/test', payload: { scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: SECRET } } });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ ok: false, error: 'Model request failed: bad key ***', usedStoredKey: false });
    expect(failed.body).not.toContain(SECRET);
  });

  it('疎通テストの入力不正は ok:false ではなく400', async () => {
    for (const candidate of [
      { source: 'openai-compatible', model: 'local-model' },                                  // baseUrl 必須
      { source: 'openai-compatible', baseUrl: 'ftp://host/v1', model: 'local-model' },        // http(s) 限定
      { source: 'openai-compatible', baseUrl: 'https://user:pass@host/v1', model: 'm' },      // 資格情報埋め込み禁止
    ]) {
      const response = await server.inject({ method: 'POST', url: '/model-settings/test', payload: { scope, slot: 'main', candidate } });
      expect(response.statusCode).toBe(400);
    }
    expect(factory.created).toHaveLength(0);
  });

  it('候補の宛先が保存済みと違えば保存済みキーを使わない（usedStoredKey:false）', async () => {
    await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: SECRET } } });

    const away = await server.inject({ method: 'POST', url: '/model-settings/test', payload: { scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'https://evil.example.com/v1', model: 'local-model' } } });

    expect(away.json()).toMatchObject({ ok: true, usedStoredKey: false });
    expect(factory.created.at(-1)?.model).toEqual({ id: 'local-model', url: 'https://evil.example.com/v1' });
    expect(away.body).not.toContain(SECRET);
  });

  it('宛先が変わる保存ではキーを継承しない', async () => {
    await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: SECRET } } });

    const moved = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' } } });

    expect(moved.json().settings.main.apiKey).toEqual({ configured: false });
  });

  it('スロット未指定の PUT は no-op（updatedAt を進めず、未保存なら空行も作らない）', async () => {
    const empty = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope } });
    expect(empty.json()).toEqual({ settings: { scope } });

    await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: registrySlot } });
    const saved = (await server.inject({ method: 'GET', url: '/model-settings', query: scope })).json().settings;
    const noop = await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope } });
    expect(noop.json().settings.updatedAt).toBe(saved.updatedAt);
  });

  it('登録簿カタログは見出しだけを返し、モデル一覧は別ルートで取る', async () => {
    const response = await server.inject({ method: 'GET', url: '/model-catalog' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providers: [{ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', modelCount: 2 }] });

    const models = await server.inject({ method: 'GET', url: '/model-catalog/openai/models' });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ models: ['gpt-4o', 'o4-mini'] });
  });

  it('未知のプロバイダのモデル一覧は400', async () => {
    const response = await server.inject({ method: 'GET', url: '/model-catalog/no-such/models' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('OpenAI互換のモデル一覧はPOSTのみ（GETは廃止・単純リクエストで発火させない）', async () => {
    const legacy = await server.inject({ method: 'GET', url: '/model-catalog/openai-compatible-models', query: { ...scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'main' } });
    expect(legacy.statusCode).toBe(404);
    expect(catalog.calls).toBe(0);
  });

  it('保存済みキーは宛先が一致するときだけ使う（任意URLへ送らせない）', async () => {
    await server.inject({ method: 'PUT', url: '/model-settings', payload: { scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: SECRET } } });

    const withoutSlot = await server.inject({ method: 'POST', url: '/model-catalog/openai-compatible-models', payload: { scope, baseUrl: 'http://127.0.0.1:1234/v1' } });
    expect(withoutSlot.json()).toEqual({ models: ['local-a', 'local-b'], usedStoredKey: false });
    expect(catalog.lastKey).toBeUndefined();

    const withSlot = await server.inject({ method: 'POST', url: '/model-catalog/openai-compatible-models', payload: { scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'main' } });
    expect(withSlot.statusCode).toBe(200);
    expect(withSlot.json()).toMatchObject({ usedStoredKey: true });
    expect(catalog.lastKey).toBe(SECRET);
    expect(catalog.lastBaseUrl).toBe('http://127.0.0.1:1234/v1');

    // 別宛先を指定してもキーは付かない（CSRFで漏らさない）。
    const elsewhere = await server.inject({ method: 'POST', url: '/model-catalog/openai-compatible-models', payload: { scope, baseUrl: 'https://evil.example.com/v1', slot: 'main' } });
    expect(elsewhere.statusCode).toBe(200);
    expect(elsewhere.json()).toMatchObject({ usedStoredKey: false });
    expect(catalog.lastKey).toBeUndefined();
    expect(elsewhere.body).not.toContain(SECRET);
  });

  it('baseUrl は保存経路と同じ検証を通す（http(s) 限定・資格情報埋め込み禁止）', async () => {
    for (const baseUrl of ['ftp://host/v1', 'not a url', 'https://user:pass@host/v1']) {
      const response = await server.inject({ method: 'POST', url: '/model-catalog/openai-compatible-models', payload: { scope, baseUrl } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    }
    expect(catalog.calls).toBe(0);
  });

  it('モデル一覧の取得失敗は502（MODEL_CATALOG）', async () => {
    catalog.failure = new ModelCatalogError('Could not list models from http://127.0.0.1:1234/v1/models');

    const response = await server.inject({ method: 'POST', url: '/model-catalog/openai-compatible-models', payload: { scope, baseUrl: 'http://127.0.0.1:1234/v1' } });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('MODEL_CATALOG');
  });
});
