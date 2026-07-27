import { describe, expect, it } from 'vitest';
import { MastraModelProvider } from './mastra-model-provider';
import { LOCAL_PROVIDER_PREFIX, MastraModelProviderFactory, withLocalPrefix } from './mastra-model-provider-factory';

/** 生成物の内部設定を読む（工場の責務検証に閉じる）。 */
function internals(provider: unknown): { spec: { id: string; url?: string; apiKey?: string }; timeoutMs: number; idleTimeoutMs: number; options: { maxTokens?: number } } {
  return provider as { spec: { id: string; url?: string; apiKey?: string }; timeoutMs: number; idleTimeoutMs: number; options: { maxTokens?: number } };
}

describe('MastraModelProviderFactory', () => {
  it('カスタムエンドポイントには登録簿に無い local/ 接頭辞を付ける', () => {
    const provider = new MastraModelProviderFactory().create({ model: { id: 'qwen/qwen3-4b', url: 'http://127.0.0.1:1234/v1', apiKey: 'sk-local' } });

    expect(provider).toBeInstanceOf(MastraModelProvider);
    expect(internals(provider).spec).toEqual({ id: 'local/qwen/qwen3-4b', url: 'http://127.0.0.1:1234/v1', apiKey: 'sk-local' });
  });

  it('接頭辞は二重に付かない', () => {
    expect(withLocalPrefix('model')).toBe(`${LOCAL_PROVIDER_PREFIX}/model`);
    expect(withLocalPrefix('local/model')).toBe('local/model');
    expect(withLocalPrefix('  spaced  ')).toBe('local/spaced');
  });

  it('登録簿モデル（文字列）はそのまま渡す', () => {
    const provider = new MastraModelProviderFactory().create({ model: 'openai/gpt-4o' });
    expect(internals(provider).spec).toEqual({ id: 'openai/gpt-4o' });
  });

  it('登録簿モデル + APIキーは url 無しのオブジェクトで渡す（接頭辞も付けない）', () => {
    const provider = new MastraModelProviderFactory().create({ model: { id: 'openai/gpt-4o', apiKey: 'sk-registry' } });
    expect(internals(provider).spec).toEqual({ id: 'openai/gpt-4o', apiKey: 'sk-registry' });
  });

  it('timeout / maxTokens は 呼び出し側指定 > 工場既定 の順で決まる', () => {
    const factory = new MastraModelProviderFactory({ timeoutMs: 300_000, idleTimeoutMs: 15_000, maxTokens: 4096 });

    const fromDefaults = internals(factory.create({ model: 'openai/gpt-4o' }));
    expect(fromDefaults).toMatchObject({ timeoutMs: 300_000, idleTimeoutMs: 15_000 });
    expect(fromDefaults.options.maxTokens).toBe(4096);

    const overridden = internals(factory.create({ model: 'openai/gpt-4o', timeoutMs: 15_000, idleTimeoutMs: 15_000, maxTokens: 32 }));
    expect(overridden).toMatchObject({ timeoutMs: 15_000, idleTimeoutMs: 15_000 });
    expect(overridden.options.maxTokens).toBe(32);
  });

  it('既定も指定も無ければアダプタの既定に委ねる', () => {
    const provider = internals(new MastraModelProviderFactory().create({ model: 'openai/gpt-4o' }));
    expect(provider.timeoutMs).toBe(600_000);
    expect(provider.idleTimeoutMs).toBe(60_000);
    expect(provider.options.maxTokens).toBeUndefined();
  });

  it('capabilities 指定はそのまま生成物へ渡る', () => {
    const provider = new MastraModelProviderFactory().create({ model: 'openai/gpt-4o', capabilities: ['chat'] });
    expect(provider.capabilities()).toEqual(['chat']);
  });

  it('モデル名が空でも生成自体は失敗させず、complete() で「未設定」と分かる文言にする', async () => {
    // LM_STUDIO_MODEL 未設定の env 既定。生成は起動時（SwitchableModelProvider のコンストラクタ）に
    // 走るため、ここで throw すると設定を保存する前にアプリが起動できなくなる。
    const provider = new MastraModelProviderFactory().create({ model: { id: '', url: 'http://127.0.0.1:1234/v1' } });

    expect(internals(provider).spec.id).toBe('local/');
    await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
      message: expect.stringContaining('Model is not configured') as unknown as string,
    });
  });
});
