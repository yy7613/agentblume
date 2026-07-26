/**
 * adapters層: モデル選択肢の提示。
 *
 * providers() は @mastra/core にバンドルされた登録簿（オフラインで解決できる静的データ）から作る。
 * 138プロバイダ × 数十モデルと大きいため、1プロバイダあたり先頭 MODEL_CATALOG_MODEL_LIMIT 件へ切る
 * （UIは検索・自由入力も併用する前提）。
 *
 * listOpenAiCompatibleModels() だけが実ネットワークへ出る（ローカルの LM Studio / vLLM を想定）。
 * 失敗は空配列で握りつぶさず ModelCatalogError にする（UIが「0件」と「繋がらない」を区別できるように）。
 */
import { PROVIDER_REGISTRY, getProviderConfig } from '@mastra/core/llm';
import { ModelCatalogError, type ModelCatalogPort, type ModelCatalogProvider } from '../../application/model-settings/model-catalog';

// 登録簿の動的更新（ネットワーク取得）を止める。オフラインファースト。
process.env['MASTRA_OFFLINE'] ??= '1';
process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true';

/** 1プロバイダあたりの提示上限。 */
export const MODEL_CATALOG_MODEL_LIMIT = 50;
/** モデル一覧取得のタイムアウト（ローカル前提なので短く）。 */
export const MODEL_LIST_TIMEOUT_MS = 5_000;

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
  private cached: readonly ModelCatalogProvider[] | undefined;

  /** 登録簿は静的なので一度だけ組み立てて使い回す。 */
  providers(): readonly ModelCatalogProvider[] {
    if (this.cached !== undefined) return this.cached;
    const providers: ModelCatalogProvider[] = [];
    for (const id of Object.keys(PROVIDER_REGISTRY)) {
      const config = getProviderConfig(id);
      if (config === undefined) continue;
      const envVar = envVarOf(config.apiKeyEnvVar);
      providers.push({
        id,
        name: config.name,
        ...(envVar === undefined ? {} : { envVar }),
        models: [...config.models].sort((left, right) => left.localeCompare(right)).slice(0, MODEL_CATALOG_MODEL_LIMIT),
      });
    }
    this.cached = providers.sort((left, right) => left.name.localeCompare(right.name));
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
