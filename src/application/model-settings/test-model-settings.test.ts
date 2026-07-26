import { describe, expect, it } from 'vitest';
import { InMemoryModelSettingsRepository } from '../../adapters/storage/in-memory-model-settings-repository';
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

    expect(result).toEqual({ ok: true, latencyMs: 25, reply: `${'x'.repeat(64)}…` });
    expect(factory.created[0]).toMatchObject({ model: { id: 'candidate-model', url: 'http://127.0.0.1:1234/v1' }, timeoutMs: MODEL_TEST_TIMEOUT_MS, maxTokens: MODEL_TEST_MAX_TOKENS });
    expect(factory.requests[0]).toMatchObject({
      temperature: 0,
      messages: [{ role: 'system', content: 'Health check' }, { role: 'user', content: 'Reply with exactly: ok' }],
    });
    expect(factory.abortSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('候補にキーが無ければ保存済みキーを使う（UIで再入力させない）', async () => {
    const { useCase, repo, cipher, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-stored-7777') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o-mini' } });

    expect(factory.created[0]?.model).toEqual({ id: 'openai/gpt-4o-mini', apiKey: 'sk-stored-7777' });
  });

  it('候補のキーが空文字ならキー無しで試す', async () => {
    const { useCase, repo, cipher, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-stored-7777') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o', apiKey: '' } });

    expect(factory.created[0]?.model).toBe('openai/gpt-4o');
  });

  it('候補省略なら保存済み設定、それも無ければ env 既定で試す', async () => {
    const { useCase, repo, factory } = make();

    await useCase.execute({ scope, slot: 'judge' });
    expect(factory.created[0]?.model).toMatchObject({ id: 'env-model' });

    await repo.save(createModelSettings({ scope, judge: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    await useCase.execute({ scope, slot: 'judge' });
    expect(factory.created[1]?.model).toBe('openai/gpt-4o');
  });

  it('例外は投げずに ok:false へ正規化し、秘密値を含めない', async () => {
    const { useCase, factory } = make();
    factory.failure = new ModelProviderError('Model request failed: 401 Unauthorized for key sk-leaked-3333');

    const result = await useCase.execute({
      scope, slot: 'main',
      candidate: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: 'sk-leaked-3333' },
    });

    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, error: 'Model request failed: 401 Unauthorized for key ***' });
  });

  it('長すぎるエラーは切り詰める', async () => {
    const { useCase, factory } = make();
    factory.failure = new Error('e'.repeat(500));

    const result = await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toHaveLength(301);
  });

  it('不正な候補設定（http以外のURL）も例外にせず ok:false で返す', async () => {
    const { useCase } = make();

    const result = await useCase.execute({ scope, slot: 'main', candidate: { source: 'openai-compatible', baseUrl: 'ftp://host/v1', model: 'm' } });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('http(s)') });
  });

  it('env 既定も設定も無いスロットは ok:false（未設定）を返す', async () => {
    const repo = new InMemoryModelSettingsRepository();
    const useCase = new TestModelSettingsUseCase(repo, new FakeCipher(), new FakeFactory());

    expect(await useCase.execute({ scope, slot: 'main' })).toEqual({ ok: false, error: "Model settings are not configured for slot 'main'" });
  });

  it('応答が空でも ok:true（空文字の reply）', async () => {
    const { useCase, factory } = make();
    factory.reply = null;

    expect(await useCase.execute({ scope, slot: 'main', candidate: { source: 'registry', model: 'openai/gpt-4o' } })).toEqual({ ok: true, latencyMs: 25, reply: '' });
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
    providers(): readonly ModelCatalogProvider[] { return [{ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', models: ['gpt-4o'] }]; }
    async listOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<readonly string[]> {
      this.lastBaseUrl = baseUrl; this.lastKey = apiKey;
      return ['local-a', 'local-b'];
    }
  }

  it('登録簿はそのまま返す', () => {
    const catalog = new FakeCatalog();
    const useCase = new QueryModelCatalogUseCase(catalog, new InMemoryModelSettingsRepository(), new FakeCipher());
    expect(useCase.providers()).toEqual([{ id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', models: ['gpt-4o'] }]);
  });

  it('slot 指定時だけ保存済みキーを開封して使う', async () => {
    const repo = new InMemoryModelSettingsRepository();
    const cipher = new FakeCipher();
    const catalog = new FakeCatalog();
    const useCase = new QueryModelCatalogUseCase(catalog, repo, cipher);
    await repo.save(createModelSettings({ scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: await cipher.seal('sk-catalog-8888') }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    expect(await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1' })).toEqual(['local-a', 'local-b']);
    expect(catalog.lastKey).toBeUndefined();

    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'main' });
    expect(catalog.lastKey).toBe('sk-catalog-8888');

    // キー未設定のスロットは undefined のまま。
    await useCase.openAiCompatibleModels({ scope, baseUrl: 'http://127.0.0.1:1234/v1', slot: 'judge' });
    expect(catalog.lastKey).toBeUndefined();
  });
});
