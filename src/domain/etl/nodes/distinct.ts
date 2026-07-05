/**
 * ドメイン: v15 ノード `distinct`（実装契約 §2.4）
 *
 * kind: transform / arity: 1。
 * 重複行の排除。スキーマは不変。
 * - inferSchema: 指定列の存在必須（欠損 → error/mismatch）。正常時 'confirmed'。
 * - execute: 対象列（省略/空 = 全列）の値タプルをキー化（JSON.stringify。
 *   Date は ISO 化、null は専用トークン、型タグ付きで 1 と '1' を区別）して
 *   重複判定し、最初の行を保持。行順維持。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** `distinct` の設定。columns 省略/空 = 全列で重複判定。 */
export interface DistinctConfig {
  readonly columns?: string[];
}

const configSchema = z.object({
  columns: z.array(z.string()).optional(),
});

/** 行からセルを取り出す（欠損キーは null 扱い）。 */
function cellOf(row: Row, name: string): Cell {
  return Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
}

/** 1セルを重複判定用トークンに変換する（null は専用トークン、Date は ISO 化）。 */
function encodeCell(value: Cell): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    // Invalid Date は toISOString が例外を投げるため getTime で退避。
    return Number.isNaN(value.getTime()) ? 'date:invalid' : `date:${value.toISOString()}`;
  }
  return `${typeof value}:${String(value)}`;
}

class DistinctNode implements EtlNode<DistinctConfig> {
  readonly type = 'distinct';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): DistinctConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`distinct: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: DistinctConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [];

    for (const name of config.columns ?? []) {
      if (findColumn(input, name) === undefined) {
        issues.push({
          severity: 'error',
          message: `distinct: column not found: ${name}`,
          column: name,
        });
      }
    }
    if (issues.length > 0) {
      return { schema: input, state: 'mismatch', issues };
    }

    // スキーマは不変。
    return { schema: input, state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: DistinctConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // 欠損列は実行時エラー。
    const missing = (config.columns ?? []).filter(
      (name) => findColumn(input.schema, name) === undefined,
    );
    if (missing.length > 0) {
      throw new SchemaError(`distinct: column(s) not found: ${missing.join(', ')}`);
    }

    // 省略/空 = 全列。
    const targets =
      config.columns !== undefined && config.columns.length > 0
        ? config.columns
        : input.schema.columns.map((c) => c.name);

    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const row of input.rows) {
      const key = JSON.stringify(targets.map((name) => encodeCell(cellOf(row, name))));
      if (seen.has(key)) continue;
      seen.add(key);
      // 最初の行を保持（行順維持）。
      rows.push(row);
    }

    // スキーマ不変。行配列は新規生成。
    return { schema: input.schema, rows };
  }
}

/** `distinct` ノードのシングルトン。 */
export const distinctNode: EtlNode<DistinctConfig> = new DistinctNode();
