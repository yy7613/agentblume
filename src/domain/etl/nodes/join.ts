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
 *   キーペアの型不一致は inferSchema と同条件で `SchemaError`（型検査なしだと
 *   型タグ付きキーで無言の0行になる）。出力行数が `MAX_JOIN_ROWS` を超えたら
 *   その時点で打ち切って `SchemaError`（キー誤りによる直積の暴走を防ぐ）。
 * - `coerceKeys: 'string'` を指定すると型タグを外し、キーを文字列として比較する
 *   （CSV のゼロ埋め ID が number に推論された `1` と JSON の `'1'` を結合できる）。
 */
import { z } from 'zod';
import type { Cell, Column, DataType, Row, Schema, Table } from '../../data/types';
import { findColumn, hasColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** 結合モード。 */
export type JoinMode = 'inner' | 'left' | 'right' | 'full';

/** 結合キーの比較方法。'string' は型を無視して文字列として比較する。 */
export type JoinCoerceKeys = 'none' | 'string';

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
  /** 既定 'none'（型タグ付きの厳密比較）。'string' は文字列化して比較する。 */
  readonly coerceKeys?: JoinCoerceKeys;
}

/** 右列名の衝突時に付与する既定サフィックス。 */
const DEFAULT_RIGHT_SUFFIX = '_right';

/**
 * 出力行数の上限。キー誤りによる直積（例: 2000×2000）でメモリが枯渇するのを防ぐ。
 * 超えた時点で打ち切り、`SchemaError` を投げる。
 */
export const MAX_JOIN_ROWS = 100_000;

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
  // 既存の保存済み Tool（coerceKeys なし）をそのまま読めるよう optional のままにする。
  coerceKeys: z.enum(['none', 'string']).optional(),
});

/** 行からセルを取り出す（欠損キーは null 扱い）。 */
function cellOf(row: Row, name: string): Cell {
  return Object.prototype.hasOwnProperty.call(row, name) ? (row[name] ?? null) : null;
}

/**
 * 非null セルをハッシュキー片に変換する。
 * - 'none': 型タグ付き（1 と '1' を区別）。
 * - 'string': 型タグなしの文字列（1 と '1' が一致。Date は ISO 文字列）。
 */
function encodeKeyPart(value: Exclude<Cell, null>, coerce: JoinCoerceKeys): string {
  if (coerce === 'string') return value instanceof Date ? value.toISOString() : String(value);
  if (value instanceof Date) return `date:${value.getTime()}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * 指定列群の複合ハッシュキーを作る。
 * いずれかのキー値が null の場合はマッチ不能として null を返す（SQL 準拠）。
 */
function keyOf(row: Row, columns: readonly string[], coerce: JoinCoerceKeys): string | null {
  const parts: string[] = [];
  for (const name of columns) {
    const value = cellOf(row, name);
    if (value === null) return null;
    parts.push(encodeKeyPart(value, coerce));
  }
  return JSON.stringify(parts);
}

/** issue / エラー文面で共有するキーペアの型ラベル。 */
function keyTypeLabel(key: JoinKey, leftType: DataType, rightType: DataType): string {
  return `${key.left} ('${leftType}') vs ${key.right} ('${rightType}')`;
}

/**
 * execute 用のキー型検査（inferSchema が error にするのと同一条件・同一文面）。
 * unknown が絡む場合と coerceKeys:'string' の場合は許容する。
 */
function requireKeyTypes(left: Schema, right: Schema, config: JoinConfig): void {
  if (config.coerceKeys === 'string') return;
  for (const key of config.keys) {
    const l = findColumn(left, key.left);
    const r = findColumn(right, key.right);
    if (l === undefined || r === undefined) continue;
    if (l.type === r.type || l.type === 'unknown' || r.type === 'unknown') continue;
    throw new SchemaError(`join: key type mismatch: ${keyTypeLabel(key, l.type, r.type)}`);
  }
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
      const label = keyTypeLabel(key, l.type, r.type);
      if (l.type === 'unknown' || r.type === 'unknown') {
        issues.push({
          severity: 'warning',
          message: `join: key type may mismatch: ${label}`,
          column: key.left,
        });
      } else if (config.coerceKeys === 'string') {
        // 文字列比較なら型差はエラーにしない（'1' と 1 は一致する）。
        issues.push({
          severity: 'warning',
          message: `join: keys compared as text: ${label}`,
          column: key.left,
        });
      } else {
        issues.push({
          severity: 'error',
          message: `join: key type mismatch: ${label}`,
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

    // 型不一致は無言の0行になるため実行時にも弾く（inferSchema と同条件）。
    requireKeyTypes(left.schema, right.schema, config);

    const plan = planJoin(left.schema, right.schema, config);
    if (plan.conflictColumns.length > 0) {
      throw new SchemaError(
        `join: column name conflict(s) after suffix: ${plan.conflictColumns.join(', ')}`,
      );
    }

    const leftNames = left.schema.columns.map((c) => c.name);
    const leftKeyCols = config.keys.map((k) => k.left);
    const rightKeyCols = config.keys.map((k) => k.right);
    const coerce: JoinCoerceKeys = config.coerceKeys ?? 'none';

    // 右テーブルのハッシュ索引（null キーの行は索引に入れない = マッチしない）。
    const rightIndex = new Map<string, number[]>();
    right.rows.forEach((row, i) => {
      const key = keyOf(row, rightKeyCols, coerce);
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

    // 上限超過をインクリメンタルに検出する（全 materialize してから数えない）。
    const pushRow = (leftRow: Row | undefined, rightRow: Row | undefined): void => {
      if (rows.length >= MAX_JOIN_ROWS) {
        throw new SchemaError(`join: output exceeded ${MAX_JOIN_ROWS} rows; check join keys`);
      }
      rows.push(buildRow(leftRow, rightRow));
    };

    // 左行順に走査。複数マッチは直積（右の行順）。
    for (const leftRow of left.rows) {
      const key = keyOf(leftRow, leftKeyCols, coerce);
      const matches = key === null ? undefined : rightIndex.get(key);
      if (matches !== undefined && matches.length > 0) {
        for (const i of matches) {
          matchedRight[i] = true;
          pushRow(leftRow, right.rows[i]);
        }
      } else if (config.mode === 'left' || config.mode === 'full') {
        pushRow(leftRow, undefined);
      }
    }

    // right / full は右の無マッチ行を（右の行順で）後ろに出力。
    if (config.mode === 'right' || config.mode === 'full') {
      right.rows.forEach((rightRow, i) => {
        if (matchedRight[i] !== true) {
          pushRow(undefined, rightRow);
        }
      });
    }

    return { schema: { columns: plan.columns }, rows };
  }
}

/** `join` ノードのシングルトン。 */
export const joinNode: EtlNode<JoinConfig> = new JoinNode();
