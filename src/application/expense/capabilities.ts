/**
 * application層: 経費の LLM 機能が使えるかを UI へ伝える（`GET /runtime/capabilities` の `expense`）。
 *
 * - `extraction`: 画像 / PDF の読取。判定は仕訳と同じく「main モデルが設定済み かつ structured output あり（画像は vision も）」。
 * - `detailExtraction`: 経費専用の追加読取（UC7。C の `ReceiptDetailReaderPort.available()`。読取そのものが使えなければ使えない）。
 * - `policyHearing`: 規程のヒアリング（UC9。C が判定する）。
 * モデル設定を知っているのは Composition Root なので、解決器を注入で受け取るだけにする。
 */
import { logSwallowed, type LoggerPort } from '../operations/logger';

export interface ExpenseCapabilities {
  readonly extraction: { readonly enabled: boolean; readonly vision: boolean };
  readonly detailExtraction: { readonly enabled: boolean };
  readonly policyHearing: { readonly enabled: boolean };
}

export const EXPENSE_CAPABILITIES_DISABLED: ExpenseCapabilities = { extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } };

/** 解決器は実用化のキーを省略してよい（省略 = 使えない）。 */
export type ExpenseCapabilitiesResolver = () => Promise<Pick<ExpenseCapabilities, 'extraction'> & Partial<Omit<ExpenseCapabilities, 'extraction'>>>;

export class ExpenseCapabilitiesUseCase {
  constructor(
    private readonly resolve: ExpenseCapabilitiesResolver = async () => EXPENSE_CAPABILITIES_DISABLED,
    private readonly logger?: LoggerPort,
  ) {}

  /** 機能フラグなので、解決器が壊れていても画面を止めない（「使えない」に落として記録する）。 */
  async execute(): Promise<ExpenseCapabilities> {
    try {
      const value = await this.resolve();
      const extraction = value?.extraction?.enabled === true;
      return {
        extraction: { enabled: extraction, vision: extraction && value.extraction.vision === true },
        detailExtraction: { enabled: extraction && value.detailExtraction?.enabled === true },
        policyHearing: { enabled: value?.policyHearing?.enabled === true },
      };
    } catch (error) {
      logSwallowed(this.logger, 'expense capabilities could not be resolved; reporting them as unavailable', error);
      return EXPENSE_CAPABILITIES_DISABLED;
    }
  }
}
