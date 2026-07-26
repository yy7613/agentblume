/**
 * application層(Port): モデル選択肢の提示。
 *
 * providers() はオフラインで即答できる登録簿（バンドル済み）から作る。
 * listOpenAiCompatibleModels() だけが実ネットワーク（ローカルの LM Studio 等）へ問い合わせる。
 */

export interface ModelCatalogProvider {
  /** `'provider/model'` の provider 部。 */
  readonly id: string;
  readonly name: string;
  /** APIキーを与える環境変数名（複数ある場合は代表1つ）。 */
  readonly envVar?: string;
  readonly models: readonly string[];
}

export interface ModelCatalogPort {
  providers(): readonly ModelCatalogProvider[];
  listOpenAiCompatibleModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<readonly string[]>;
}

/**
 * モデル一覧の取得失敗（到達不能・認証拒否・不正な応答）。
 * メッセージにAPIキーを含めてはならない。api では 502。
 */
export class ModelCatalogError extends Error {
  readonly code = 'MODEL_CATALOG';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}
