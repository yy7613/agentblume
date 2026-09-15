/**
 * application層: 契約書レビューの LLM 機能が使えるかを UI へ伝える（`GET /runtime/capabilities` の `contract`）。
 *
 * 判定に要るモデル設定を知っているのは Composition Root なので、解決器を注入で受け取るだけにする（仕訳と同じ形）。
 * - `extraction.enabled`: 条項抽出（structured output）。`extraction.vision`: 画像・スキャン PDF の文字起こし。
 * - `review.llm`: はい/いいえ型の基準をモデルに答えさせられるか（使えなくても決定的な判定は出る）。
 */
import { logSwallowed, type LoggerPort } from '../operations/logger';

export interface ContractCapabilities {
  readonly extraction: { readonly enabled: boolean; readonly vision: boolean };
  readonly review: { readonly llm: boolean };
}

export const CONTRACT_CAPABILITIES_DISABLED: ContractCapabilities = {
  extraction: { enabled: false, vision: false },
  review: { llm: false },
};

export type ContractCapabilitiesResolver = () => Promise<ContractCapabilities>;

export class ContractCapabilitiesUseCase {
  constructor(
    private readonly resolve: ContractCapabilitiesResolver = async () => CONTRACT_CAPABILITIES_DISABLED,
    private readonly logger?: LoggerPort,
  ) {}

  /** 機能フラグなので、解決器が壊れていても画面を止めない（使えない側へ倒し、握り潰したことは残す）。 */
  async execute(): Promise<ContractCapabilities> {
    try {
      const value = await this.resolve();
      return {
        extraction: { enabled: value?.extraction?.enabled === true, vision: value?.extraction?.enabled === true && value.extraction.vision === true },
        review: { llm: value?.review?.llm === true },
      };
    } catch (error) {
      logSwallowed(this.logger, 'contract capabilities could not be resolved; reporting them as unavailable', error);
      return CONTRACT_CAPABILITIES_DISABLED;
    }
  }
}
