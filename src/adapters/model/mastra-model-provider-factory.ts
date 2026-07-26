/**
 * adapters層: 解決済みモデル設定から MastraModelProvider を作る工場。
 *
 * ベンダー規約をここに一元化する:
 * - OpenAI互換のカスタムエンドポイント（url あり）には**登録簿に存在しない接頭辞 `local/`** を付ける。
 *   `lmstudio/` のような実在プロバイダ名を使うと、Mastra 側の能力表に基づき temperature が
 *   黙って削除される（登録簿に無いモデル扱いになるため）。`local/` なら素の OpenAI 互換として扱われる。
 * - 登録簿のモデル（url なし）は `'provider/model'` 文字列のまま渡す（キーがある場合だけオブジェクト形）。
 *
 * timeout / maxTokens は呼び出し側の指定 > 工場の既定（env 由来）の順で決める。
 */
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from '../../application/model-settings/model-provider-factory';
import type { ModelProviderPort } from '../../application/model/model-provider';
import { MastraModelProvider, type MastraModelProviderOptions, type MastraOpenAiCompatibleModel } from './mastra-model-provider';

/** 登録簿に存在しない擬似プロバイダ名（カスタムエンドポイント専用）。 */
export const LOCAL_PROVIDER_PREFIX = 'local';

export interface MastraModelProviderFactoryDefaults {
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxTokens?: number;
}

/** モデル名へ `local/` を付ける（既に付いていれば二重に付けない）。 */
export function withLocalPrefix(modelId: string): string {
  const id = modelId.trim();
  return id.startsWith(`${LOCAL_PROVIDER_PREFIX}/`) ? id : `${LOCAL_PROVIDER_PREFIX}/${id}`;
}

export class MastraModelProviderFactory implements ModelProviderFactoryPort {
  constructor(private readonly defaults: MastraModelProviderFactoryDefaults = {}) {}

  create(options: ResolvedSlotOptions): ModelProviderPort {
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs;
    const idleTimeoutMs = options.idleTimeoutMs ?? this.defaults.idleTimeoutMs;
    const maxTokens = options.maxTokens ?? this.defaults.maxTokens;
    const model: string | MastraOpenAiCompatibleModel = typeof options.model === 'string'
      ? options.model
      : options.model.url === undefined
        ? { id: options.model.id.trim(), ...(options.model.apiKey === undefined ? {} : { apiKey: options.model.apiKey }) }
        : { id: withLocalPrefix(options.model.id), url: options.model.url, ...(options.model.apiKey === undefined ? {} : { apiKey: options.model.apiKey }) };
    const providerOptions: MastraModelProviderOptions = {
      model,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    };
    return new MastraModelProvider(providerOptions);
  }
}
