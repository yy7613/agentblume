/**
 * application層: 仕訳の LLM 機能（抽出・ヒアリング）が使えるかを UI へ伝える。
 *
 * フェーズ 1 の画面は「取込」の画像 / PDF / テキストと「ヒアリング」を **機能フラグで隠す**。
 * 判定に必要なのはモデル設定であり、それを知っているのは Composition Root なので、
 * ここでは解決器（`JournalCapabilitiesResolver`）を注入で受け取るだけにする
 * （application が adapters / モデル設定の解決順を知らずに済む）。
 */

import { logSwallowed, type LoggerPort } from '../operations/logger';

export interface JournalCapabilities {
  /** 画像 / PDF / テキストからの facts 抽出（フェーズ 2）。`vision` は画像を渡せるか。 */
  readonly extraction: { readonly enabled: boolean; readonly vision: boolean };
  /** Stage 2 のヒアリング（フェーズ 2）。 */
  readonly hearing: { readonly enabled: boolean };
}

/** 「どちらも使えない」。旧クライアント互換の既定でもある（UI 側も同じ値へ倒す）。 */
export const JOURNAL_CAPABILITIES_DISABLED: JournalCapabilities = {
  extraction: { enabled: false, vision: false },
  hearing: { enabled: false },
};

/** 現在のモデル設定から可否を決める関数。毎回呼ばれる（設定は実行中に変わりうる）。 */
export type JournalCapabilitiesResolver = () => Promise<JournalCapabilities>;

/**
 * `GET /runtime/capabilities` の `journal` を返す。
 * 解決器を渡さなければ常に「使えない」（テストと埋め込み利用の既定）。
 */
export class JournalCapabilitiesUseCase {
  constructor(
    private readonly resolve: JournalCapabilitiesResolver = async () => JOURNAL_CAPABILITIES_DISABLED,
    private readonly logger?: LoggerPort,
  ) {}

  /**
   * これは機能フラグなので、解決器（モデル設定の読み出し）が壊れていても画面を止めない。
   * 失敗したら「どちらも使えない」に落とし、想定外の形が返っても boolean に正規化する。
   * 無音にはしない: 使えるはずの機能が黙って消えるのは追跡不能な事故になる。
   */
  async execute(): Promise<JournalCapabilities> {
    try {
      return normalizeCapabilities(await this.resolve());
    } catch (error) {
      logSwallowed(this.logger, 'journal capabilities could not be resolved; reporting them as unavailable', error);
      return JOURNAL_CAPABILITIES_DISABLED;
    }
  }
}

/** 画面が読む 3 つの旗は必ず boolean にする（解決器が別物を返しても UI の分岐を壊さない）。 */
function normalizeCapabilities(value: JournalCapabilities | undefined): JournalCapabilities {
  return {
    extraction: { enabled: value?.extraction?.enabled === true, vision: value?.extraction?.vision === true },
    hearing: { enabled: value?.hearing?.enabled === true },
  };
}