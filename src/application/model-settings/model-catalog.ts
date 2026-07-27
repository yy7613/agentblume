/**
 * application層(Port): モデル選択肢の提示。
 *
 * providers() はオフラインで即答できる登録簿（バンドル済み）から作る。
 * listOpenAiCompatibleModels() だけが実ネットワーク（ローカルの LM Studio 等）へ問い合わせる。
 */

/**
 * プロバイダの見出し。**モデル一覧は含めない**（一覧は providerModels で個別に取る）。
 * 全プロバイダ×全モデルを1応答に詰めると数十KiBになり、件数で切ると主要モデルが落ちるため、
 * 「見出し（軽量・全件）→ 選ばれた1プロバイダのモデル（全件）」の2段構成にしている。
 */
export interface ModelCatalogProvider {
  /** `'provider/model'` の provider 部。 */
  readonly id: string;
  readonly name: string;
  /** APIキーを与える環境変数名（複数ある場合は代表1つ）。 */
  readonly envVar?: string;
  /** 選択可能なチャットモデル数（0件のプロバイダをUIが見分けるため）。 */
  readonly modelCount: number;
}

export interface ModelCatalogPort {
  providers(): readonly ModelCatalogProvider[];
  /** 1プロバイダのチャットモデル全件（昇順）。未知のプロバイダは undefined。 */
  providerModels(providerId: string): readonly string[] | undefined;
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
