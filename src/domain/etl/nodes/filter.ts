/**
 * ドメイン: v1 ノード `filter`（実装契約 §9.4）
 *
 * kind: transform / arity: 1。
 * 述語で行をフィルタする。スキーマは不変。
 * - inferSchema: `column` 存在必須（欠損 → error/mismatch）。`gt|gte|lt|lte` は列型が
 *   number|date 必須（違反 → 型不一致 error + mismatch）。それ以外は入力スキーマ
 *   そのまま state:'confirmed'。
 * - execute: 述語で行を残す。eq/neq=厳密等価（Date は時刻値比較）; 大小=数値/日付比較;
 *   contains=文字列包含（String化）; isNull/notNull。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** フィルタ演算子。 */
export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isNull' | 'notNull';

/** `filter` の設定。 */
export interface FilterConfig {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: Cell;
}

/** 順序比較を要する演算子（列型 number|date が必須）。 */
const ORDER_OPS: ReadonlySet<FilterOp> = new Set(['gt', 'gte', 'lt', 'lte']);

const cellSchema: z.ZodType<Cell> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.instanceof(Date),
  z.null(),
]);

const configSchema = z.object({
  column: z.string(),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isNull', 'notNull']),
  value: cellSchema.optional(),
});

/** Cell を順序比較用の数値に変換する（number はそのまま / Date は時刻値 / 他は NaN）。 */
function toComparable(value: Cell): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

/** eq/neq 用の厳密等価（Date は時刻値で比較）。 */
function cellEquals(a: Cell, b: Cell): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  // 片方だけ Date のときは厳密には非等価（型が異なる）。
  if (a instanceof Date || b instanceof Date) return false;
  return a === b;
}

/** 1セルに対して述語を評価する。 */
function evaluate(cell: Cell, op: FilterOp, value: Cell): boolean {
  switch (op) {
    case 'isNull':
      return cell === null;
    case 'notNull':
      return cell !== null;
    case 'eq':
      return cellEquals(cell, value);
    case 'neq':
      return !cellEquals(cell, value);
    case 'contains':
      return String(cell).includes(String(value));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(cell);
      const b = toComparable(value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

class FilterNode implements EtlNode<FilterConfig> {
  readonly type = 'filter';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): FilterConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`filter: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: FilterConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [];

    const col = findColumn(input, config.column);
    if (col === undefined) {
      issues.push({
        severity: 'error',
        message: `filter: column not found: ${config.column}`,
        column: config.column,
      });
      return { schema: input, state: 'mismatch', issues };
    }

    if (ORDER_OPS.has(config.op) && col.type !== 'number' && col.type !== 'date') {
      issues.push({
        severity: 'error',
        message: `filter: operator '${config.op}' requires column type number|date, but '${config.column}' is '${col.type}'`,
        column: config.column,
      });
      return { schema: input, state: 'mismatch', issues };
    }

    // スキーマは不変。
    return { schema: input, state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: FilterConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const value = config.value ?? null;

    const rows: Row[] = input.rows.filter((row: Row) => {
      const cell = Object.prototype.hasOwnProperty.call(row, config.column)
        ? (row[config.column] ?? null)
        : null;
      return evaluate(cell, config.op, value);
    });

    // スキーマ不変。行配列は filter が新規生成。
    return { schema: input.schema, rows };
  }
}

/** `filter` ノードのシングルトン。 */
export const filterNode: EtlNode<FilterConfig> = new FilterNode();
