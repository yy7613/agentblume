import { describe, expect, it } from 'vitest';
import { StaticPricingAdapter } from './static-pricing-adapter';

describe('StaticPricingAdapter', () => {
  it('実行時点以前の最新価格snapshotを返し未知modelはnullにする', async () => {
    const adapter = new StaticPricingAdapter([{ provider: 'p', model: 'm', currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '2026-01-01T00:00:00.000Z' }, { provider: 'p', model: 'm', currency: 'USD', inputPerMillionTokens: 3, outputPerMillionTokens: 4, effectiveAt: '2026-07-01T00:00:00.000Z' }]);
    await expect(adapter.findPrice('p', 'm', '2026-06-01T00:00:00.000Z')).resolves.toMatchObject({ inputPerMillionTokens: 1 });
    await expect(adapter.findPrice('p', 'm', '2026-07-10T00:00:00.000Z')).resolves.toMatchObject({ inputPerMillionTokens: 3 });
    await expect(adapter.findPrice('p', 'unknown', '2026-07-10T00:00:00.000Z')).resolves.toBeNull();
  });
});
