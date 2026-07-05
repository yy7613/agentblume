/**
 * ドメイン: v15 ノード `sort`（実装契約 §2.3）
 *
 * kind: transform / arity: 1。
 * 複数キーの安定ソート。スキーマは不変。
 * - inferSchema: 各 `column` 存在必須（欠損 → error/mismatch）。正常時 'confirmed'。
 * - execute: 安定ソート（Array.prototype.sort は ES2019+ で安定）。比較:
 *   number/date は数値比較（Date は getTime()）、string は `<`/`>`、boolean は
 *   false<true、型混在セルは String 化比較。null は `nulls` 指定位置へ
 *   （direction に関わらず first/last を絶対位置とする）。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** ソートキー1つ。direction 既定 'asc'、nulls 既定 'last'。 */
export interface SortKey {
  readonly column: string;
  readonly direction?: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
}

/** `sort` の設定。 */
export interface SortConfig {
  readonly keys: SortKey[];
}

const configSchema = z.object({
  keys: z
    .array(
      z.object({
        column: z.string(),
        direction: z.enum(['asc', 'desc']).optional(),
        nulls: z.enum(['first', 'last']).optional(),
      }),
    )
    .min(1),
});

/** 行からセルを取り出す（欠損キーは null 扱い）。 */
function cellOf(row: Row, name: string): Cell {
  return Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
}

/** 順序値の比較（NaN 安全のため差分ではなく大小比較を使う）。 */
function compareOrdered(a: number | string, b: number | string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 非null セル同士の比較。同型は型ごとの規則、型混在は String 化比較。 */
function compareCells(a: Exclude<Cell, null>, b: Exclude<Cell, null>): number {
  if (typeof a === 'number' && typeof b === 'number') return compareOrdered(a, b);
  if (a instanceof Date && b instanceof Date) return compareOrdered(a.getTime(), b.getTime());
  if (typeof a === 'string' && typeof b === 'string') return compareOrdered(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return compareOrdered(a ? 1 : 0, b ? 1 : 0);
  }
  // 型混在セルは String 化して比較する。
  return compareOrdered(String(a), String(b));
}

class SortNode implements EtlNode<SortConfig> {
  readonly type = 'sort';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): SortConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`sort: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: SortConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [];

    for (const key of config.keys) {
      if (findColumn(input, key.column) === undefined) {
        issues.push({
          severity: 'error',
          message: `sort: column not found: ${key.column}`,
          column: key.column,
        });
      }
    }
    if (issues.length > 0) {
      return { schema: input, state: 'mismatch', issues };
    }

    // スキーマは不変。
    return { schema: input, state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: SortConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // 欠損列は実行時エラー。
    const missing = config.keys
      .filter((key) => findColumn(input.schema, key.column) === undefined)
      .map((key) => key.column);
    if (missing.length > 0) {
      throw new SchemaError(`sort: column(s) not found: ${missing.join(', ')}`);
    }

    // 入力を mutate しない: コピーをソートする。
    const rows: Row[] = [...input.rows];
    rows.sort((ra, rb) => {
      for (const key of config.keys) {
        const direction = key.direction ?? 'asc';
        const nulls = key.nulls ?? 'last';
        const a = cellOf(ra, key.column);
        const b = cellOf(rb, key.column);

        if (a === null || b === null) {
          if (a === null && b === null) continue;
          // null は direction に関わらず first/last の絶対位置。
          const nullFirst = nulls === 'first' ? -1 : 1;
          return a === null ? nullFirst : -nullFirst;
        }

        const cmp = compareCells(a, b);
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });

    // スキーマ不変。
    return { schema: input.schema, rows };
  }
}

/** `sort` ノードのシングルトン。 */
export const sortNode: EtlNode<SortConfig> = new SortNode();
