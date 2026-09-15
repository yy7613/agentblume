/**
 * application層: 入金消込の LLM 機能（注文書・見積書からの請求書案）が使えるかを UI へ伝える（`/runtime/capabilities` の `receivables`）。
 *
 * 判定の材料（モデル設定）は Composition Root が知っているので、解決器を注入で受ける（仕訳の `JournalCapabilitiesUseCase` と同じ形）。
 */
import { logSwallowed, type LoggerPort } from '../operations/logger';

export interface ReceivablesCapabilities {
  readonly invoiceDraft: { readonly enabled: boolean; readonly vision: boolean };
}

export const RECEIVABLES_CAPABILITIES_DISABLED: ReceivablesCapabilities = { invoiceDraft: { enabled: false, vision: false } };

export class ReceivablesCapabilitiesUseCase {
  constructor(
    private readonly resolve: () => Promise<ReceivablesCapabilities> = async () => RECEIVABLES_CAPABILITIES_DISABLED,
    private readonly logger?: LoggerPort,
  ) {}

  /** 機能フラグなので、解決器が壊れていても画面を止めず「使えない」に落とす（無音にはしない）。 */
  async execute(): Promise<ReceivablesCapabilities> {
    try {
      const value = await this.resolve();
      return { invoiceDraft: { enabled: value?.invoiceDraft?.enabled === true, vision: value?.invoiceDraft?.vision === true } };
    } catch (error) {
      logSwallowed(this.logger, 'receivables capabilities could not be resolved; reporting them as unavailable', error);
      return RECEIVABLES_CAPABILITIES_DISABLED;
    }
  }
}
