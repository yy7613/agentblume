export interface ModelPriceSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly currency: 'USD';
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
  readonly effectiveAt: string;
}

export interface PricingPort {
  findPrice(provider: string, model: string, at: string): Promise<ModelPriceSnapshot | null>;
}

