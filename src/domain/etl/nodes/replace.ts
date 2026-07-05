/**
 * ドメイン: v15 ノード `replace`（実装契約 §2.6）
 *
 * kind: transform / arity: 1。
 * 値の厳密等価置換。
 * - inferSchema: 各 `column` 存在必須（欠損 → error/mismatch）。`to` の型が列型と
 *   異なる場合は列型を `unifyTypes(列型, toの型)` に更新し warning。
 *   `from:null → to:x` は null 置換として許容（nullable は他ルールに依らず維持:
 *   fill-null の責務と分ける）。正常時 'confirmed'。
 * - execute: ルール順に適用。厳密等価（Date は getTime() 比較、null は null と一致）
 *   で `from` に一致したセルを `to` へ。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn, inferCellType, unifyTypes } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** 置換の1ルール。 */
export interface ReplaceRule {
  readonly column: string;
  readonly from: Cell;
  readonly to: Cell;
}

/** `replace` の設定。 */
export interface ReplaceConfig {
  readonly rules: ReplaceRule[];
}

const cellSchema: z.ZodType<Cell> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.instanceof(Date),
  z.null(),
]);

const configSchema = z.object({
  rules: z
    .array(
      z.object({
        column: z.string(),
        from: cellSchema,
        to: cellSchema,
      }),
    )
    .min(1),
});

/** 行からセルを取り出す（欠損キーは null 扱い）。 */
function cellOf(row: Row, name: string): Cell {
  return Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
}

/** 厳密等価（Date は時刻値で比較、null は null とのみ一致）。 */
function cellEquals(a: Cell, b: Cell): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  // 片方だけ Date のときは非等価（型が異なる）。
  if (a instanceof Date || b instanceof Date) return false;
  return a === b;
}

/** inferSchema / execute で共有する出力スキーマ計画。 */
interface ReplacePlan {
  readonly issues: SchemaIssue[];
  readonly columns: Column[];
}

/** 入力スキーマとルールから出力列・warning を計画する（列は存在済み前提）。 */
function planReplace(input: Schema, config: ReplaceConfig): ReplacePlan {
  const issues: SchemaIssue[] = [];
  const columns: Column[] = [...input.columns];

  // ルール順に適用（同一列への複数ルールは順に反映）。
  for (const rule of config.rules) {
    const idx = columns.findIndex((c) => c.name === rule.column);
    const col = columns[idx];
    if (col === undefined) continue;

    const toType = inferCellType(rule.to);
    if (toType !== col.type) {
      const type = unifyTypes(col.type, toType);
      issues.push({
        severity: 'warning',
        message: `replace: 'to' type '${toType}' differs from column '${rule.column}' type '${col.type}' -> '${type}'`,
        column: rule.column,
      });
      // nullable は維持（null の増減は fill-null の責務と分ける）。
      columns[idx] = { name: col.name, type, nullable: col.nullable };
    }
  }

  return { issues, columns };
}

class ReplaceNode implements EtlNode<ReplaceConfig> {
  readonly type = 'replace';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): ReplaceConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`replace: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: ReplaceConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };

    // 欠損列 → error/mismatch。
    const missingIssues: SchemaIssue[] = [];
    for (const rule of config.rules) {
      if (findColumn(input, rule.column) === undefined) {
        missingIssues.push({
          severity: 'error',
          message: `replace: column not found: ${rule.column}`,
          column: rule.column,
        });
      }
    }
    if (missingIssues.length > 0) {
      return { schema: input, state: 'mismatch', issues: missingIssues };
    }

    const plan = planReplace(input, config);
    return { schema: { columns: plan.columns }, state: 'confirmed', issues: plan.issues };
  }

  execute(inputs: readonly Table[], config: ReplaceConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // 欠損列は実行時エラー。
    const missing = config.rules
      .filter((rule) => findColumn(input.schema, rule.column) === undefined)
      .map((rule) => rule.column);
    if (missing.length > 0) {
      throw new SchemaError(`replace: column(s) not found: ${missing.join(', ')}`);
    }

    // ルール順に適用（入力は mutate しない）。
    let rows: readonly Row[] = input.rows;
    for (const rule of config.rules) {
      rows = rows.map((row) => {
        const cell = cellOf(row, rule.column);
        if (!cellEquals(cell, rule.from)) return row;
        return { ...row, [rule.column]: rule.to };
      });
    }

    const plan = planReplace(input.schema, config);
    return { schema: { columns: plan.columns }, rows: [...rows] };
  }
}

/** `replace` ノードのシングルトン。 */
export const replaceNode: EtlNode<ReplaceConfig> = new ReplaceNode();
