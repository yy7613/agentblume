import { describe, expect, it } from 'vitest';
import { InMemoryModelSettingsRepository } from '../../adapters/storage/in-memory-model-settings-repository';
import { createModelSettings } from '../../domain/model-settings/model-settings';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { ModelProviderError } from '../model/model-provider';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from './model-provider-factory';
import { SecretCipherError, type SecretCipherPort } from './secret-cipher';
import { SwitchableModelProvider } from './switchable-model-provider';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const envDefault: ResolvedSlotOptions = { model: { id: 'env-model', url: 'http://127.0.0.1:1234/v1' } };

/** 平文を base64 にするだけの可逆スタブ（暗号強度はここでの関心ではない）。 */
class FakeCipher implements SecretCipherPort {
  failOpen = false;
  async seal(plaintext: string) {
    return { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plaintext).toString('base64'), hint: plaintext.slice(-4) } as const;
  }
  async open(sealed: { data: string }): Promise<string> {
    if (this.failOpen) throw new SecretCipherError('key file changed');
    return Buffer.from(sealed.data, 'base64').toString('utf8');
  }
}

class StubProvider implements ModelProviderPort {
  calls = 0;
  constructor(readonly options: ResolvedSlotOptions, private readonly caps: readonly ModelCapability[] = ['chat']) {}
  async complete(_request: ModelCompletionRequest): Promise<ModelCompletion> {
    this.calls += 1;
    return { message: { role: 'assistant', content: JSON.stringify(this.options.model) }, finishReason: 'stop' };
  }
  capabilities(): readonly ModelCapability[] { return this.caps; }
}

class FakeFactory implements ModelProviderFactoryPort {
  readonly created: StubProvider[] = [];
  capabilities: readonly ModelCapability[] = ['chat'];
  create(options: ResolvedSlotOptions): ModelProviderPort {
    const provider = new StubProvider(options, this.capabilities);
    this.created.push(provider);
    return provider;
  }
}

function make(repo = new InMemoryModelSettingsRepository(), cipher = new FakeCipher(), factory = new FakeFactory(), slot: 'main' | 'judge' = 'main') {
  return { repo, cipher, factory, provider: new SwitchableModelProvider(repo, cipher, factory, slot, envDefault, scope) };
}

const request: ModelCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('SwitchableModelProvider', () => {
  it('設定が無ければ env 既定で動く（従来配線と等価）', async () => {
    const { provider, factory } = make();

    const completion = await provider.complete(request);

    expect(JSON.parse(completion.message.content ?? '')).toEqual({ id: 'env-model', url: 'http://127.0.0.1:1234/v1' });
    // 初期アダプタ（コンストラクタ）から作り直していない = ハッシュ一致で再利用している。
    expect(factory.created).toHaveLength(1);
    expect((await provider.currentSnapshot())).toMatchObject({ provider: 'openai-compatible', model: 'env-model' });
  });

  it('保存済み設定をリクエスト毎に反映し、同じ設定ならアダプタを再利用する', async () => {
    const { provider, repo, factory } = make();
    await provider.complete(request);

    await repo.save(createModelSettings({
      scope,
      main: { source: 'openai-compatible', baseUrl: 'http://192.168.0.5:1234/v1', model: 'saved-model' },
      updatedAt: '2026-07-26T00:00:00.000Z',
    }));

    const first = await provider.complete(request);
    expect(JSON.parse(first.message.content ?? '')).toEqual({ id: 'saved-model', url: 'http://192.168.0.5:1234/v1' });
    expect(factory.created).toHaveLength(2);

    // 設定が変わらない限り作り直さない。
    await provider.complete(request);
    expect(factory.created).toHaveLength(2);

    // 設定を変えたら作り直す。
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T01:00:00.000Z' }));
    const second = await provider.complete(request);
    expect(second.message.content).toBe('"openai/gpt-4o"');
    expect(factory.created).toHaveLength(3);
    expect(await provider.currentSnapshot()).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
  });

  it('スロットを消すと env 既定へ戻る', async () => {
    const { provider, repo } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    expect((await provider.complete(request)).message.content).toBe('"openai/gpt-4o"');

    await repo.save(createModelSettings({ scope, judge: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T01:00:00.000Z' }));

    expect(JSON.parse((await provider.complete(request)).message.content ?? '')).toEqual({ id: 'env-model', url: 'http://127.0.0.1:1234/v1' });
  });

  it('slot ごとに独立して解決する（main の設定は judge に影響しない）', async () => {
    const repo = new InMemoryModelSettingsRepository();
    const judge = make(repo, new FakeCipher(), new FakeFactory(), 'judge').provider;
    const main = make(repo, new FakeCipher(), new FakeFactory(), 'main').provider;
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T00:00:00.000Z' }));

    expect((await main.complete(request)).message.content).toBe('"openai/gpt-4o"');
    expect(JSON.parse((await judge.complete(request)).message.content ?? '')).toEqual({ id: 'env-model', url: 'http://127.0.0.1:1234/v1' });
  });

  it('封緘済みキーを開封して工場へ渡す（保存済みデータには平文が無い）', async () => {
    const { provider, repo, cipher, factory } = make();
    await repo.save(createModelSettings({
      scope,
      main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-secret-9999') },
      updatedAt: '2026-07-26T00:00:00.000Z',
    }));

    await provider.complete(request);

    const created = factory.created.at(-1);
    expect(created?.options.model).toEqual({ id: 'openai/gpt-4o', apiKey: 'sk-secret-9999' });
    // 指紋にはキーそのものは載らない（ハッシュにだけ寄与する）。
    const snapshot = await provider.currentSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain('sk-secret-9999');
    expect(snapshot.modelConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('キーだけを差し替えても設定変更として検知する（ハッシュに平文が寄与する）', async () => {
    const { provider, repo, cipher, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-first-1111') }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    await provider.complete(request);
    const before = factory.created.length;
    const beforeHash = (await provider.currentSnapshot()).modelConfigHash;

    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-second-2222') }, updatedAt: '2026-07-26T01:00:00.000Z' }));
    await provider.complete(request);

    expect(factory.created.length).toBe(before + 1);
    expect((await provider.currentSnapshot()).modelConfigHash).not.toBe(beforeHash);
  });

  it('復号できないキーは env 既定へ黙って落とさず SecretCipherError にする', async () => {
    const { provider, repo, cipher } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: await cipher.seal('sk-secret-9999') }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    cipher.failOpen = true;

    await expect(provider.complete(request)).rejects.toThrow(SecretCipherError);
  });

  it('設定の読み出し失敗は ModelProviderError として伝える', async () => {
    const repo = new InMemoryModelSettingsRepository();
    repo.find = async () => { throw new Error('db is gone'); };
    const { provider } = make(repo);

    await expect(provider.complete(request)).rejects.toThrow(ModelProviderError);
  });

  it('capabilities() は最後に解決したアダプタのものを返す', async () => {
    const factory = new FakeFactory();
    const { provider, repo } = make(new InMemoryModelSettingsRepository(), new FakeCipher(), factory);
    expect(provider.capabilities()).toEqual(['chat']);

    factory.capabilities = ['chat', 'tool-calling', 'structured-output'];
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    // 解決前は旧アダプタの能力（同期契約の帰結）。
    expect(provider.capabilities()).toEqual(['chat']);

    await provider.complete(request);
    expect(provider.capabilities()).toEqual(['chat', 'tool-calling', 'structured-output']);
  });

  it('lastSnapshot() は直近に解決した設定を同期で返す（judge評価の記録用）', async () => {
    const { provider, repo } = make();
    expect(provider.lastSnapshot()).toMatchObject({ provider: 'openai-compatible', model: 'env-model' });

    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'anthropic/claude-sonnet-4' }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    await provider.complete(request);

    expect(provider.lastSnapshot()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4' });
  });

  it('sourceRevision を指紋へ載せる', async () => {
    const repo = new InMemoryModelSettingsRepository();
    const provider = new SwitchableModelProvider(repo, new FakeCipher(), new FakeFactory(), 'main', envDefault, scope, { sourceRevision: 'abc123' });
    expect((await provider.currentSnapshot()).sourceRevision).toBe('abc123');
  });

  it('登録簿モデル（キー無し）は文字列のまま工場へ渡る', async () => {
    const { provider, repo, factory } = make();
    await repo.save(createModelSettings({ scope, main: { source: 'registry', model: 'openai/gpt-4o' }, updatedAt: '2026-07-26T00:00:00.000Z' }));
    await provider.complete(request);
    expect(factory.created.at(-1)?.options.model).toBe('openai/gpt-4o');
  });
});
