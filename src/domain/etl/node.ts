/**
 * ドメイン: ノード契約（v1 実装契約 §5）— 型のみ。
 */
import type { Schema, SchemaState, Table } from '../data/types';

/** ノードの分類。 */
export type NodeKind = 'source' | 'transform' | 'analyze' | 'sink';

/** スキーマ推論時に検出した問題。 */
export interface SchemaIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly column?: string;
}

/** 1ノードのスキーマ推論結果。 */
export interface SchemaInference {
  /** 出力スキーマ。 */
  readonly schema: Schema;
  /** ノード“局所”の状態（上流状態は Engine が合成する）。 */
  readonly state: SchemaState;
  /** 検出した問題（無ければ空）。 */
  readonly issues: readonly SchemaIssue[];
}

/**
 * ETL ノード契約。
 *
 * 局所 state の意味:
 * - `confirmed`: 入力から出力スキーマを厳密に確定でき、issue なし。
 * - `inferred`: サンプル等からの推論で確定度が下がる（例: source）。
 * - `partial`: 一部列のみ確定。
 * - `mismatch`: エラー issue あり（例: 存在しない列参照、型不一致）。
 * - `unknown`: 入力不足等で判断不能。
 */
export interface EtlNode<Config = unknown> {
  /** 一意キー 例 'json-source'。 */
  readonly type: string;
  readonly kind: NodeKind;
  /** 期待する入力数（v1: source=0, transform=1）。 */
  readonly inputArity: 0 | 1 | 2;
  /** config を Zod 等で検証。失敗は ConfigError を投げる。 */
  validateConfig(config: unknown): Config;
  /** 入力スキーマ群から出力スキーマを推論する。 */
  inferSchema(inputs: readonly Schema[], config: Config): SchemaInference;
  /** 入力テーブル群から出力テーブルを生成する。 */
  execute(inputs: readonly Table[], config: Config): Table;
}
