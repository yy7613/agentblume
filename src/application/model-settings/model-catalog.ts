/**
 * application層(Port): モデル選択肢の提示。
 *
 * providers() が返すのは**接続先の見出しだけ**である。モデル名は含めない。
 * モデルは提供元で頻繁に増減・改名され、Azure / Bedrock / Vertex では利用者が
 * デプロイ・有効化したものしか使えないため、こちらが固定値の一覧を持つと必ず嘘になる。
 * 実際に選べるモデルは (1) 利用者の手入力、(2) listOpenAiCompatibleModels() による
 * 実エンドポイントへの問い合わせ、のどちらかでしか決まらない。
 */
import type { ModelSettingsSource } from '../../domain/model-settings/model-settings';

/** プロバイダの見出し。**モデル一覧は持たない**（固定値のモデル名を配らない）。 */
export interface ModelCatalogProvider {
  /** registry のときは `'provider/model'` の provider 部。openai-compatible のときは画面上の識別子。 */
  readonly id: string;
  readonly name: string;
  /** この見出しを選んだときに保存される設定の形式。 */
  readonly source: ModelSettingsSource;
  /** APIキーを与える環境変数名（複数ある場合は代表1つ・registry のみ）。 */
  readonly envVar?: string;
  /** 利用可能なモデルの一次情報（提供元のドキュメント）。固定のモデル名を配らない代わりの導線。 */
  readonly docUrl?: string;
  /** openai-compatible の baseUrl 雛形。`<resource>` のような穴は利用者が埋める。 */
  readonly baseUrlTemplate?: string;
  /** 保存済み baseUrl からこの見出しを引き当てるためのホスト接尾辞。 */
  readonly baseUrlHosts?: readonly string[];
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
