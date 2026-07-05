/**
 * ドメイン: v15 ノード `fill-null`（実装契約 §2.5）
 *
 * kind: transform / arity: 1。
 * null の穴埋め（constant）または当該行の削除（drop-row）。
 * - config検証: strategy:'constant' なのに value 未指定（undefined）→ ConfigError。
 *   value: null も不可（ConfigError）。
 * - inferSchema: 各 `column` 存在必須（欠損 → error/mismatch）。対象列は
 *   nullable:false に更新。constant の value 型が列型と不一致（列型が
 *   unknown/null 以外で異なる）→ warning（型は unifyTypes 結果に）。正常時 'confirmed'。
 * - execute: ルール順に適用。constant: 当該列の null を value へ。
 *   drop-row: 当該列が null の行を除去。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn, inferCellType, unifyTypes } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** null 処理戦略。 */
export type FillStrategy = 'constant' | 'drop-row';

/** null 処理の1ルール。 */
export interface FillRule {
  readonly column: string;
  readonly strategy: FillStrategy;
  readonly value?: Cell;
}

/** `fill-null` の設定。 */
export interface FillNullConfig {
  readonly rules: FillRule[];
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
        strategy: z.enum(['constant', 'drop-row']),
        value: cellSchema.optional(),
      }),
    )
    .min(1),
});

/** inferSchema / execute で共有する出力スキーマ計画。 */
interface FillNullPlan {
  readonly issues: SchemaIssue[];
  readonly columns: Column[];
}

/** 入力スキーマとルールから出力列・warning を計画する（列は存在済み前提）。 */
function planFillNull(input: Schema, config: FillNullConfig): FillNullPlan {
  const issues: SchemaIssue[] = [];
  const columns: Column[] = [...input.columns];

  // ルール順に適用（同一列への複数ルールは順に反映）。
  for (const rule of config.rules) {
    const idx = columns.findIndex((c) => c.name === rule.column);
    const col = columns[idx];
    if (col === undefined) continue;

    let type = col.type;
    if (rule.strategy === 'constant') {
      const valueType = inferCellType(rule.value ?? null);
      if (col.type !== 'unknown' && col.type !== 'null' && valueType !== col.type) {
        type = unifyTypes(col.type, valueType);
        issues.push({
          severity: 'warning',
          message: `fill-null: value type '${valueType}' differs from column '${rule.column}' type '${col.type}' -> '${type}'`,
          column: rule.column,
        });
      }
    }
    // constant / drop-row のいずれも当該列は nullable:false になる。
    columns[idx] = { name: col.name, type, nullable: false };
  }

  return { issues, columns };
}

class FillNullNode implements EtlNode<FillNullConfig> {
  readonly type = 'fill-null';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): FillNullConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`fill-null: invalid config: ${zodMessage(parsed.error)}`);
    }
    // strategy:'constant' は非null の value 必須。
    for (const rule of parsed.data.rules) {
      if (rule.strategy === 'constant' && rule.value === undefined) {
        throw new ConfigError(
          `fill-null: rule for column '${rule.column}' requires 'value' for strategy 'constant'`,
        );
      }
      if (rule.strategy === 'constant' && rule.value === null) {
        throw new ConfigError(
          `fill-null: rule for column '${rule.column}' must not use null as 'value'`,
        );
      }
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: FillNullConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };

    // 欠損列 → error/mismatch。
    const missingIssues: SchemaIssue[] = [];
    for (const rule of config.rules) {
      if (findColumn(input, rule.column) === undefined) {
        missingIssues.push({
          severity: 'error',
          message: `fill-null: column not found: ${rule.column}`,
          column: rule.column,
        });
      }
    }
    if (missingIssues.length > 0) {
      return { schema: input, state: 'mismatch', issues: missingIssues };
    }

    const plan = planFillNull(input, config);
    return { schema: { columns: plan.columns }, state: 'confirmed', issues: plan.issues };
  }

  execute(inputs: readonly Table[], config: FillNullConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // 欠損列は実行時エラー。
    const missing = config.rules
      .filter((rule) => findColumn(input.schema, rule.column) === undefined)
      .map((rule) => rule.column);
    if (missing.length > 0) {
      throw new SchemaError(`fill-null: column(s) not found: ${missing.join(', ')}`);
    }

    // ルール順に適用（入力は mutate しない）。
    let rows: readonly Row[] = input.rows;
    for (const rule of config.rules) {
      if (rule.strategy === 'constant') {
        const value = rule.value ?? null;
        rows = rows.map((row) => {
          const cell = Object.prototype.hasOwnProperty.call(row, rule.column)
            ? (row[rule.column] ?? null)
            : null;
          if (cell !== null) return row;
          return { ...row, [rule.column]: value };
        });
      } else {
        rows = rows.filter((row) => {
          const cell = Object.prototype.hasOwnProperty.call(row, rule.column)
            ? (row[rule.column] ?? null)
            : null;
          return cell !== null;
        });
      }
    }

    const plan = planFillNull(input.schema, config);
    return { schema: { columns: plan.columns }, rows: [...rows] };
  }
}

/** `fill-null` ノードのシングルトン。 */
export const fillNullNode: EtlNode<FillNullConfig> = new FillNullNode();
