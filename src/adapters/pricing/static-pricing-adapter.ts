import type { ModelPriceSnapshot, PricingPort } from '../../application/operations/pricing';

export class StaticPricingAdapter implements PricingPort {
  constructor(private readonly prices: readonly ModelPriceSnapshot[] = []) {}

  async findPrice(provider: string, model: string, at: string): Promise<ModelPriceSnapshot | null> {
    const atMs = new Date(at).getTime();
    const candidates = this.prices
      .filter((price) => price.provider === provider && price.model === model && new Date(price.effectiveAt).getTime() <= atMs)
      .sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt));
    return candidates[0] === undefined ? null : { ...candidates[0] };
  }
}
