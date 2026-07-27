import type { ModelPriceSnapshot, PricingPort } from '../../application/operations/pricing';

/**
 * 価格表の provider ラベルの後方互換エイリアス。
 *
 * v36 でモデル指紋の provider が `lm-studio` / `lm-studio-judge` から
 * 接続方式そのものを表す `openai-compatible` へ変わった。`AGENTCONTEXT_MODEL_PRICING_JSON` を
 * 旧ラベルで書いた環境ではキーが一致しなくなり、estimatedCost が**告知なく undefined へ落ちる**。
 * 完全一致で引けなかったときだけ旧ラベルでも引き直し、既存の設定ファイルを生かす。
 *
 * 新ラベル（キー）は完全一致が最優先。エイリアスは列挙順に試す。
 */
const PROVIDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'openai-compatible': ['lm-studio', 'lm-studio-judge'],
};

export class StaticPricingAdapter implements PricingPort {
  constructor(private readonly prices: readonly ModelPriceSnapshot[] = []) {}

  async findPrice(provider: string, model: string, at: string): Promise<ModelPriceSnapshot | null> {
    for (const candidate of [provider, ...(PROVIDER_ALIASES[provider] ?? [])]) {
      const found = this.findExact(candidate, model, at);
      if (found !== null) return found;
    }
    return null;
  }

  /** `at` 時点で有効な価格のうち、最も新しい effectiveAt のものを返す。 */
  private findExact(provider: string, model: string, at: string): ModelPriceSnapshot | null {
    const atMs = new Date(at).getTime();
    const candidates = this.prices
      .filter((price) => price.provider === provider && price.model === model && new Date(price.effectiveAt).getTime() <= atMs)
      .sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt));
    return candidates[0] === undefined ? null : { ...candidates[0] };
  }
}
