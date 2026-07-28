import { describe, expect, it } from 'vitest';
import { InMemoryModelSettingsRepository } from '../../adapters/storage/in-memory-model-settings-repository';
import { ModelSettingsValidationError } from '../../domain/model-settings/errors';
import { createModelSettings } from '../../domain/model-settings/model-settings';
import { ModelProviderError, type ModelCapability, type ModelCompletion, type ModelCompletionRequest, type ModelProviderPort } from '../model/model-provider';
import type { ModelCatalogPort, ModelCatalogProvider } from './model-catalog';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from './model-provider-factory';
import { QueryModelCatalogUseCase } from './query-model-catalog';
import type { SecretCipherPort } from './secret-cipher';
import { MODEL_TEST_MAX_TOKENS, MODEL_TEST_TIMEOUT_MS, TestModelSettingsUseCase } from './test-model-settings';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const envDefault: ResolvedSlotOptions = { model: { id: 'env-model', url: 'http://127.0.0.1:1234/v1' } };

class FakeCipher implements SecretCipherPort {
  async seal(plaintext: string) {
    return { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plaintext).toString('base64'), hint: plaintext.slice(-4) } as const;
  }
  async open(sealed: { data: string }): Promise<string> { return Buffer.from(sealed.data, 'base64').toString('utf8'); }
}

class FakeFactory implements ModelProviderFactoryPort {
  readonly created: ResolvedSlotOptions[] = [];
  readonly requests: ModelCompletionRequest[] = [];
  reply: string | null = 'ok';
  failure: Error | undefined;
  abortSignals: (AbortSignal | undefined)[] = [];
  create(options: ResolvedSlotOptions): ModelProviderPort {
    this.created.push(options);
    const self = this;
    return {
      async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
        self.requests.push(request);
        self.abortSignals.push(signal);
        if (self.failure !== undefined) throw self.failure;
        return { message: { role: 'assistant', content: self.reply }, finishReason: 'stop' };
      },
      capabilities(): readonly ModelCapability[] { return ['chat']; },
    };
  }
}

function make() {
  const repo = new InMemoryModelSettingsRepository();
  const cipher = new FakeCipher();
  const factory = new FakeFactory();
  let clock = 1_000;
  const useCase = new TestModelSettingsUseCase(repo, cipher, factory, () => envDefault, () => (clock += 25));
  return { repo, cipher, factory, useCase };
}

describe('TestModelSettingsUseCase', () => {
  it('候補設定でヘルスチェックを実行し、待ち時間と応答（64字クリップ）を返す', async () => {
    const { useCase, factory } = make();
    factory.reply = 'x'.repeat(200);

    const result = await useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'candidate-model' } });

    expect(result).toEqual({ ok: true, latencyMs: 25, reply: `${'x'.repeat(64)}…`, usedStoredKey: false });
    expect(factory.created[0]).toMatchObject({ model: { id: 'candidate-model', url: 'http://127.0.0.1:1234/v1' }, timeoutMs: MODEL_TEST_TIMEOUT_MS, maxTokens: MODEL_TEST_MAX_TOKENS });
    expect(factory.requests[0]).toMatchObject({
      temperature: 0,
      messages: [{ role: 'system', content: 'Health check' }, { role: 'user', content: 'Reply with exactly: ok' }],
    });
    expect(factory.abortSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('候補にキーが無く宛先も同じなら保存済みキーを使う（UIで再入力させない）', async () => {
    const { useCase, repo, cipher, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-stored-7777') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    const result = await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o-mini' } });

    expect(factory.created[0]?.model).toEqual({ id: 'openai/gpt-4o-mini', apiKey: 'sk-stored-7777' });
    expect(result).toMatchObject({ ok: true, usedStoredKey: true });
  });

  it('候補の宛先が違えば保存済みキーを使わない（usedStoredKey:false）', async () => {
    const { useCase, repo, cipher, factory } = make();
    await repo.save(createModelSettings({
      scope,
      main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: await cipher.seal('sk-stored-7777') },
      updatedAt: '2026-07-26T00:00:00.000Z',
    }));

    // 別エンドポイント宛の候補（保存済みキーを任意の宛先へ送らせない）。
    const away = await useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'https://evil.example.com/v1', model: 'local' } });
    expect(factory.created[0]?.model).toEqual({ id: 'local', url: 'https://evil.example.com/v1' });
    expect(away).toMatchObject({ ok: true, usedStoredKey: false });

    // source が変わった場合（openai-compatible → registry）も流用しない。
    const switched = await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o' } });
    expect(factory.created[1]?.model).toBe('openai/gpt-4o');
    expect(switched).toMatchObject({ usedStoredKey: false });

    // 同じ宛先（末尾スラッシュ違い）なら流用する。
    const same = await useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1/', model: 'local' } });
    expect(factory.created[2]?.model).toMatchObject({ apiKey: 'sk-stored-7777' });
    expect(same).toMatchObject({ usedStoredKey: true });

    // パスの大文字小文字や query が違う候補へも流用しない。
    const caseChanged = await useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/V1', model: 'local' } });
    expect(factory.created[3]?.model).toEqual({ id: 'local', url: 'http://127.0.0.1:1234/V1' });
    expect(caseChanged).toMatchObject({ usedStoredKey: false });

    const queryChanged = await useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1?tenant=other', model: 'local' } });
    expect(factory.created[4]?.model).toEqual({ id: 'local', url: 'http://127.0.0.1:1234/v1?tenant=other' });
    expect(queryChanged).toMatchObject({ usedStoredKey: false });
  });

  it('registry は provider 接頭辞が変われば別の宛先', async () => {
    const { useCase, repo, cipher, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-openai-7777') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'anthropic/claude-sonnet-4-5' } });

    expect(factory.created[0]?.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('候補のキーが空文字ならキー無しで試す', async () => {
    const { useCase, repo, cipher, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-stored-7777') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o', apiKey: '' } });

    expect(factory.created[0]?.model).toBe('openai/gpt-4o');
  });

  it('候補省略なら保存済み設定、それも無ければ env 既定で試す', async () => {
    const { useCase, repo, cipher, factory } = make();

    expect(await useCase.execute({ scope, slot: 'judge' })).toMatchObject({ usedStoredKey: false });
    expect(factory.created[0]?.model).toMatchObject({ id: 'env-model' });

    await repo.save(createModelSettings({ scope, judge: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    expect(await useCase.execute({ scope, slot: 'judge' })).toMatchObject({ usedStoredKey: false });
    expect(factory.created[1]?.model).toBe('openai/gpt-4o');

    // 候補省略なら保存済みの宛先そのものなので、保存済みキーはそのまま使う。
    await repo.save(createModelSettings({ scope, judge: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-judge-5555') }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    expect(await useCase.execute({ scope, slot: 'judge' })).toMatchObject({ usedStoredKey: true });
  });

  it('例外は投げずに ok:false へ正規化し、秘密値を含めない', async () => {
    const { useCase, factory } = make();
    factory.failure = new ModelProviderError('Model request failed: 401 Unauthorized for key sk-leaked-3333');

    const result = await useCase.execute({
      scope, slot: 'main',
      candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: 'sk-leaked-3333' },
    });

    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, error: 'Model request failed: 401 Unauthorized for key ***', usedStoredKey: false });
  });

  it('長すぎるエラーは切り詰める', async () => {
    const { useCase, factory } = make();
    factory.failure = new Error('e'.repeat(500));

    const result = await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toHaveLength(301);
  });

  it('不正な候補設定（http以外のURL・資格情報付きURL）は ok:false に丸めず例外にする（api で 400）', async () => {
    const { useCase } = make();

    await expect(useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'ftp://host/v1', model: 'm' } })).rejects.toThrow(ModelSettingsValidationError);
    await expect(useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'https://user:pass@host/v1', model: 'm' } })).rejects.toThrow(ModelSettingsValidationError);
  });

  it('env 既定も設定も無いスロットは ok:false（未設定）を返す', async () => {
    const repo = new InMemoryModelSettingsRepository();
    const useCase = new TestModelSettingsUseCase(repo, new FakeCipher(), new FakeFactory());

    expect(await useCase.execute({ scope, slot: 'main' })).toEqual({ ok: false, error: "Model settings are not configured for slot 'main'", usedStoredKey: false });
  });

  it('応答が空でも ok:true（空文字の reply）', async () => {
    const { useCase, factory } = make();
    factory.reply = null;

    expect(await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o' } })).toEqual({ ok: true, latencyMs: 25, reply: '', usedStoredKey: false });
  });

  it('呼び出し側の中断シグナルを伝播する', async () => {
    const { useCase, factory } = make();
    const controller = new AbortController();
    controller.abort();

    await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o' } }, controller.signal);

    expect(factory.abortSignals[0]?.aborted).toBe(true);
  });
});

describe('QueryModelCatalogUseCase', () => {
  class FakeCatalog implements ModelCatalogPort {
    lastKey: string | undefined;
    lastBaseUrl = '';
    providers(): readonly ModelCatalogProvider[] { return [{ id: 'openai', name: 'OpenAI', source: 'registry', envVar: 'OPENAI_API_KEY' }]; }
    async listOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<readonly string[]> {
      this.lastBaseUrl = baseUrl; this.lastKey = apiKey;
      return ['local-a', 'local-b'];
    }
  }

  function makeCatalog() {
    const repo = new InMemoryModelSettingsRepository();
    const cipher = new FakeCipher();
    const catalog = new FakeCatalog();
    return { repo, cipher, catalog, useCase: new QueryModelCatalogUseCase(catalog, repo, cipher) };
  }

  const storedAt = async (repo: InMemoryModelSettingsRepository, cipher: FakeCipher, baseUrl: string): Promise<void> => {
    await repo.save(createModelSettings({
      scope,
      main: { source: 'openai-compatible', baseUrl, model: 'm', apiKey: await cipher.seal('sk-catalog-8888') },
      updatedAt: '2026-07-26T00:00:00.000Z',
    }));
  };

  it('接続先の見出しはそのまま返す（モデル名は含まない）', () => {
    const { useCase } = makeCatalog();
    expect(useCase.providers()).toEqual([{ id: 'openai', name: 'OpenAI', source: 'registry', envVar: 'OPENAI_API_KEY' }]);
  });

  it('slot 指定かつ宛先一致のときだけ保存済みキーを開封して使う', async () => {
    const { useCase, repo, cipher, catalog } = makeCatalog();
    await storedAt(repo, cipher, 'http://127.0.0.1:1234/v1');

    expect(await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1' })).toEqual({ models: ['local-a', 'local-b'], usedStoredKey: false });
    expect(catalog.lastKey).toBeUndefined();

    expect(await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'main' })).toMatchObject({ usedStoredKey: true });
    expect(catalog.lastKey).toBe('sk-catalog-8888');

    // キー未設定のスロットは undefined のまま。
    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'judge' });
    expect(catalog.lastKey).toBeUndefined();
  });

  it('宛先が違えばキーを使わずに問い合わせる（保存済みキーを任意URLへ送らせない）', async () => {
    const { useCase, repo, cipher, catalog } = makeCatalog();
    await storedAt(repo, cipher, 'http://127.0.0.1:1234/v1');

    const result = await useCase.openAiCompatibleModels({ scope, baseUrl: 'https://evil.example.com/v1', slot: 'main' });

    expect(catalog.lastKey).toBeUndefined();
    expect(catalog.lastBaseUrl).toBe('https://evil.example.com/v1');
    // エラーにはしない（キー不要なローカルサーバーが主用途）。
    expect(result).toEqual({ models: ['local-a', 'local-b'], usedStoredKey: false });
  });

  it('宛先の一致は scheme / host / 末尾スラッシュを正規化し、path / query は厳密に見る', async () => {
    const { useCase, repo, cipher, catalog } = makeCatalog();
    await storedAt(repo, cipher, 'http://127.0.0.1:1234/v1');

    await useCase.openAiCompatibleModels({ scope, baseUrl: 'HTTP://127.0.0.1:1234/v1/', slot: 'main' });
    expect(catalog.lastKey).toBe('sk-catalog-8888');

    // ホストが同じでもパスが違えば別の宛先。
    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/other', slot: 'main' });
    expect(catalog.lastKey).toBeUndefined();

    // pathname の大文字小文字と query の差も別宛先。秘密値を流用しない。
    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/V1', slot: 'main' });
    expect(catalog.lastKey).toBeUndefined();
    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1?tenant=other', slot: 'main' });
    expect(catalog.lastKey).toBeUndefined();
  });

  it('保存済みスロットが registry ならキーは使わない（宛先が別種）', async () => {
    const { useCase, repo, cipher, catalog } = makeCatalog();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-openai-9999') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'main' });

    expect(catalog.lastKey).toBeUndefined();
  });
});
