import { describe, expect, it } from 'vitest';
import { ModelProviderError } from '../../application/model/model-provider';
import { assertModelProviderContract } from './model-provider.contract';
import { ScriptedModelProvider } from './scripted-model-provider';

describe('ScriptedModelProvider', () => {
  it('ModelProviderPort contractを満たす', async () => {
    const provider = new ScriptedModelProvider();
    provider.enqueue({ message: { role: 'assistant', content: 'hello' }, finishReason: 'stop' });
    await assertModelProviderContract(provider);
    expect(provider.requests).toHaveLength(1);
  });

  it('queue不足とabortを共通errorへ変換する', async () => {
    const provider = new ScriptedModelProvider();
    await expect(provider.complete({ messages: [] })).rejects.toBeInstanceOf(ModelProviderError);
    const controller = new AbortController(); controller.abort();
    await expect(provider.complete({ messages: [] }, controller.signal)).rejects.toBeInstanceOf(ModelProviderError);
  });
});
