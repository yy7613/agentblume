/**
 * ドメイン: v15 ノード `union`（実装契約 §2.2）
 *
 * kind: transform / arity: 2（toInput 0 = 上、1 = 下）。
 * 列名ベースの縦結合。
 * - inferSchema:
 *   - strict:true（既定 false）: 列名集合が完全一致しない → error/mismatch。
 *     列順は左（input0）に合わせる。
 *   - strict:false: 列 = 左の列順 → 右にしかない列を初出順で後ろに。片側にしか
 *     ない列は nullable:true。共通列の型は unifyTypes（異種 → unknown + warning）。
 *   - 正常時 state:'confirmed'。
 * - execute: input0 の全行 → input1 の全行。欠損列は null。重複排除はしない。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn, unifyTypes } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** `union` の設定。 */
export interface UnionConfig {
  readonly strict?: boolean;
}

const configSchema = z.object({
  strict: z.boolean().optional(),
});

/** 行からセルを取り出す（欠損キーは null 扱い）。 */
function cellOf(row: Row, name: string): Cell {
  return Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
}

/** inferSchema / execute で共有する出力計画。 */
interface UnionPlan {
  readonly issues: SchemaIssue[];
  readonly columns: Column[];
  /** strict:true で列名集合が一致しなかったら true。 */
  readonly strictViolation: boolean;
}

/** 上下スキーマと strict 指定から出力列・issue を計画する。 */
function planUnion(a: Schema, b: Schema, strict: boolean): UnionPlan {
  const issues: SchemaIssue[] = [];
  const aNames = new Set(a.columns.map((c) => c.name));
  const bNames = new Set(b.columns.map((c) => c.name));
  let strictViolation = false;

  if (strict) {
    for (const c of a.columns) {
      if (!bNames.has(c.name)) {
        issues.push({
          severity: 'error',
          message: `union: column exists only in input 0: ${c.name}`,
          column: c.name,
        });
        strictViolation = true;
      }
    }
    for (const c of b.columns) {
      if (!aNames.has(c.name)) {
        issues.push({
          severity: 'error',
          message: `union: column exists only in input 1: ${c.name}`,
          column: c.name,
        });
        strictViolation = true;
      }
    }
  }

  // 左（input0）の列順を基準にする。
  const columns: Column[] = [];
  for (const c of a.columns) {
    const other = findColumn(b, c.name);
    if (other === undefined) {
      // 片側にしかない列 → nullable:true（右由来の行では null になる）。
      columns.push({ name: c.name, type: c.type, nullable: true });
      continue;
    }
    const type = unifyTypes(c.type, other.type);
    if (c.type !== other.type) {
      issues.push({
        severity: 'warning',
        message: `union: column '${c.name}' has mixed types: '${c.type}' vs '${other.type}' -> '${type}'`,
        column: c.name,
      });
    }
    columns.push({ name: c.name, type, nullable: c.nullable || other.nullable });
  }

  // 右にしかない列を初出順で後ろに（strict:true では error 済みなので追加しない）。
  if (!strict) {
    for (const c of b.columns) {
      if (!aNames.has(c.name)) {
        columns.push({ name: c.name, type: c.type, nullable: true });
      }
    }
  }

  return { issues, columns, strictViolation };
}

class UnionNode implements EtlNode<UnionConfig> {
  readonly type = 'union';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 2 as const;

  validateConfig(config: unknown): UnionConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`union: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: UnionConfig): SchemaInference {
    const a = inputs[0] ?? { columns: [] };
    const b = inputs[1] ?? { columns: [] };

    const plan = planUnion(a, b, config.strict ?? false);
    const state = plan.issues.some((i) => i.severity === 'error') ? 'mismatch' : 'confirmed';
    return { schema: { columns: plan.columns }, state, issues: plan.issues };
  }

  execute(inputs: readonly Table[], config: UnionConfig): Table {
    const a = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const b = inputs[1] ?? { schema: { columns: [] }, rows: [] };
    const strict = config.strict ?? false;

    const plan = planUnion(a.schema, b.schema, strict);
    if (plan.strictViolation) {
      const names = plan.issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.column)
        .join(', ');
      throw new SchemaError(`union: strict mode requires identical column sets, mismatched: ${names}`);
    }

    const names = plan.columns.map((c) => c.name);
    const project = (row: Row): Row => {
      const out: Record<string, Cell> = {};
      for (const name of names) {
        out[name] = cellOf(row, name);
      }
      return out;
    };

    // input0 の全行 → input1 の全行（重複排除はしない）。
    const rows: Row[] = [...a.rows.map(project), ...b.rows.map(project)];

    return { schema: { columns: plan.columns }, rows };
  }
}

/** `union` ノードのシングルトン。 */
export const unionNode: EtlNode<UnionConfig> = new UnionNode();
