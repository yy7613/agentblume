/**
 * adapters層: モデル選択肢の提示。
 *
 * providers() は @mastra/core にバンドルされた登録簿（オフラインで解決できる静的データ）から作る。
 * 138プロバイダ × 数十モデルと大きいので、**見出しとモデル一覧を分ける**:
 *   - providers() … id / name / envVar / modelCount だけ（軽量・全プロバイダ）
 *   - providerModels(id) … そのプロバイダのチャットモデル**全件**（件数で切らない）
 * かつては1応答へ全部詰めて「1プロバイダ50件・辞書順」で切っていたが、openrouter のように
 * 数百件あるプロバイダでは `openai/*` `google/*` 等の主要モデルが丸ごと落ちていた。
 *
 * チャット以外のモデル（embedding / whisper / TTS / 画像・動画生成 / rerank / moderation）は
 * main / judge スロットに設定できないので、モデル名の慣用パターンで除外する。
 *
 * listOpenAiCompatibleModels() だけが実ネットワークへ出る（ローカルの LM Studio / vLLM を想定）。
 * 失敗は空配列で握りつぶさず ModelCatalogError にする（UIが「0件」と「繋がらない」を区別できるように）。
 */
import '../../mastra-runtime-env'; // @mastra より先に評価する（import順が意味を持つ・並べ替え禁止）。
import { PROVIDER_REGISTRY, getProviderConfig } from '@mastra/core/llm';
import { ModelCatalogError, type ModelCatalogPort, type ModelCatalogProvider } from '../../application/model-settings/model-catalog';

/** モデル一覧取得のタイムアウト（ローカル前提なので短く）。 */
export const MODEL_LIST_TIMEOUT_MS = 5_000;

/**
 * チャット用途で使えないモデルを示す慣用パターン。
 * モデル名は登録簿ごとに命名が揺れるため、部分一致（小文字化後）で見る。
 */
const NON_CHAT_PATTERNS = ['embedding', 'embed-', 'whisper', 'image', 'dall-e', 'video', 'tts', 'audio', 'rerank', 'moderation'] as const;

/** チャットスロットに設定できるモデルIDか（純関数）。 */
export function isChatModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (id === '') return false;
  return !NON_CHAT_PATTERNS.some((pattern) => id.includes(pattern));
}

function envVarOf(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  return Array.isArray(value) ? value[0] : undefined;
}

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmed}/models`;
}

/** OpenAI互換 `/models` の応答からモデルIDを取り出す（`{data:[{id}]}` 形式）。 */
function parseModelIds(payload: unknown): readonly string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ModelCatalogError('Model list response did not contain a data array');
  const ids = data
    .map((entry) => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export class RegistryModelCatalog implements ModelCatalogPort {
  private cached: ReadonlyMap<string, { readonly provider: ModelCatalogProvider; readonly models: readonly string[] }> | undefined;
  private cachedProviders: readonly ModelCatalogProvider[] | undefined;

  /** 登録簿は静的なので一度だけ組み立てて使い回す。 */
  providers(): readonly ModelCatalogProvider[] {
    if (this.cachedProviders === undefined) this.cachedProviders = [...this.index().values()].map((entry) => entry.provider);
    return this.cachedProviders;
  }

  providerModels(providerId: string): readonly string[] | undefined {
    return this.index().get(providerId.trim())?.models;
  }

  private index(): ReadonlyMap<string, { readonly provider: ModelCatalogProvider; readonly models: readonly string[] }> {
    if (this.cached !== undefined) return this.cached;
    const entries: { readonly provider: ModelCatalogProvider; readonly models: readonly string[] }[] = [];
    for (const id of Object.keys(PROVIDER_REGISTRY)) {
      const config = getProviderConfig(id);
      if (config === undefined) continue;
      const envVar = envVarOf(config.apiKeyEnvVar);
      const models = [...config.models].filter(isChatModelId).sort((left, right) => left.localeCompare(right));
      entries.push({
        provider: { id, name: config.name, ...(envVar === undefined ? {} : { envVar }), modelCount: models.length },
        models,
      });
    }
    entries.sort((left, right) => left.provider.name.localeCompare(right.provider.name));
    this.cached = new Map(entries.map((entry) => [entry.provider.id, entry]));
    return this.cached;
  }

  async listOpenAiCompatibleModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<readonly string[]> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MODEL_LIST_TIMEOUT_MS);
    try {
      const response = await fetch(modelsUrl(baseUrl), {
        method: 'GET',
        headers: { Accept: 'application/json', ...(apiKey === undefined || apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }) },
        signal: controller.signal,
      });
      if (!response.ok) throw new ModelCatalogError(`Model list request failed with status ${response.status}`);
      return parseModelIds(await response.json());
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error;
      // fetch の失敗理由（DNS・接続拒否）だけを伝える。URLにキーは含まれない（Bearerヘッダのみ）。
      throw new ModelCatalogError(`Could not list models from ${modelsUrl(baseUrl)}`, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
