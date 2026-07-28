/**
 * adapters層: モデル選択肢の提示。
 *
 * ## 方針: 「主要プロバイダの見出しだけ」を出し、モデル名は固定値で持たない
 *
 * かつては @mastra/core にバンドルされた登録簿（138プロバイダ）を全部並べ、さらに
 * プロバイダごとのモデル一覧（バンドル済みの静的データ）まで返していた。これをやめた理由:
 *
 * - **選択肢が過剰**だった。実運用で選ばれるのは主要プロバイダだけで、残りは
 *   ほぼOpenAI互換ゲートウェイである（`openai-compatible` + baseUrl で今も到達できる）。
 * - **モデル名の固定値は必ず陳腐化する**。モデルは頻繁に増減・改名され、バンドル済みの
 *   一覧は依存を更新するまで古いままになる。加えて Azure / Bedrock / Vertex では
 *   **利用者が自分でデプロイ・有効化したモデルしか使えない**ため、提供元のモデル名を
 *   並べて見せること自体が誤誘導になる。
 *
 * よってモデル名は「利用者の手入力」か「実エンドポイントへの問い合わせ（`/models`）」だけで決まる。
 * 提示するのは*どこに繋ぐか*（プロバイダ見出し）に限り、モデルの一次情報へは docUrl で誘導する。
 *
 * ## 主要クラウドは登録簿に無い
 *
 * Mastra の `PROVIDER_REGISTRY` に Azure AI Foundry / AWS Bedrock / Google Vertex AI は**無い**。
 * 3社ともOpenAI互換のチャット補完エンドポイントを公開しているので、`openai-compatible` の
 * **接続先プリセット**（baseUrlの雛形）として持つ。registry 側は登録簿に実在するものだけを載せ、
 * 表示名・環境変数名・ドキュメントURLは登録簿から取る（SDK更新に追随させ、手書きの固定値を増やさない）。
 *
 * listOpenAiCompatibleModels() だけが実ネットワークへ出る。失敗は空配列で握りつぶさず
 * ModelCatalogError にする（UIが「0件」と「繋がらない」を区別できるように）。
 */
import '../../mastra-runtime-env'; // @mastra より先に評価する（import順が意味を持つ・並べ替え禁止）。
import { getProviderConfig } from '@mastra/core/llm';
import { ModelCatalogError, type ModelCatalogPort, type ModelCatalogProvider } from '../../application/model-settings/model-catalog';

/** モデル一覧取得のタイムアウト（ローカル前提なので短く）。 */
export const MODEL_LIST_TIMEOUT_MS = 5_000;

/**
 * 登録簿から見出しを作る主要プロバイダ（`provider/model` 形式で保存されるもの）。
 * 表示名・環境変数名・docUrl は登録簿由来なので、ここには**IDしか書かない**。
 */
const REGISTRY_PROVIDER_IDS = ['openai', 'anthropic', 'google'] as const;

/**
 * OpenAI互換エンドポイントとして繋ぐ主要プロバイダ。
 *
 * `baseUrlTemplate` は**雛形**で、`<...>` の部分は利用者が自分の資源名で埋める（保存前に検証する）。
 * `baseUrlHosts` は保存済み設定を読み直したときに「どのプリセットだったか」を引き当てるためのホスト接尾辞。
 * モデル名は持たない（デプロイ済みのものしか使えないため、一次情報は docUrl へ誘導する）。
 */
const OPENAI_COMPATIBLE_PROVIDERS: readonly ModelCatalogProvider[] = [
  {
    id: 'azure-ai-foundry',
    name: 'Microsoft Azure AI Foundry',
    source: 'openai-compatible',
    baseUrlTemplate: 'https://<resource>.services.ai.azure.com/openai/v1',
    baseUrlHosts: ['.services.ai.azure.com', '.openai.azure.com', '.cognitiveservices.azure.com'],
    docUrl: 'https://learn.microsoft.com/azure/ai-foundry/concepts/models-featured',
  },
  {
    id: 'aws-bedrock',
    name: 'AWS Bedrock',
    source: 'openai-compatible',
    baseUrlTemplate: 'https://bedrock-runtime.<region>.amazonaws.com/openai/v1',
    baseUrlHosts: ['.amazonaws.com'],
    docUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
  {
    id: 'google-vertex',
    name: 'Google Cloud Vertex AI',
    source: 'openai-compatible',
    baseUrlTemplate: 'https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>/endpoints/openapi',
    baseUrlHosts: ['-aiplatform.googleapis.com'],
    docUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/models',
  },
  {
    // 受け皿。ローカル（LM Studio / vLLM 等）と、上に挙げていないOpenAI互換サービスの両方をここで賄う。
    id: 'openai-compatible',
    name: 'OpenAI-compatible endpoint',
    source: 'openai-compatible',
    baseUrlTemplate: 'http://127.0.0.1:1234/v1',
  },
];

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

  /** 見出しは静的なので一度だけ組み立てて使い回す（宣言順＝表示順。名前で並べ替えない）。 */
  providers(): readonly ModelCatalogProvider[] {
    if (this.cached !== undefined) return this.cached;
    const registry: ModelCatalogProvider[] = [];
    for (const id of REGISTRY_PROVIDER_IDS) {
      // 登録簿から消えたIDは黙って落とす（存在しないプロバイダを選ばせない）。
      const config = getProviderConfig(id);
      if (config === undefined) continue;
      const envVar = envVarOf(config.apiKeyEnvVar);
      registry.push({
        id,
        name: config.name,
        source: 'registry',
        ...(envVar === undefined ? {} : { envVar }),
        ...(typeof config.docUrl === 'string' && config.docUrl !== '' ? { docUrl: config.docUrl } : {}),
      });
    }
    this.cached = [...registry, ...OPENAI_COMPATIBLE_PROVIDERS];
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
