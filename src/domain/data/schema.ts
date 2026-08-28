/**
 * ドメイン: スキーマ推論（v1 実装契約 §3）
 *
 * 純粋関数のみ。入力（配列・オブジェクト）を破壊的変更しない。
 */
import type { Cell, Column, DataType, Row, Schema } from './types';

/**
 * 単一セルの論理型を判定する。
 * - `null` → `'null'`
 * - `number`（有限）→ `'number'`（NaN/Infinity は `'unknown'`）
 * - `boolean` → `'boolean'`
 * - `Date`（有効）→ `'date'`（Invalid Date は `'unknown'`）
 * - `string` → `'string'`
 * - それ以外 → `'unknown'`
 */
export function inferCellType(value: Cell): DataType {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? 'number' : 'unknown';
  }
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'unknown' : 'date';
  }
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

/** スキーマから名前で列を探す。無ければ undefined。 */
export function findColumn(schema: Schema, name: string): Column | undefined {
  return schema.columns.find((c) => c.name === name);
}

/** 指定名の列が存在するか。 */
export function hasColumn(schema: Schema, name: string): boolean {
  return schema.columns.some((c) => c.name === name);
}

/** 列名の配列（宣言順）を返す。 */
export function columnNames(schema: Schema): string[] {
  return schema.columns.map((c) => c.name);
}

/**
 * 宣言スキーマ（declared）に対する実スキーマ（actual）の非互換を1件説明する。互換なら undefined。
 *
 * 判定はTool実行時の出力検査と同一の規則（列数一致 / 宣言列が名前で存在し型一致 /
 * 「実際はnullableなのに宣言が非nullable」は拒否・逆は許容）。列順は問わない。
 * 保存時（宣言 vs 推論）と実行時（宣言 vs 実出力）が同じ規則で判定されることに意味があるため、
 * どちらか一方だけを変更してはならない。
 */
export function schemaIncompatibility(actual: Schema, declared: Schema): string | undefined {
  if (actual.columns.length !== declared.columns.length) {
    return `column count mismatch: expected ${declared.columns.length}, received ${actual.columns.length}`;
  }
  for (const expected of declared.columns) {
    const column = findColumn(actual, expected.name);
    if (column === undefined || column.type !== expected.type || (column.nullable && !expected.nullable)) {
      return `mismatch at '${expected.name}'`;
    }
  }
  return undefined;
}

/**
 * 2つの型を統合する。
 * - 同型 → その型
 * - 片方が `'unknown'` → `'unknown'`
 * - それ以外の異種 → `'unknown'`
 *
 * 注: `'null'` は列推論側（inferColumn）で扱うため、ここでは通常型として比較する。
 */
export function unifyTypes(a: DataType, b: DataType): DataType {
  if (a === b) return a;
  return 'unknown';
}

/**
 * 名前と値列から列（Column）を推論する。
 * - `nullable`: 値に `null` が1つでもあれば true（空配列も true）。
 * - `type`: 非null値の型を `unifyTypes` で畳み込む。非null値が無ければ `'unknown'`。
 */
export function inferColumn(name: string, values: readonly Cell[]): Column {
  let nullable = values.length === 0;
  let type: DataType | undefined;

  for (const value of values) {
    if (value === null) {
      nullable = true;
      continue;
    }
    const t = inferCellType(value);
    type = type === undefined ? t : unifyTypes(type, t);
  }

  return { name, type: type ?? 'unknown', nullable };
}

/**
 * 行の配列からスキーマを推論する。
 * - 列は全行のキー和集合を「初出順」に並べる。
 * - 各列は全行の該当値（欠損キーは `null` 扱い）で `inferColumn`。
 * - 空 `rows` → `{ columns: [] }`。
 */
export function inferSchemaFromRows(rows: readonly Row[]): Schema {
  // 初出順を保つため配列で列名を集める（Set は挿入順を保持するがキー欠損検査のため both を使う）。
  const orderedNames: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        orderedNames.push(key);
      }
    }
  }

  const columns: Column[] = orderedNames.map((name) => {
    const values: Cell[] = rows.map((row) =>
      // 欠損キーは null 扱い。値が undefined（noUncheckedIndexedAccess）でも null に正規化。
      Object.prototype.hasOwnProperty.call(row, name) ? row[name] ?? null : null,
    );
    return inferColumn(name, values);
  });

  return { columns };
}
