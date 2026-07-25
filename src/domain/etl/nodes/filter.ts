/**
 * ドメイン: v1 ノード `filter`（実装契約 §9.4 / 複数条件拡張）
 *
 * kind: transform / arity: 1。
 * 述語で行をフィルタする。スキーマは不変。
 *
 * config は2形式を受理する（後方互換）:
 * - 旧形式（1ノード1条件のフラット config）: `{ column, op, value?, valueBinding? }`。
 *   保存済み Tool・スターターグラフ・Factory生成物がこの形なので受理し続け、
 *   validateConfig もこの形のまま返す（application層が root の valueBinding を読む）。
 * - 新形式（複数条件）: `{ conditions: [{ column, op, value?, valueBinding? }], combine: 'and'|'or' }`。
 *   `combine` 省略時は 'and'。これで「東京 or 大阪」が1ノードで表せる。
 *
 * inferSchema / execute は両形式を条件配列へ正規化して処理する。
 * - inferSchema: 各条件の `column` 存在必須（欠損 → error/mismatch）。`gt|gte|lt|lte` は
 *   列型が number|date 必須（違反 → 型不一致 error + mismatch）。問題が無ければ入力
 *   スキーマそのまま state:'confirmed'。複数条件では全条件分の issue を集約する。
 * - execute: combine に応じて全条件 AND / いずれか OR で行を残す。
 *   eq/neq=厳密等価（Date は時刻値比較）; 大小=数値/日付比較;
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

/** 複数条件の結合方法。 */
export type FilterCombine = 'and' | 'or';

/** 条件1つ。旧形式のフラット config もこの形（1条件）として扱う。 */
export interface FilterCondition {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: Cell;
  /** 実行時に Agent Tool の引数で value を上書きする参照。設計時は value をsampleに使う。 */
  readonly valueBinding?: { readonly source: 'agent-input'; readonly field: string };
}

/** 新形式（複数条件 + AND/OR）の設定。 */
export interface FilterConditionsConfig {
  readonly conditions: readonly FilterCondition[];
  /** 省略時は 'and'。 */
  readonly combine?: FilterCombine;
}

/** `filter` の設定。旧形式（単一条件フラット）と新形式（conditions）の両方。 */
export type FilterConfig = FilterCondition | FilterConditionsConfig;

/** 順序比較を要する演算子（列型 number|date が必須）。 */
const ORDER_OPS: ReadonlySet<FilterOp> = new Set(['gt', 'gte', 'lt', 'lte']);

const cellSchema: z.ZodType<Cell> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.instanceof(Date),
  z.null(),
]);

const conditionSchema = z.object({
  column: z.string(),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isNull', 'notNull']),
  value: cellSchema.optional(),
  valueBinding: z.object({ source: z.literal('agent-input'), field: z.string().min(1) }).optional(),
});

const conditionsSchema = z.object({
  conditions: z.array(conditionSchema).min(1),
  combine: z.enum(['and', 'or']).default('and'),
});

/** 新形式（conditions を持つ）か。z.union を使わず形で分岐し、Zod の詳細メッセージを保つ。 */
function hasConditions(config: unknown): boolean {
  return typeof config === 'object' && config !== null && Object.prototype.hasOwnProperty.call(config, 'conditions');
}

/** 設定を「条件配列 + 結合方法」へ正規化する（旧形式は1条件として扱う）。 */
function normalize(config: FilterConfig): { readonly conditions: readonly FilterCondition[]; readonly combine: FilterCombine } {
  if (hasConditions(config)) {
    const conditions = config as FilterConditionsConfig;
    return { conditions: conditions.conditions, combine: conditions.combine ?? 'and' };
  }
  return { conditions: [config as FilterCondition], combine: 'and' };
}

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

/** 1条件のスキーマ検証（列存在 / 順序演算子の列型）。 */
function conditionIssues(input: Schema, condition: FilterCondition): SchemaIssue[] {
  const col = findColumn(input, condition.column);
  if (col === undefined) {
    return [{
      severity: 'error',
      message: `filter: column not found: ${condition.column}`,
      column: condition.column,
    }];
  }
  if (ORDER_OPS.has(condition.op) && col.type !== 'number' && col.type !== 'date') {
    return [{
      severity: 'error',
      message: `filter: operator '${condition.op}' requires column type number|date, but '${condition.column}' is '${col.type}'`,
      column: condition.column,
    }];
  }
  return [];
}

/** 1行 × 1条件の判定（欠損キーは null 扱い）。 */
function matches(row: Row, condition: FilterCondition): boolean {
  const cell = Object.prototype.hasOwnProperty.call(row, condition.column)
    ? (row[condition.column] ?? null)
    : null;
  return evaluate(cell, condition.op, condition.value ?? null);
}

class FilterNode implements EtlNode<FilterConfig> {
  readonly type = 'filter';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): FilterConfig {
    // 形で分岐し、それぞれ単一スキーマで検証する（z.union だと詳細が 'Invalid input' に潰れる）。
    const schema = hasConditions(config) ? conditionsSchema : conditionSchema;
    const parsed = schema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`filter: invalid config: ${zodMessage(parsed.error)}`);
    }
    // 旧形式は旧形式のまま返す（保存済み config の形を変えない）。
    return parsed.data as FilterConfig;
  }

  inferSchema(inputs: readonly Schema[], config: FilterConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues = normalize(config).conditions.flatMap((condition) => conditionIssues(input, condition));
    if (issues.length > 0) {
      return { schema: input, state: 'mismatch', issues };
    }

    // スキーマは不変。
    return { schema: input, state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: FilterConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const { conditions, combine } = normalize(config);

    const rows: Row[] = input.rows.filter((row: Row) => combine === 'or'
      ? conditions.some((condition) => matches(row, condition))
      : conditions.every((condition) => matches(row, condition)));

    // スキーマ不変。行配列は filter が新規生成。
    return { schema: input.schema, rows };
  }
}

/** `filter` ノードのシングルトン。 */
export const filterNode: EtlNode<FilterConfig> = new FilterNode();
