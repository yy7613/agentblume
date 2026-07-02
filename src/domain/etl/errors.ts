/**
 * ドメイン: エラー型（v1 実装契約 §4）
 *
 * ETL ドメイン内の例外は全てここで定義した型を投げる。
 * `throw new Error()` の直接使用は禁止。
 */

/** ETL ドメインの基底エラー。`code` で機械判別する。 */
export class EtlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EtlError';
    this.code = code;
  }
}

/** 設定（config）検証エラー。code は 'ETL_CONFIG'。 */
export class ConfigError extends EtlError {
  constructor(message: string) {
    super('ETL_CONFIG', message);
    this.name = 'ConfigError';
  }
}

/** スキーマ/実行時の列・型不一致エラー。code は 'ETL_SCHEMA'。 */
export class SchemaError extends EtlError {
  constructor(message: string) {
    super('ETL_SCHEMA', message);
    this.name = 'SchemaError';
  }
}

/** グラフ構造（重複id・未知参照・閉路・端点数など）エラー。code は 'ETL_GRAPH'。 */
export class GraphError extends EtlError {
  constructor(message: string) {
    super('ETL_GRAPH', message);
    this.name = 'GraphError';
  }
}
