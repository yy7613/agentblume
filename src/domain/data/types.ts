/**
 * ドメイン: データ型（v1 実装契約 §2）
 *
 * 純粋なデータ表現。`readonly` を全面採用し、Table/Row を破壊的変更しない前提。
 */

/** セルの論理型。`unknown` は判別不能（NaN/Infinity/Invalid Date/型混在 など）。 */
export type DataType = 'string' | 'number' | 'boolean' | 'date' | 'null' | 'unknown';

/** スキーマ上の1列。 */
export interface Column {
  readonly name: string;
  readonly type: DataType;
  readonly nullable: boolean;
}

/** 列の集合。 */
export interface Schema {
  readonly columns: readonly Column[];
}

/** セルが取りうる値。 */
export type Cell = string | number | boolean | Date | null;

/** 1行。列名→セルのマップ。 */
export type Row = Readonly<Record<string, Cell>>;

/** スキーマ + 行データ。 */
export interface Table {
  readonly schema: Schema;
  readonly rows: readonly Row[];
}

/**
 * スキーマの確からしさ（docs/03 §4）。
 * 確定 / 部分確定 / 推論 / 不明 / 実行結果と不一致。
 */
export type SchemaState = 'confirmed' | 'partial' | 'inferred' | 'unknown' | 'mismatch';
