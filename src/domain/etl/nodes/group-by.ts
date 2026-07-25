/**
 * ドメイン: ノード `group-by`
 *
 * kind: analyze / arity: 1。
 * グループごとの集計を「横持ち」で出力する（1行 = 1グループ）。
 * summary-statistics が縦持ち（1行 = グループ×列）・数値列必須・固定メトリックなのに対し、
 * こちらは「地域別の件数」「ステータス別の合計」のような集計をそのまま1テーブルで表せる。
 *
 * - 出力スキーマ: groupBy 列（入力の型・nullable をそのまま保持）+ 各 aggregate の `as` 列。
 * - 型規則: sum/mean は数値列必須、min/max は number|date|string（比較可能）、
 *   count-distinct/first は任意型、count は列指定不要（グループの行数）。
 * - null: sum/mean/min/max は除外、count-distinct は数えない、first は先頭行の値（null でもそのまま）。
 * - inferSchema は throw せず error issue を返す（chart-output と同じ流儀）。
 *   execute は同じ検証を SchemaError として投げ直す（防御）。
 * - グループは出現順。グループ数の上限やソートは持たない（必要なら後続の sort/limit で行う）。
 */
import { z } from 'zod';
import type { Cell, Column, DataType, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';
import { cell, groupKey, groupValues, numberValue } from './analysis-utils';

/** 集計関数。 */
export const GROUP_BY_OPS = ['count', 'count-distinct', 'sum', 'mean', 'min', 'max', 'first'] as const;
export type GroupByOp = (typeof GROUP_BY_OPS)[number];

/** 集計1つ。`as` が出力列名になる。 */
export interface GroupByAggregate {
  readonly op: GroupByOp;
  /** 集計対象の入力列。`count` 以外は必須。 */
  readonly column?: string;
  readonly as: string;
}

/** `group-by` の設定。 */
export interface GroupByConfig {
  readonly groupBy: readonly string[];
  readonly aggregates: readonly GroupByAggregate[];
}

/** 対象列が必須の op（count はグループの行数なので列を要さない）。 */
const COLUMN_REQUIRED: ReadonlySet<GroupByOp> = new Set<GroupByOp>(['count-distinct', 'sum', 'mean', 'min', 'max', 'first']);
/** 数値列が必須の op。 */
const NUMERIC_OPS: ReadonlySet<GroupByOp> = new Set<GroupByOp>(['sum', 'mean']);
/** 比較可能な列型が必須の op。 */
const ORDERED_OPS: ReadonlySet<GroupByOp> = new Set<GroupByOp>(['min', 'max']);
/** min/max が許容する列型。 */
const ORDERED_TYPES: readonly DataType[] = ['number', 'date', 'string'];

const configSchema = z.object({
  groupBy: z.array(z.string().min(1)).min(1),
  aggregates: z
    .array(
      z.object({
        op: z.enum(GROUP_BY_OPS),
        column: z.string().min(1).optional(),
        as: z.string().min(1),
      }),
    )
    .min(1),
});

/** 順序を保ったまま重複を除く。 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * inferSchema / execute が共有する検証。返るのは error issue の配列（空なら妥当）。
 *
 * メッセージは既存ノードの定型文に合わせる（列不存在は `column(s) not found`、
 * 数値列違反は `column(s) must be number`、生成列衝突は summary-statistics と同形）。
 */
function validationIssues(input: Schema, config: GroupByConfig): SchemaIssue[] {
  const missing: string[] = [];
  const nonNumeric: string[] = [];
  const issues: SchemaIssue[] = [];
  const names = new Set<string>();
  const groups = new Set(config.groupBy);

  for (const name of config.groupBy) {
    if (findColumn(input, name) === undefined) missing.push(name);
  }

  for (const aggregate of config.aggregates) {
    if (names.has(aggregate.as)) {
      issues.push({ severity: 'error', message: `group-by: duplicate aggregate name: ${aggregate.as}`, column: aggregate.as });
    }
    names.add(aggregate.as);
    if (groups.has(aggregate.as)) {
      issues.push({ severity: 'error', message: `group-by: input column '${aggregate.as}' conflicts with generated column`, column: aggregate.as });
    }

    if (aggregate.column === undefined) {
      if (COLUMN_REQUIRED.has(aggregate.op)) {
        issues.push({
          severity: 'error',
          message: `group-by: aggregate '${aggregate.as}' requires a column for op '${aggregate.op}'`,
          column: aggregate.as,
        });
      }
      continue;
    }

    const column = findColumn(input, aggregate.column);
    if (column === undefined) {
      missing.push(aggregate.column);
      continue;
    }
    if (NUMERIC_OPS.has(aggregate.op) && column.type !== 'number') nonNumeric.push(aggregate.column);
    if (ORDERED_OPS.has(aggregate.op) && !ORDERED_TYPES.includes(column.type)) {
      issues.push({
        severity: 'error',
        message: `group-by: column '${aggregate.column}' must be ${ORDERED_TYPES.join(' or ')}`,
        column: aggregate.column,
      });
    }
  }

  const head: SchemaIssue[] = [];
  if (missing.length > 0) {
    head.push({ severity: 'error', message: `group-by: column(s) not found: ${unique(missing).join(', ')}` });
  }
  if (nonNumeric.length > 0) {
    head.push({ severity: 'error', message: `group-by: column(s) must be number: ${unique(nonNumeric).join(', ')}` });
  }
  return [...head, ...issues];
}

/** 集計結果の列。count系/sum は非null、mean は null 許容、min/max/first は入力列の型。 */
function aggregateColumn(input: Schema, aggregate: GroupByAggregate): Column {
  if (aggregate.op === 'count' || aggregate.op === 'count-distinct' || aggregate.op === 'sum') {
    return { name: aggregate.as, type: 'number', nullable: false };
  }
  if (aggregate.op === 'mean') return { name: aggregate.as, type: 'number', nullable: true };
  // min/max/first は column 必須（検証済み）なので入力列の型を引き継ぐ。
  return { name: aggregate.as, type: findColumn(input, aggregate.column as string)!.type, nullable: true };
}

/** 出力スキーマ（groupBy 列 → aggregate 列の順）。検証済みの config でのみ呼ぶ。 */
function outputSchema(input: Schema, config: GroupByConfig): Schema {
  return {
    columns: [
      ...unique(config.groupBy).map((name) => findColumn(input, name) as Column),
      ...config.aggregates.map((aggregate) => aggregateColumn(input, aggregate)),
    ],
  };
}

/** count-distinct 用の値キー（型込み。Date は時刻値で同一視する）。 */
function distinctKey(value: Exclude<Cell, null>): string {
  return value instanceof Date ? `date:${value.getTime()}` : `${typeof value}:${String(value)}`;
}

/** 大小比較（NaN 安全のため差分ではなく大小比較を使う）。 */
function order(a: number | string, b: number | string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** min/max 用のセル比較。同型は型ごとの規則、型混在は String 化して比較する。 */
function compareCells(a: Exclude<Cell, null>, b: Exclude<Cell, null>): number {
  if (typeof a === 'number' && typeof b === 'number') return order(a, b);
  if (a instanceof Date && b instanceof Date) return order(a.getTime(), b.getTime());
  if (typeof a === 'string' && typeof b === 'string') return order(a, b);
  return order(String(a), String(b));
}

/** 1グループ分の行と、`first` 用の先頭行。 */
interface Group {
  /** groupBy 列の値（出力行の前半になる）。 */
  readonly values: Row;
  readonly first: Row;
  readonly rows: Row[];
}

/** 1グループ・1集計の値。 */
function aggregateValue(group: Group, aggregate: GroupByAggregate): Cell {
  if (aggregate.op === 'count') return group.rows.length;
  const column = aggregate.column as string;

  if (aggregate.op === 'first') return cell(group.first, column);

  if (aggregate.op === 'count-distinct') {
    const seen = new Set<string>();
    for (const row of group.rows) {
      const value = cell(row, column);
      if (value !== null) seen.add(distinctKey(value));
    }
    return seen.size;
  }

  if (aggregate.op === 'sum' || aggregate.op === 'mean') {
    let sum = 0;
    let count = 0;
    for (const row of group.rows) {
      const value = numberValue(row, column);
      if (value !== undefined) {
        sum += value;
        count += 1;
      }
    }
    if (aggregate.op === 'sum') return sum;
    // null 除外後に0件なら平均は決まらない。
    return count === 0 ? null : sum / count;
  }

  // min / max: null を除いた1パス比較（スプレッドの Math.min は大きな配列でスタックを溢れさせる）。
  let best: Cell = null;
  for (const row of group.rows) {
    const value = cell(row, column);
    if (value === null) continue;
    if (best === null) {
      best = value;
      continue;
    }
    const comparison = compareCells(value, best);
    if (aggregate.op === 'min' ? comparison < 0 : comparison > 0) best = value;
  }
  return best;
}

class GroupByNode implements EtlNode<GroupByConfig> {
  readonly type = 'group-by';
  readonly kind: NodeKind = 'analyze';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): GroupByConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`group-by: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: GroupByConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues = validationIssues(input, config);
    return issues.length > 0
      ? { schema: input, state: 'mismatch', issues }
      : { schema: outputSchema(input, config), state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: GroupByConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const issue = validationIssues(input.schema, config)[0];
    if (issue !== undefined) throw new SchemaError(issue.message);

    const keys = unique(config.groupBy);
    const groups = new Map<string, Group>();
    for (const row of input.rows) {
      const key = groupKey(row, keys);
      const current = groups.get(key);
      if (current === undefined) groups.set(key, { values: groupValues(row, keys), first: row, rows: [row] });
      else current.rows.push(row);
    }

    // 1行=1グループ（出現順）。入力行は mutate しない。
    const rows: Row[] = [];
    for (const group of groups.values()) {
      const row: Record<string, Cell> = { ...group.values };
      for (const aggregate of config.aggregates) row[aggregate.as] = aggregateValue(group, aggregate);
      rows.push(row);
    }

    return { schema: outputSchema(input.schema, config), rows };
  }
}

/** `group-by` ノードのシングルトン。 */
export const groupByNode: EtlNode<GroupByConfig> = new GroupByNode();
