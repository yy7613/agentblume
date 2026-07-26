/**
 * application層(Port): 解決済みモデル設定から ModelProviderPort を作る工場。
 *
 * ベンダー固有の規約（OpenAI互換エンドポイントに与える擬似プロバイダ接頭辞など）は
 * adapters 側の実装に閉じ込める。application は「この設定で通信できるアダプタをくれ」としか言わない。
 *
 * **平文APIキーはこのPortを通過するだけ**で、どこにも保存されない（呼び出し側も保持しない）。
 */
import type { ModelCapability, ModelProviderPort } from '../model/model-provider';

/**
 * 工場へ渡す解決済み設定。
 *
 * - `model` が文字列 … 登録簿のモデルID（`'provider/model'`。キー不要のプロバイダ）。
 * - `model` がオブジェクトで `url` あり … OpenAI互換のカスタムエンドポイント。
 *   `id` は**モデル名そのもの**でよく、擬似プロバイダ接頭辞の付与は実装（adapters）の責務。
 * - `model` がオブジェクトで `url` なし … 登録簿のモデルID + 明示APIキー。
 */
export interface ResolvedSlotOptions {
  readonly model: string | { readonly id: string; readonly url?: string; readonly apiKey?: string };
  readonly capabilities?: readonly ModelCapability[];
  /** 総時間の上限（ms）。未指定なら実装の既定（env）。 */
  readonly timeoutMs?: number;
  /** 無出力の上限（ms）。未指定なら実装の既定（env）。 */
  readonly idleTimeoutMs?: number;
  /** 出力トークン上限。未指定なら実装の既定（env、無ければモデル既定）。 */
  readonly maxTokens?: number;
}

export interface ModelProviderFactoryPort {
  create(options: ResolvedSlotOptions): ModelProviderPort;
}
