import { describe, expect, it } from 'vitest';
import { StaticPricingAdapter } from './static-pricing-adapter';

describe('StaticPricingAdapter', () => {
  it('実行時点以前の最新価格snapshotを返し未知modelはnullにする', async () => {
    const adapter = new StaticPricingAdapter([{ provider: 'p', model: 'm', currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '2026-01-01T00:00:00.000Z' }, { provider: 'p', model: 'm', currency: 'USD', inputPerMillionTokens: 3, outputPerMillionTokens: 4, effectiveAt: '2026-07-01T00:00:00.000Z' }]);
    await expect(adapter.findPrice('p', 'm', '2026-06-01T00:00:00.000Z')).resolves.toMatchObject({ inputPerMillionTokens: 1 });
    await expect(adapter.findPrice('p', 'm', '2026-07-10T00:00:00.000Z')).resolves.toMatchObject({ inputPerMillionTokens: 3 });
    await expect(adapter.findPrice('p', 'unknown', '2026-07-10T00:00:00.000Z')).resolves.toBeNull();
  });

  describe('provider ラベルの後方互換', () => {
    const legacy = (provider: string) => new StaticPricingAdapter([
      { provider, model: 'qwen3-8b', currency: 'USD' as const, inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '2026-01-01T00:00:00.000Z' },
    ]);

    it('openai-compatible で引けないとき旧ラベル lm-studio でも引く', async () => {
      // v36 で指紋の provider が lm-studio → openai-compatible に変わったため、
      // 旧ラベルで書かれた AGENTCONTEXT_MODEL_PRICING_JSON が外れてコストが無言で消えていた。
      await expect(legacy('lm-studio').findPrice('openai-compatible', 'qwen3-8b', '2026-07-10T00:00:00.000Z'))
        .resolves.toMatchObject({ provider: 'lm-studio', inputPerMillionTokens: 1 });
    });

    it('judge スロットの旧ラベル lm-studio-judge でも引く', async () => {
      await expect(legacy('lm-studio-judge').findPrice('openai-compatible', 'qwen3-8b', '2026-07-10T00:00:00.000Z'))
        .resolves.toMatchObject({ provider: 'lm-studio-judge' });
    });

    it('完全一致が最優先で、エイリアスに引きずられない', async () => {
      const adapter = new StaticPricingAdapter([
        { provider: 'lm-studio', model: 'm', currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 1, effectiveAt: '2026-01-01T00:00:00.000Z' },
        { provider: 'openai-compatible', model: 'm', currency: 'USD', inputPerMillionTokens: 9, outputPerMillionTokens: 9, effectiveAt: '2026-01-01T00:00:00.000Z' },
      ]);

      await expect(adapter.findPrice('openai-compatible', 'm', '2026-07-10T00:00:00.000Z'))
        .resolves.toMatchObject({ provider: 'openai-compatible', inputPerMillionTokens: 9 });
    });

    it('エイリアスは新ラベルの向きにしか効かない（lm-studio → openai-compatible は引かない）', async () => {
      await expect(legacy('openai-compatible').findPrice('lm-studio', 'qwen3-8b', '2026-07-10T00:00:00.000Z')).resolves.toBeNull();
    });
  });
});
