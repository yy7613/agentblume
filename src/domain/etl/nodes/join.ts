/**
 * ドメイン: v15 ノード `join`（実装契約 §2.1）
 *
 * kind: transform / arity: 2（toInput 0 = 左、1 = 右）。
 * キー結合（inner / left / right / full）。
 * - inferSchema: 各キー列の存在必須（欠損 → error/mismatch）。キーペアの型不一致は
 *   error/mismatch（どちらかが unknown なら warning で許容）。出力列 = 左の全列 +
 *   右の列のうち結合キーに使った右列を除く残り。右列名が左と衝突したら
 *   `rightSuffix`（既定 '_right'）を付与し、付与後も衝突するなら error/mismatch。
 *   nullable: left → 右由来列 true / right → 左由来列 true / full → 両方 true /
 *   inner → 元のまま。正常時 state:'confirmed'。
 * - execute: ハッシュ結合。キー値が null の行はマッチしない（SQL 準拠。ただし
 *   outer 系では無マッチ行として残す）。複数マッチは直積。行順: 左行順 →
 *   (right/full) 右の無マッチ行順。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn, hasColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** 結合モード。 */
export type JoinMode = 'inner' | 'left' | 'right' | 'full';

/** 結合キーの1ペア（左列名・右列名）。 */
export interface JoinKey {
  readonly left: string;
  readonly right: string;
}

/** `join` の設定。 */
export interface JoinConfig {
  readonly mode: JoinMode;
  readonly keys: JoinKey[];
  readonly rightSuffix?: string;
}

/** 右列名の衝突時に付与する既定サフィックス。 */
const DEFAULT_RIGHT_SUFFIX = '_right';

const configSchema = z.object({
  mode: z.enum(['inner', 'left', 'right', 'full']),
  keys: z
    .array(
      z.object({
        left: z.string(),
        right: z.string(),
      }),
    )
    .min(1),
  rightSuffix: z.string().optional(),
});

/** 行からセルを取り出す（欠損キーは null 扱い）。 */
function cellOf(row: Row, name: string): Cell {
  return Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
}

/** 非null セルをハッシュキー片に変換する（型タグ付き: 1 と '1' を区別）。 */
function encodeKeyPart(value: Exclude<Cell, null>): string {
  if (value instanceof Date) return `date:${value.getTime()}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * 指定列群の複合ハッシュキーを作る。
 * いずれかのキー値が null の場合はマッチ不能として null を返す（SQL 準拠）。
 */
function keyOf(row: Row, columns: readonly string[]): string | null {
  const parts: string[] = [];
  for (const name of columns) {
    const value = cellOf(row, name);
    if (value === null) return null;
    parts.push(encodeKeyPart(value));
  }
  return JSON.stringify(parts);
}

/** inferSchema / execute で共有する出力計画。 */
interface JoinPlan {
  readonly issues: SchemaIssue[];
  /** 出力スキーマ（左の全列 + 右の非キー列を rename 済みで連結）。 */
  readonly columns: Column[];
  /** 右の非キー列名 → 出力列名。 */
  readonly rightRenames: Map<string, string>;
  /** suffix 付与後も解消できなかった衝突列名（右の元列名）。 */
  readonly conflictColumns: string[];
}

/** 左右スキーマと設定から出力列・rename・issue を計画する。 */
function planJoin(left: Schema, right: Schema, config: JoinConfig): JoinPlan {
  const issues: SchemaIssue[] = [];
  const suffix = config.rightSuffix ?? DEFAULT_RIGHT_SUFFIX;

  // キー列の存在と型の検査。
  for (const key of config.keys) {
    const l = findColumn(left, key.left);
    const r = findColumn(right, key.right);
    if (l === undefined) {
      issues.push({
        severity: 'error',
        message: `join: left key column not found: ${key.left}`,
        column: key.left,
      });
    }
    if (r === undefined) {
      issues.push({
        severity: 'error',
        message: `join: right key column not found: ${key.right}`,
        column: key.right,
      });
    }
    if (l !== undefined && r !== undefined && l.type !== r.type) {
      if (l.type === 'unknown' || r.type === 'unknown') {
        issues.push({
          severity: 'warning',
          message: `join: key type may mismatch: ${key.left} ('${l.type}') vs ${key.right} ('${r.type}')`,
          column: key.left,
        });
      } else {
        issues.push({
          severity: 'error',
          message: `join: key type mismatch: ${key.left} ('${l.type}') vs ${key.right} ('${r.type}')`,
          column: key.left,
        });
      }
    }
  }

  // nullable 規則: left → 右由来 true / right → 左由来 true / full → 両方 true。
  const leftNullable = config.mode === 'right' || config.mode === 'full';
  const rightNullable = config.mode === 'left' || config.mode === 'full';

  const columns: Column[] = left.columns.map((c) =>
    leftNullable && !c.nullable ? { name: c.name, type: c.type, nullable: true } : c,
  );
  const usedNames = new Set(columns.map((c) => c.name));
  const rightKeyNames = new Set(config.keys.map((k) => k.right));
  const rightRenames = new Map<string, string>();
  const conflictColumns: string[] = [];

  for (const c of right.columns) {
    // 結合キーに使った右列は出力から除く。
    if (rightKeyNames.has(c.name)) continue;

    const outName = usedNames.has(c.name) ? `${c.name}${suffix}` : c.name;
    if (usedNames.has(outName)) {
      issues.push({
        severity: 'error',
        message: `join: right column '${c.name}' still conflicts after suffix: ${outName}`,
        column: c.name,
      });
      conflictColumns.push(c.name);
      continue;
    }
    usedNames.add(outName);
    rightRenames.set(c.name, outName);
    columns.push({
      name: outName,
      type: c.type,
      nullable: rightNullable ? true : c.nullable,
    });
  }

  return { issues, columns, rightRenames, conflictColumns };
}

class JoinNode implements EtlNode<JoinConfig> {
  readonly type = 'join';
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 2 as const;

  validateConfig(config: unknown): JoinConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ConfigError(`join: invalid config: ${zodMessage(parsed.error)}`);
    }
    return parsed.data;
  }

  inferSchema(inputs: readonly Schema[], config: JoinConfig): SchemaInference {
    const left = inputs[0] ?? { columns: [] };
    const right = inputs[1] ?? { columns: [] };

    const plan = planJoin(left, right, config);
    const state = plan.issues.some((i) => i.severity === 'error') ? 'mismatch' : 'confirmed';
    return { schema: { columns: plan.columns }, state, issues: plan.issues };
  }

  execute(inputs: readonly Table[], config: JoinConfig): Table {
    const left = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const right = inputs[1] ?? { schema: { columns: [] }, rows: [] };

    // 欠損キー列は実行時エラー。
    const missing: string[] = [];
    for (const key of config.keys) {
      if (!hasColumn(left.schema, key.left)) missing.push(key.left);
      if (!hasColumn(right.schema, key.right)) missing.push(key.right);
    }
    if (missing.length > 0) {
      throw new SchemaError(`join: key column(s) not found: ${missing.join(', ')}`);
    }

    const plan = planJoin(left.schema, right.schema, config);
    if (plan.conflictColumns.length > 0) {
      throw new SchemaError(
        `join: column name conflict(s) after suffix: ${plan.conflictColumns.join(', ')}`,
      );
    }

    const leftNames = left.schema.columns.map((c) => c.name);
    const leftKeyCols = config.keys.map((k) => k.left);
    const rightKeyCols = config.keys.map((k) => k.right);

    // 右テーブルのハッシュ索引（null キーの行は索引に入れない = マッチしない）。
    const rightIndex = new Map<string, number[]>();
    right.rows.forEach((row, i) => {
      const key = keyOf(row, rightKeyCols);
      if (key === null) return;
      const list = rightIndex.get(key);
      if (list === undefined) rightIndex.set(key, [i]);
      else list.push(i);
    });

    const buildRow = (leftRow: Row | undefined, rightRow: Row | undefined): Row => {
      const out: Record<string, Cell> = {};
      for (const name of leftNames) {
        out[name] = leftRow === undefined ? null : cellOf(leftRow, name);
      }
      for (const [srcName, outName] of plan.rightRenames) {
        out[outName] = rightRow === undefined ? null : cellOf(rightRow, srcName);
      }
      return out;
    };

    const matchedRight = new Array<boolean>(right.rows.length).fill(false);
    const rows: Row[] = [];

    // 左行順に走査。複数マッチは直積（右の行順）。
    for (const leftRow of left.rows) {
      const key = keyOf(leftRow, leftKeyCols);
      const matches = key === null ? undefined : rightIndex.get(key);
      if (matches !== undefined && matches.length > 0) {
        for (const i of matches) {
          matchedRight[i] = true;
          rows.push(buildRow(leftRow, right.rows[i]));
        }
      } else if (config.mode === 'left' || config.mode === 'full') {
        rows.push(buildRow(leftRow, undefined));
      }
    }

    // right / full は右の無マッチ行を（右の行順で）後ろに出力。
    if (config.mode === 'right' || config.mode === 'full') {
      right.rows.forEach((rightRow, i) => {
        if (matchedRight[i] !== true) {
          rows.push(buildRow(undefined, rightRow));
        }
      });
    }

    return { schema: { columns: plan.columns }, rows };
  }
}

/** `join` ノードのシングルトン。 */
export const joinNode: EtlNode<JoinConfig> = new JoinNode();
