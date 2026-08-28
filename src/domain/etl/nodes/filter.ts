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
 * 各条件は内部マーカー `disabled?: boolean` を持てる。`disabled: true` の条件は inferSchema /
 * execute の両方で「存在しない条件」として扱う。設計時に人が書くものではなく、Agent Tool の
 * nullable 引数が実行時に省略されたとき application層（`graphWithArguments`）が注入する。
 * 残った条件が0件になった場合、filter は全行を通すパススルーになる（スキーマは不変）。
 *
 * 各条件は `opBinding?: { source:'agent-input', field, allowed? }` を持てる。実行時に Agent Tool の
 * string引数で演算子そのものを差し替える参照で、`allowed` は Agent が選べる演算子の許可リスト
 * （省略時は全演算子）。設計時の `op` はプレビューのサンプルかつ、nullable 引数が省略されたときの
 * 既定演算子。inferSchema は「許可されたどの演算子が選ばれても列型が成立するか」を検証する。
 *
 * inferSchema / execute は両形式を条件配列へ正規化して処理する（disabled は除外する）。
 * - inferSchema: 各条件の `column` 存在必須（欠損 → error/mismatch）。`gt|gte|lt|lte` は
 *   列型が number|date 必須（違反 → 型不一致 error + mismatch）。問題が無ければ入力
 *   スキーマそのまま state:'confirmed'。複数条件では全条件分の issue を集約する。
 * - execute: combine に応じて全条件 AND / いずれか OR で行を残す。
 *   eq/neq=厳密等価（Date は時刻値比較）; 大小=数値/日付比較;
 *   contains=文字列包含（String化）; isNull/notNull。
 *
 * 各条件は `caseInsensitive?: boolean` を持てる（既定 false = 従来どおり区別する）。
 * true のとき、文字列比較（eq/neq は両辺が string の場合のみ・contains は String 化後）を
 * 大文字小文字を区別せず判定する。折り畳みは `toLowerCase()`（ロケール非依存の既定変換）。
 * 数値・日付・boolean の比較や isNull/notNull、大小比較には作用しない（value と同様、
 * 演算子に無関係な設定キーは黙って無視する既存の規約に従う）。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/**
 * フィルタ演算子の正準リスト（ドメイン・アプリケーション層が共有する定義）。
 * UI（NodeInspector）は独立レイヤーのため表示用の複製を別途持つ — UI 側テストが
 * このリストとの一致をピン留めしている。
 */
export const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isNull', 'notNull'] as const;

/** フィルタ演算子。 */
export type FilterOp = (typeof FILTER_OPS)[number];

/** 値が FilterOp か。Agent 引数から実行時に演算子を受け取るときの検証に使う。 */
export function isFilterOp(value: unknown): value is FilterOp {
  return typeof value === 'string' && (FILTER_OPS as readonly string[]).includes(value);
}

/** 値を要さない演算子（evaluate が value を参照しない）。application層・UIの値スキップ判定が共有する。 */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set(['isNull', 'notNull']);

/** `caseInsensitive` が作用する演算子（文字列比較を行うもの）。UIのチェックボックス表示判定が共有する。 */
export const CASE_FOLD_OPS: ReadonlySet<FilterOp> = new Set(['eq', 'neq', 'contains']);

/** 複数条件の結合方法。 */
export type FilterCombine = 'and' | 'or';

/**
 * 実行時に Agent Tool の引数（string型）で op を上書きする参照。
 * `allowed` は Agent が選べる演算子の許可リスト（省略時は全演算子）。設計時の `op` は
 * プレビューのサンプルであり、引数が nullable で省略されたときの既定演算子にもなる。
 */
export interface OperatorBinding {
  readonly source: 'agent-input';
  readonly field: string;
  readonly allowed?: readonly FilterOp[];
}

/** 条件1つ。旧形式のフラット config もこの形（1条件）として扱う。 */
export interface FilterCondition {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: Cell;
  /** 実行時に Agent Tool の引数で value を上書きする参照。設計時は value をsampleに使う。 */
  readonly valueBinding?: { readonly source: 'agent-input'; readonly field: string };
  /** 実行時に Agent Tool の引数で op を上書きする参照。設計時は op を既定値として使う。 */
  readonly opBinding?: OperatorBinding;
  /** true なら文字列比較（eq/neq/contains）で大文字小文字を区別しない。既定 false。 */
  readonly caseInsensitive?: boolean;
  /**
   * 実行時スキップの内部マーカー。true の条件は無いものとして扱う。
   * nullable な Agent Tool 引数が省略されたときに application層が注入する。
   */
  readonly disabled?: boolean;
}

/** 新形式（複数条件 + AND/OR）の設定。 */
export interface FilterConditionsConfig {
  readonly conditions: readonly FilterCondition[];
  /** 省略時は 'and'。 */
  readonly combine?: FilterCombine;
}

/** `filter` の設定。旧形式（単一条件フラット）と新形式（conditions）の両方。 */
export type FilterConfig = FilterCondition | FilterConditionsConfig;

/** 順序比較を要する演算子（列型 number|date が必須）。application層のプロンプト生成・検証が共有する。 */
export const ORDER_OPS: ReadonlySet<FilterOp> = new Set(['gt', 'gte', 'lt', 'lte']);

const cellSchema: z.ZodType<Cell> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.instanceof(Date),
  z.null(),
]);

const conditionSchema = z.object({
  column: z.string(),
  op: z.enum(FILTER_OPS),
  value: cellSchema.optional(),
  valueBinding: z.object({ source: z.literal('agent-input'), field: z.string().min(1) }).optional(),
  opBinding: z.object({
    source: z.literal('agent-input'),
    field: z.string().min(1),
    allowed: z.array(z.enum(FILTER_OPS)).min(1).optional(),
  }).optional(),
  caseInsensitive: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

const conditionsSchema = z.object({
  conditions: z.array(conditionSchema).min(1),
  combine: z.enum(['and', 'or']).default('and'),
});

/** 新形式（conditions を持つ）か。z.union を使わず形で分岐し、Zod の詳細メッセージを保つ。 */
function hasConditions(config: unknown): boolean {
  return typeof config === 'object' && config !== null && Object.prototype.hasOwnProperty.call(config, 'conditions');
}

/** 実行時スキップされていない（有効な）条件か。 */
function isActive(condition: FilterCondition): boolean {
  return condition.disabled !== true;
}

/**
 * 設定を「条件配列 + 結合方法」へ正規化する（旧形式は1条件として扱う）。
 * `disabled: true` の条件はここで落とすので、以降は存在しない条件として扱われる。
 */
function normalize(config: FilterConfig): { readonly conditions: readonly FilterCondition[]; readonly combine: FilterCombine } {
  if (hasConditions(config)) {
    const conditions = config as FilterConditionsConfig;
    return { conditions: conditions.conditions.filter(isActive), combine: conditions.combine ?? 'and' };
  }
  const flat = config as FilterCondition;
  return { conditions: isActive(flat) ? [flat] : [], combine: 'and' };
}

/** Cell を順序比較用の数値に変換する（number はそのまま / Date は時刻値 / 他は NaN）。 */
function toComparable(value: Cell): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

/** eq/neq 用の厳密等価（Date は時刻値で比較）。caseInsensitive は両辺 string のときだけ作用する。 */
function cellEquals(a: Cell, b: Cell, caseInsensitive: boolean): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  // 片方だけ Date のときは厳密には非等価（型が異なる）。
  if (a instanceof Date || b instanceof Date) return false;
  if (caseInsensitive && typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** 1セルに対して述語を評価する。 */
function evaluate(cell: Cell, op: FilterOp, value: Cell, caseInsensitive: boolean): boolean {
  switch (op) {
    case 'isNull':
      return cell === null;
    case 'notNull':
      return cell !== null;
    case 'eq':
      return cellEquals(cell, value, caseInsensitive);
    case 'neq':
      return !cellEquals(cell, value, caseInsensitive);
    case 'contains':
      return caseInsensitive
        ? String(cell).toLowerCase().includes(String(value).toLowerCase())
        : String(cell).includes(String(value));
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

/** 1条件のスキーマ検証（列存在 / 順序演算子の列型 / opBinding の整合）。 */
function conditionIssues(input: Schema, condition: FilterCondition): SchemaIssue[] {
  const col = findColumn(input, condition.column);
  if (col === undefined) {
    return [{
      severity: 'error',
      message: `filter: column not found: ${condition.column}`,
      column: condition.column,
    }];
  }
  const issues: SchemaIssue[] = [];
  const binding = condition.opBinding;
  // 実行時にどの許可演算子が選ばれても成立するよう、順序演算子を許すなら列型 number|date を要求する。
  const orderable = binding === undefined ? [] : (binding.allowed ?? FILTER_OPS).filter((op) => ORDER_OPS.has(op));
  const orderableIssue = orderable.length > 0 && col.type !== 'number' && col.type !== 'date';
  // 静的な op の列型エラーは、opBinding の orderable エラーが出るとき同根（op ∈ orderable）なので統合して1メッセージにする。
  if (!orderableIssue && ORDER_OPS.has(condition.op) && col.type !== 'number' && col.type !== 'date') {
    issues.push({
      severity: 'error',
      message: `filter: operator '${condition.op}' requires column type number|date, but '${condition.column}' is '${col.type}'`,
      column: condition.column,
    });
  }
  if (binding !== undefined) {
    // 既定演算子（設計時の op）は許可リストの中から選ぶ。実行時省略のフォールバック先でもあるため。
    if (binding.allowed !== undefined && !binding.allowed.includes(condition.op)) {
      issues.push({
        severity: 'error',
        message: `filter: default operator '${condition.op}' is not in opBinding.allowed (${binding.allowed.join(', ')})`,
        column: condition.column,
      });
    }
    if (orderableIssue) {
      issues.push({
        severity: 'error',
        message: `filter: opBinding on '${condition.column}' allows operator(s) ${orderable.join('|')} which require column type number|date, but '${condition.column}' is '${col.type}'; restrict opBinding.allowed`,
        column: condition.column,
      });
    }
  }
  return issues;
}

/** 1行 × 1条件の判定（欠損キーは null 扱い）。 */
function matches(row: Row, condition: FilterCondition): boolean {
  const cell = Object.prototype.hasOwnProperty.call(row, condition.column)
    ? (row[condition.column] ?? null)
    : null;
  return evaluate(cell, condition.op, condition.value ?? null, condition.caseInsensitive === true);
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

    // 有効な条件が残っていなければパススルー（OR の some が全行を落とすのを避ける）。
    const rows: Row[] = conditions.length === 0
      ? [...input.rows]
      : input.rows.filter((row: Row) => combine === 'or'
        ? conditions.some((condition) => matches(row, condition))
        : conditions.every((condition) => matches(row, condition)));

    // スキーマ不変。行配列は filter が新規生成。
    return { schema: input.schema, rows };
  }
}

/** `filter` ノードのシングルトン。 */
export const filterNode: EtlNode<FilterConfig> = new FilterNode();

/** opBinding を持つ条件1つ分の情報（application層の保存検証・Tool公開・Factoryが共有する）。 */
export interface OperatorBindingSite {
  /** バインド先の Agent 引数名。 */
  readonly field: string;
  /** フィルタ対象の列名（未設定の config では空文字）。 */
  readonly column: string;
  /** Agent が選べる演算子（`allowed` 省略時は全演算子へ展開済み。未知の値は除去済み）。 */
  readonly allowed: readonly FilterOp[];
  /** 設計時の既定演算子（nullable 引数が実行時に省略されたときのフォールバック）。 */
  readonly defaultOp?: FilterOp;
  /** 同じ条件が valueBinding も持つ場合、その参照先 Agent 引数名（isNull/notNull 許可時の nullable 検証に使う）。 */
  readonly valueField?: string;
}

/** valueBinding を持つ条件1つ分の情報（opBinding 側の `operatorBindingsOf` と対称）。 */
export interface ValueBindingSite {
  /** バインド先の Agent 引数名。 */
  readonly field: string;
  /** フィルタ対象の列名（未設定の config では空文字）。 */
  readonly column: string;
}

/** 条件の生データから valueBinding の field を取り出す（形が壊れていれば undefined）。 */
function valueFieldOf(condition: { valueBinding?: { source?: unknown; field?: unknown } }): string | undefined {
  const binding = condition.valueBinding;
  return binding?.source === 'agent-input' && typeof binding.field === 'string' && binding.field !== '' ? binding.field : undefined;
}

/** 未検証の filter config（旧フラット形式 / 新 conditions 形式）を条件の生データ配列へ正規化する。 */
function rawConditionsOf(config: unknown): Record<string, unknown>[] {
  const conditions = (config as { conditions?: unknown } | null)?.conditions;
  const sources = Array.isArray(conditions) ? conditions : [config];
  return sources.map((source) => (source ?? {}) as Record<string, unknown>);
}

/**
 * 未検証の filter config（旧フラット形式 / 新 conditions 形式）から opBinding を持つ条件を集める。
 * 実行時（`graphWithArguments`）に演算子が差し替わる対象と同じ集合を返す。
 */
export function operatorBindingsOf(config: unknown): OperatorBindingSite[] {
  const sites: OperatorBindingSite[] = [];
  for (const raw of rawConditionsOf(config)) {
    const condition = raw as { column?: unknown; op?: unknown; opBinding?: { source?: unknown; field?: unknown; allowed?: unknown }; valueBinding?: { source?: unknown; field?: unknown } };
    const binding = condition.opBinding;
    if (binding?.source !== 'agent-input' || typeof binding.field !== 'string' || binding.field === '') continue;
    const allowed = Array.isArray(binding.allowed) && binding.allowed.length > 0
      ? binding.allowed.filter(isFilterOp)
      : FILTER_OPS;
    const valueField = valueFieldOf(condition);
    sites.push({
      field: binding.field,
      column: typeof condition.column === 'string' ? condition.column : '',
      allowed,
      ...(isFilterOp(condition.op) ? { defaultOp: condition.op } : {}),
      ...(valueField === undefined ? {} : { valueField }),
    });
  }
  return sites;
}

/**
 * 未検証の filter config から valueBinding を持つ条件を集める。実行時に value が差し替わる対象と
 * 同じ集合を、保存検証（SaveTool）と Factory の引数消費チェックが共有する。
 */
export function valueBindingsOf(config: unknown): ValueBindingSite[] {
  const sites: ValueBindingSite[] = [];
  for (const raw of rawConditionsOf(config)) {
    const condition = raw as { column?: unknown; valueBinding?: { source?: unknown; field?: unknown } };
    const field = valueFieldOf(condition);
    if (field === undefined) continue;
    sites.push({ field, column: typeof condition.column === 'string' ? condition.column : '' });
  }
  return sites;
}

/** 同一 field をバインドする全条件を集約した、演算子引数1つ分の要約。 */
export interface OperatorArgumentSummary {
  /** Agent 引数名。 */
  readonly field: string;
  /** この引数が演算子を供給する列（重複排除・出現順）。 */
  readonly columns: readonly string[];
  /** 全条件の許可リストの積集合（FILTER_OPS の順序。空なら引数として成立しない）。 */
  readonly allowed: readonly FilterOp[];
  /** 全条件で一致する場合のみの既定演算子。 */
  readonly defaultOp?: FilterOp;
  /** 既定演算子が条件間で不一致か（不一致は保存時に拒否する対象）。 */
  readonly defaultOpMixed: boolean;
}

/**
 * 複数 filter ノードの config 群から、演算子引数を field 単位に集約する。
 * 保存検証（積集合非空・既定演算子一致）、Tool 公開スキーマの enum、実行時の演算子検証が
 * この1つの集約を共有し、「保存が通れば公開 enum は非空で、enum 内の演算子は必ず実行できる」
 * という不変条件を1か所で定義する。
 */
export function operatorArgumentSummaries(configs: readonly unknown[]): OperatorArgumentSummary[] {
  const byField = new Map<string, OperatorBindingSite[]>();
  for (const config of configs) {
    for (const site of operatorBindingsOf(config)) {
      const existing = byField.get(site.field);
      if (existing === undefined) byField.set(site.field, [site]);
      else existing.push(site);
    }
  }
  return [...byField.entries()].map(([field, sites]) => {
    const allowed = FILTER_OPS.filter((op) => sites.every((site) => site.allowed.includes(op)));
    const columns = [...new Set(sites.map((site) => site.column).filter((column) => column !== ''))];
    const defaults = new Set(sites.map((site) => site.defaultOp));
    const uniform = defaults.size === 1 ? sites[0]?.defaultOp : undefined;
    return {
      field,
      columns,
      allowed,
      ...(uniform === undefined ? {} : { defaultOp: uniform }),
      defaultOpMixed: defaults.size > 1,
    };
  });
}
