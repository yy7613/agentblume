/**
 * ドメイン: v1 ノード `cast`（実装契約 §9.6）
 *
 * kind: transform / arity: 1。
 * 指定列の型を変換する。
 * - inferSchema: 各 `column` 存在必須（欠損 → error/mismatch）。出力スキーマは対象列の
 *   `type` を `to` に変更、`nullable` は変換失敗の可能性から true。state:'confirmed'。
 *   サポート外の変換ペアは warning issue（state は維持）。
 * - execute: 各対象セルを変換。変換不能 → null。
 */
import { z } from 'zod';
import type { Cell, Column, DataType, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** cast 先として許可する型。 */
type CastTargetType = 'string' | 'number' | 'boolean' | 'date';

/** `cast` の設定。 */
export interface CastConfig {
  readonly casts: { column: string; to: CastTargetType }[];
}

const configSchema = z.object({
  casts: z.array(
    z.object({
      column: z.string(),
      to: z.enum(['string', 'number', 'boolean', 'date']),
    }),
  ),
});

/**
 * ソース型（列の宣言型）→ 変換先が「サポート済み」かを判定する。
 * サポート外でも実行は試みる（多くは null になる）が、warning issue を出す。
 * `unknown`/`null` ソースは実データ次第なのでサポート扱い（警告しない）。
 */
function isSupportedCast(from: DataType, to: CastTargetType): boolean {
  if (from === to) return true;
  if (from === 'unknown' || from === 'null') return true;
  switch (from) {
    case 'string':
      return to === 'number' || to === 'boolean' || to === 'date';
    case 'number':
      return to === 'string' || to === 'boolean';
    case 'boolean':
      return to === 'string';
    case 'date':
      return to === 'string';
    default:
      return false;
  }
}

/** 1セルを目標型に変換する。変換不能 → null。 */
function castCell(value: Cell, to: CastTargetType): Cell {
  if (value === null) return null;

  switch (to) {
    case 'string':
      return castToString(value);
    case 'number':
      return castToNumber(value);
    case 'boolean':
      return castToBoolean(value);
    case 'date':
      return castToDate(value);
    default:
      return null;
  }
}

function castToString(value: Cell): Cell {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return null;
}

function castToNumber(value: Cell): Cell {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function castToBoolean(value: Cell): Cell {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return null;
  }
  return null;
}

function castToDate(value: Cell): Cell {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

class CastNode implements EtlNode<CastConfig> {
  readonly type = 'cast';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): CastConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`cast: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: CastConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [];

    // 欠損列 → error/mismatch。
    const missingIssues: SchemaIssue[] = [];
    for (const cast of config.casts) {
      if (findColumn(input, cast.column) === undefined) {
        missingIssues.push({
          severity: 'error',
          message: `cast: column not found: ${cast.column}`,
          column: cast.column,
        });
      }
    }
    if (missingIssues.length > 0) {
      return { schema: input, state: 'mismatch', issues: missingIssues };
    }

    // to のマップ（同一列に複数 cast があれば最後が勝つ）。
    const toMap = new Map<string, CastTargetType>();
    for (const cast of config.casts) {
      toMap.set(cast.column, cast.to);
    }

    // サポート外変換 → warning（state は維持）。
    for (const cast of config.casts) {
      const col = findColumn(input, cast.column);
      if (col !== undefined && !isSupportedCast(col.type, cast.to)) {
        issues.push({
          severity: 'warning',
          message: `cast: unsupported cast from '${col.type}' to '${cast.to}' for column '${cast.column}'`,
          column: cast.column,
        });
      }
    }

    const columns: Column[] = input.columns.map((c) => {
      const to = toMap.get(c.name);
      if (to === undefined) return c;
      // 変換失敗の可能性があるため nullable:true。
      return { name: c.name, type: to, nullable: true };
    });

    return { schema: { columns }, state: 'confirmed', issues };
  }

  execute(inputs: readonly Table[], config: CastConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };

    // 欠損列は実行時エラー。
    const missing = config.casts
      .filter((cast) => findColumn(input.schema, cast.column) === undefined)
      .map((cast) => cast.column);
    if (missing.length > 0) {
      throw new SchemaError(`cast: column(s) not found: ${missing.join(', ')}`);
    }

    const toMap = new Map<string, CastTargetType>();
    for (const cast of config.casts) {
      toMap.set(cast.column, cast.to);
    }

    const columns: Column[] = input.schema.columns.map((c) => {
      const to = toMap.get(c.name);
      if (to === undefined) return c;
      return { name: c.name, type: to, nullable: true };
    });

    const rows: Row[] = input.rows.map((row) => {
      const out: Record<string, Cell> = {};
      for (const key of Object.keys(row)) {
        const to = toMap.get(key);
        const value = row[key] ?? null;
        out[key] = to === undefined ? value : castCell(value, to);
      }
      return out;
    });

    return { schema: { columns }, rows };
  }
}

/** `cast` ノードのシングルトン。 */
export const castNode: EtlNode<CastConfig> = new CastNode();
