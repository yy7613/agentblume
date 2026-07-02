/**
 * ドメイン: v1 ノード `select`（実装契約 §9.3）
 *
 * kind: transform / arity: 1。
 * 入力から指定列だけを（要求順に）射影する。
 * - inferSchema: 各要求列が入力に存在するか検査。欠損 → error issue（column付き）、
 *   state:'mismatch'、schema は存在する列のみ。全存在 → 要求順の列で state:'confirmed'。
 * - execute: 各行を要求列だけに射影（欠損列があれば SchemaError）。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** `select` の設定。 */
export interface SelectConfig {
  readonly columns: string[];
}

const configSchema = z.object({
  columns: z.array(z.string()),
});

class SelectNode implements EtlNode<SelectConfig> {
  readonly type = 'select';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): SelectConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`select: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: SelectConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [];
    const selected: Column[] = [];

    for (const name of config.columns) {
      const col = findColumn(input, name);
      if (col === undefined) {
        issues.push({
          severity: 'error',
          message: `select: column not found: ${name}`,
          column: name,
        });
        continue;
      }
      selected.push(col);
    }

    const state = issues.length > 0 ? 'mismatch' : 'confirmed';
    return { schema: { columns: selected }, state, issues };
  }

  execute(inputs: readonly Table[], config: SelectConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // 欠損列は実行時エラー（SchemaError）。
    const missing = config.columns.filter((name) => findColumn(input.schema, name) === undefined);
    if (missing.length > 0) {
      throw new SchemaError(`select: column(s) not found: ${missing.join(', ')}`);
    }

    const columns: Column[] = config.columns.map((name) => {
      // 上の検査で存在は保証済み。
      const col = findColumn(input.schema, name);
      // 型安全のためのフォールバック（実際には到達しない）。
      return col ?? { name, type: 'unknown', nullable: true };
    });

    const rows: Row[] = input.rows.map((row) => {
      const out: Record<string, Cell> = {};
      for (const name of config.columns) {
        out[name] = Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
      }
      return out;
    });

    return { schema: { columns }, rows };
  }
}

/** `select` ノードのシングルトン。 */
export const selectNode: EtlNode<SelectConfig> = new SelectNode();
