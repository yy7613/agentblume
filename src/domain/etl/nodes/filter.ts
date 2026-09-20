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
 * **日付列の value は ISO 文字列で書ける**。保存済み config は JSON なので `Date` リテラルを持てず、
 * Agent Tool の引数も文字列で届く。そこで列が日付（inferSchema は入力スキーマの型、execute は
 * スキーマ + 実データのセルが Date か）のとき、`eq/neq/gt/gte/lt/lte` の文字列 value を
 * ISO 日付（`2008-01-01` = UTC 0時 / 日時も可）として Date へ寄せてから比較する。
 * 以前はここで NaN 同士の比較になり、**エラーも出さずに 0 行**を返していた（日付範囲の絞り込みが
 * Tool Builder からも LLM が書いたグラフからも使えなかった）。ISO として読めない文字列は
 * inferSchema が error issue、execute が SchemaError にする（黙って 0 行にはしない）。
 *
 * 各条件は `caseInsensitive?: boolean` を持てる（既定 false = 従来どおり区別する）。
 * true のとき、文字列比較（eq/neq/in/notIn は両辺が string の場合のみ・contains は String 化後）を
 * 大文字小文字を区別せず判定する。折り畳みは `toLowerCase()`（ロケール非依存の既定変換）。
 * 数値・日付・boolean の比較や isNull/notNull、大小比較には作用しない（value と同様、
 * 演算子に無関係な設定キーは黙って無視する既存の規約に従う）。
 *
 * **複数値の一致（`in` / `notIn`）**。これらの演算子は `value` ではなく `values`（1〜100件）を読む。
 * 「東京都・大阪府・北海道」を1条件・1回のツール呼び出しで絞り込むための形で、単値演算子しか
 * 無かった頃は Agent が県ごとにツールを呼び、実測で per-run のツール呼び出し上限に当たっていた。
 * - `in` = セルが `values` のいずれかと等しい（等価判定は `eq` と同じ。caseInsensitive も効く）。
 *   **null セルは `in` に一致しない**（`values` に null があっても一致しない。`eq` との唯一の差で、
 *   「列挙した値のどれか」という意図に揃える）。
 * - `notIn` = `neq` と対称で `in` の単純否定（`!values.some(equals)`）。したがって **null セルは
 *   `values` に null が無ければ一致する**（`neq` が null セルを残すのと同じ扱い）。
 * - 日付列・数値列の `values` は文字列で書ける（単値の ISO 解釈と同じ理由。JSON の config も
 *   Agent 引数も文字列しか運べない）。読めない要素は**その要素を名指しして**エラーにする。
 * - `valueBinding` を持つ `in` / `notIn` は、実行時に**区切り文字で連結した1つの文字列引数**から
 *   値の並びを受け取る（分解は application 層の `graphWithArguments`）。設計時の `values` は
 *   プレビュー用サンプルとして残る。
 * - `opBinding.allowed` に `in` / `notIn` は入れられない（値の形が `value` と異なり、1つの文字列
 *   引数を単値としても並びとしても解釈できないため）。設計時検証で error にする。
 */
import { z } from 'zod';
import type { Cell, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/**
 * フィルタ演算子の正準リスト（ドメイン・アプリケーション層が共有する定義）。
 * UI（NodeInspector）は独立レイヤーのため表示用の複製を別途持つ — UI 側テストが
 * このリストとの一致をピン留めしている。
 */
export const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'notIn', 'isNull', 'notNull'] as const;

/** フィルタ演算子。 */
export type FilterOp = (typeof FILTER_OPS)[number];

/** 値が FilterOp か。Agent 引数から実行時に演算子を受け取るときの検証に使う。 */
export function isFilterOp(value: unknown): value is FilterOp {
  return typeof value === 'string' && (FILTER_OPS as readonly string[]).includes(value);
}

/** 値を要さない演算子（evaluate が value を参照しない）。application層・UIの値スキップ判定が共有する。 */
export const VALUELESS_OPS: ReadonlySet<FilterOp> = new Set(['isNull', 'notNull']);

/** `caseInsensitive` が作用する演算子（文字列比較を行うもの）。UIのチェックボックス表示判定が共有する。 */
export const CASE_FOLD_OPS: ReadonlySet<FilterOp> = new Set(['eq', 'neq', 'contains', 'in', 'notIn']);

/** `value` ではなく `values`（複数値）を読む演算子。application層・UIの値エディタ切替が共有する。 */
export const MULTI_VALUE_OPS: ReadonlySet<FilterOp> = new Set(['in', 'notIn']);

/**
 * `opBinding` で Agent に選ばせられる演算子（`allowed` 省略時の既定でもある）。
 * `in` / `notIn` は値の形（`values` の並び）が他と違うため、1つの引数で演算子だけを差し替える
 * この仕組みには載せられない — 演算子引数の公開 enum からも常に外す。
 */
export const OPERATOR_BINDABLE_OPS: readonly FilterOp[] = FILTER_OPS.filter((op) => !MULTI_VALUE_OPS.has(op));

/** `values` に置ける値の上限（設計時の静的な並びも、実行時に引数から分解した並びも同じ上限）。 */
export const MAX_FILTER_VALUES = 100;

/**
 * 1つの文字列引数に詰めた値の並びを分ける区切り（半角/全角カンマ・読点・セミコロン・改行）。
 * LLM は「東京都, 大阪府」とも「東京都、大阪府」とも書くため、どれでも同じ並びに読めるようにする。
 */
const VALUE_LIST_SEPARATOR = /[,、，;\r\n]+/;

/**
 * 区切り文字で連結された文字列を値の並びへ分解する（前後の空白を落とし、空要素を捨て、重複を除く）。
 * 上限は掛けない — 何件まで許すか（と超過時のエラー文）は呼び出し側の関心なので `MAX_FILTER_VALUES`
 * と合わせて application 層が判定する。UI は独立レイヤーのため同じ規則の複製を別途持つ。
 */
export function parseFilterValueList(text: string): string[] {
  return [...new Set(text.split(VALUE_LIST_SEPARATOR).map((item) => item.trim()).filter((item) => item !== ''))];
}

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
  /**
   * `in` / `notIn` が読む値の並び（1〜100件）。他の演算子では無視する。
   * `valueBinding` を持つ条件では設計時プレビューのサンプルで、実行時は引数から分解した並びで置き換わる。
   */
  readonly values?: readonly Cell[];
  /** 実行時に Agent Tool の引数で value（`in`/`notIn` では values）を上書きする参照。設計時は sample に使う。 */
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

/**
 * in / notIn は `values` だけを読み、`value` は無視する契約。ところが手書きでも LLM でも
 * `value` に同じ配列を重ねて書かれやすく（実測: `{"op":"in","value":["東京都"],"values":["東京都"]}`）、
 * 「無視する」はずの項目の型で設定ごと弾いていた。検証の前に受け流す:
 * `values` が無く `value` が配列ならそれを `values` として読み、どちらの場合も配列の `value` は落とす。
 */
function tolerateListValue(condition: unknown): unknown {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return condition;
  const record = condition as Record<string, unknown>;
  if ((record['op'] !== 'in' && record['op'] !== 'notIn') || !Array.isArray(record['value'])) return condition;
  const { value, ...rest } = record;
  return Array.isArray(rest['values']) ? rest : { ...rest, values: value };
}

const conditionSchema = z.preprocess(tolerateListValue, z.object({
  column: z.string(),
  op: z.enum(FILTER_OPS),
  value: cellSchema.optional(),
  // 空配列は zod では通し、設計時検証（conditionIssues）で「値を列挙してください」と案内する
  // （UI で最後の値を消した瞬間に ConfigError で画面を塞がないため）。上限だけはここで弾く。
  values: z.array(cellSchema).max(MAX_FILTER_VALUES, `filter: at most ${MAX_FILTER_VALUES} values are allowed for 'in'/'notIn'`).optional(),
  valueBinding: z.object({ source: z.literal('agent-input'), field: z.string().min(1) }).optional(),
  opBinding: z.object({
    source: z.literal('agent-input'),
    field: z.string().min(1),
    allowed: z.array(z.enum(FILTER_OPS)).min(1).optional(),
  }).optional(),
  caseInsensitive: z.boolean().optional(),
  disabled: z.boolean().optional(),
}));

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
export function normalizeFilterConfig(config: FilterConfig): { readonly conditions: readonly FilterCondition[]; readonly combine: FilterCombine } {
  if (hasConditions(config)) {
    const conditions = config as FilterConditionsConfig;
    return { conditions: conditions.conditions.filter(isActive), combine: conditions.combine ?? 'and' };
  }
  const flat = config as FilterCondition;
  return { conditions: isActive(flat) ? [flat] : [], combine: 'and' };
}

/**
 * ISO 8601 らしき日付文字列（csv-source の判定と同じ緩さ）。日付のみ / 日時（Z or ±hh:mm）を許可。
 * 同じ文字列が csv-source では date セルに、ここでは date 列の比較値になるよう、判定を揃える。
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** 日付列で value を日付として解釈する演算子（contains は String 化の包含なので対象外）。 */
const DATE_VALUE_OPS: ReadonlySet<FilterOp> = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

/**
 * ISO 日付文字列を Date へ。日付のみ（`2008-01-01`）は UTC 0 時 — JS の既定解釈そのままで、
 * csv-source が date セルを作るときと同じ。読めなければ undefined。
 */
export function isoDateValue(value: string): Date | undefined {
  if (!ISO_DATE_RE.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 日付として解釈すべき文字列 value を持つ条件か（列が日付かどうかは呼び出し側が判定する）。 */
function hasDateStringValue(condition: FilterCondition): condition is FilterCondition & { readonly value: string } {
  return DATE_VALUE_OPS.has(condition.op) && typeof condition.value === 'string';
}

/** 日付列の文字列 value が ISO として読めないときのメッセージ（inferSchema と execute で同一文）。 */
function isoDateMessage(column: string, value: string): string {
  return `filter: value for date column '${column}' must be an ISO date (YYYY-MM-DD): ${value}`;
}

/** `in`/`notIn` の値の並びに、日付として読めない要素が混ざっていたときのメッセージ（要素を名指しする）。 */
function isoDateListMessage(column: string, value: string): string {
  return `filter: values for date column '${column}' must be ISO dates (YYYY-MM-DD): ${value}`;
}

/** `in`/`notIn` の値の並びに、数値として読めない要素が混ざっていたときのメッセージ（要素を名指しする）。 */
function numberListMessage(column: string, value: string): string {
  return `filter: values for number column '${column}' must be numbers: ${value}`;
}

/** `in`/`notIn` なのに値が1つも無いときのメッセージ（inferSchema と execute で同一文）。 */
function emptyValuesMessage(column: string, op: FilterOp): string {
  return `filter: operator '${op}' requires a non-empty 'values' list for column '${column}'`;
}

/** 数値として読める文字列ならその数値（空文字は `Number('')===0` になるので除く）。読めなければ undefined。 */
function numberValue(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 実データ側での列の種別。スキーマが型を言っていればそれ、型が未知ならセルの実体で判定する
 * （型が確定している列はその型として扱う）。`values` の文字列要素をどう寄せるかもこれで決める。
 */
function columnKind(input: Table, column: string): 'date' | 'number' | 'other' {
  const col = findColumn(input.schema, column);
  if (col?.type === 'date') return 'date';
  if (col?.type === 'number') return 'number';
  if (col !== undefined && col.type !== 'unknown') return 'other';
  for (const row of input.rows) {
    const cell = row[column];
    if (cell === undefined || cell === null) continue;
    if (cell instanceof Date) return 'date';
    return typeof cell === 'number' ? 'number' : 'other';
  }
  return 'other';
}

/**
 * `values` の文字列要素を列の型へ寄せる（日付列は ISO → Date、数値列は数値文字列 → number）。
 * 読めない要素は**その要素を名指しした** SchemaError にする（黙って 0 行にしない）。
 */
function preparedValues(kind: 'date' | 'number' | 'other', column: string, values: readonly Cell[]): readonly Cell[] {
  if (kind === 'other') return values;
  return values.map((item) => {
    if (typeof item !== 'string') return item;
    const coerced: Cell | undefined = kind === 'date' ? isoDateValue(item) : numberValue(item);
    if (coerced === undefined) {
      throw new SchemaError(kind === 'date' ? isoDateListMessage(column, item) : numberListMessage(column, item));
    }
    return coerced;
  });
}

/**
 * 実行時の条件を整える（日付列の ISO 文字列 value / 日付・数値列の `values` 要素を寄せる）。
 * execute と、0 件の理由を説明する application 層の診断が**同じ関数**で整えることで、
 * 「診断が数えた件数」と「実行が残した行」が食い違わないようにする。
 */
export function prepareFilterCondition(input: Table, condition: FilterCondition): FilterCondition {
  if (MULTI_VALUE_OPS.has(condition.op)) {
    const values = condition.values ?? [];
    // 空の並びは `in` なら全滅・`notIn` なら素通しと、静かに意味が変わってしまうのでここで止める
    // （実行時に引数から空の並びが来る場合は、条件ごと無効化されてここへは届かない）。
    if (values.length === 0) throw new SchemaError(emptyValuesMessage(condition.column, condition.op));
    const prepared = preparedValues(columnKind(input, condition.column), condition.column, values);
    return prepared.every((item, index) => item === values[index]) ? condition : { ...condition, values: prepared };
  }
  if (!hasDateStringValue(condition) || columnKind(input, condition.column) !== 'date') return condition;
  const value = isoDateValue(condition.value);
  if (value === undefined) throw new SchemaError(isoDateMessage(condition.column, condition.value));
  return { ...condition, value };
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

/** 1セルに対して述語を評価する。`values` は `in`/`notIn` だけが読む。 */
function evaluate(cell: Cell, op: FilterOp, value: Cell, values: readonly Cell[], caseInsensitive: boolean): boolean {
  switch (op) {
    case 'isNull':
      return cell === null;
    case 'notNull':
      return cell !== null;
    case 'eq':
      return cellEquals(cell, value, caseInsensitive);
    case 'neq':
      return !cellEquals(cell, value, caseInsensitive);
    // null セルは「列挙したどれか」に含まれない（`eq null` との唯一の差。上部コメント参照）。
    case 'in':
      return cell !== null && values.some((candidate) => cellEquals(cell, candidate, caseInsensitive));
    // `neq` と対称の単純否定。よって null セルは values に null が無ければ残る。
    case 'notIn':
      return !values.some((candidate) => cellEquals(cell, candidate, caseInsensitive));
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

/**
 * `values`（複数値）まわりの設計時検証。
 * - `in`/`notIn` で値が空: `valueBinding` があれば実行時に引数から届くので warning（プレビューは 0 行）、
 *   無ければ実行時も救えないので error。
 * - 値の型: 日付列・数値列の文字列要素は寄せられること（読めない要素を名指しして error）。
 * - `in`/`notIn` 以外に `values` が残っている: 演算子に無関係な設定キーを黙って無視する既存の規約に
 *   合わせて実行は続けるが、「効いていない」ことが画面から分かるよう warning で知らせる。
 */
function valuesIssues(columnType: string, condition: FilterCondition): SchemaIssue[] {
  const column = condition.column;
  if (!MULTI_VALUE_OPS.has(condition.op)) {
    return condition.values === undefined
      ? []
      : [{ severity: 'warning', message: `filter: 'values' is ignored by operator '${condition.op}' on column '${column}'`, column }];
  }
  const values = condition.values ?? [];
  if (values.length === 0) {
    return condition.valueBinding?.source === 'agent-input'
      ? [{ severity: 'warning', message: `filter: operator '${condition.op}' on column '${column}' has no design-time 'values' sample, so the preview matches no rows`, column }]
      : [{ severity: 'error', message: emptyValuesMessage(column, condition.op), column }];
  }
  if (columnType !== 'date' && columnType !== 'number') return [];
  return values.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const coerced = columnType === 'date' ? isoDateValue(item) : numberValue(item);
    if (coerced !== undefined) return [];
    const message = columnType === 'date' ? isoDateListMessage(column, item) : numberListMessage(column, item);
    return [{ severity: 'error' as const, message, column }];
  });
}

/** 1条件のスキーマ検証（列存在 / 順序演算子の列型 / values の整合 / opBinding の整合）。 */
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
  // 日付列に読めない文字列を置くと実行時は「エラー無しの 0 行」になるため、設計時に error で止める。
  if (col.type === 'date' && hasDateStringValue(condition) && isoDateValue(condition.value) === undefined) {
    issues.push({ severity: 'error', message: isoDateMessage(condition.column, condition.value), column: condition.column });
  }
  issues.push(...valuesIssues(col.type, condition));
  const binding = condition.opBinding;
  // 実行時にどの許可演算子が選ばれても成立するよう、順序演算子を許すなら列型 number|date を要求する。
  const orderable = binding === undefined ? [] : (binding.allowed ?? OPERATOR_BINDABLE_OPS).filter((op) => ORDER_OPS.has(op));
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
    // `in`/`notIn` は値の形（values の並び）が違うので、演算子だけを差し替える opBinding には載せられない。
    const multi = [...new Set([...(binding.allowed ?? []), condition.op])].filter((op) => MULTI_VALUE_OPS.has(op));
    if (multi.length > 0) {
      issues.push({
        severity: 'error',
        message: `filter: opBinding on '${condition.column}' cannot use operator(s) ${multi.join('|')} because they take a list of values; use a fixed operator for those conditions`,
        column: condition.column,
      });
    }
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

/**
 * 1行 × 1条件の判定（欠損キーは null 扱い）。value は `prepareFilterCondition` で整えた後の値を渡す。
 * execute と診断が同じ意味で数えられるよう公開する。
 */
export function rowMatchesFilterCondition(row: Row, condition: FilterCondition): boolean {
  const cell = Object.prototype.hasOwnProperty.call(row, condition.column)
    ? (row[condition.column] ?? null)
    : null;
  return evaluate(cell, condition.op, condition.value ?? null, condition.values ?? [], condition.caseInsensitive === true);
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
    const issues = normalizeFilterConfig(config).conditions.flatMap((condition) => conditionIssues(input, condition));
    // スキーマは不変。warning（効かない設定キー等）は state を落とさず持ち帰る。
    return {
      schema: input,
      state: issues.some((issue) => issue.severity === 'error') ? 'mismatch' : 'confirmed',
      issues,
    };
  }

  execute(inputs: readonly Table[], config: FilterConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    const { conditions, combine } = normalizeFilterConfig(config);
    // 日付列の ISO 文字列は行ごとではなく最初に1回だけ Date へ寄せる（読めない文字列はここで SchemaError）。
    const prepared = conditions.map((condition) => prepareFilterCondition(input, condition));

    // 有効な条件が残っていなければパススルー（OR の some が全行を落とすのを避ける）。
    const rows: Row[] = prepared.length === 0
      ? [...input.rows]
      : input.rows.filter((row: Row) => combine === 'or'
        ? prepared.some((condition) => rowMatchesFilterCondition(row, condition))
        : prepared.every((condition) => rowMatchesFilterCondition(row, condition)));

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
  /** 複数値演算子（`in`/`notIn`）の条件か。実行時に1つの文字列引数を値の並びへ分解する対象。 */
  readonly multiValue: boolean;
  /** 設計時の `values` サンプル（`multiValue` の条件のみ。公開スキーマの説明文の例に使う）。 */
  readonly samples?: readonly Cell[];
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
    // 公開 enum・実行時検証に in/notIn が載らないよう、明示リストからも省略時の全演算子からも除く
    // （設計時検証は allowed に書いてしまった in/notIn を error で差し戻す）。
    const allowed = Array.isArray(binding.allowed) && binding.allowed.length > 0
      ? binding.allowed.filter(isFilterOp).filter((op) => !MULTI_VALUE_OPS.has(op))
      : OPERATOR_BINDABLE_OPS;
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
    const condition = raw as { column?: unknown; op?: unknown; values?: unknown; valueBinding?: { source?: unknown; field?: unknown } };
    const field = valueFieldOf(condition);
    if (field === undefined) continue;
    const multiValue = isFilterOp(condition.op) && MULTI_VALUE_OPS.has(condition.op);
    const samples = multiValue && Array.isArray(condition.values) ? (condition.values as readonly Cell[]) : undefined;
    sites.push({
      field,
      column: typeof condition.column === 'string' ? condition.column : '',
      multiValue,
      ...(samples === undefined ? {} : { samples }),
    });
  }
  return sites;
}

/** 同一 field をバインドする全条件を集約した、値の並びを受け取る引数1つ分の要約。 */
export interface ListValueArgumentSummary {
  /** Agent 引数名。 */
  readonly field: string;
  /** この引数が値の並びを供給する列（重複排除・出現順）。 */
  readonly columns: readonly string[];
  /** 設計時サンプルから作った値の例（重複排除・出現順。説明文へ載せる分だけ）。 */
  readonly samples: readonly string[];
}

/** 説明文の例に出す値の最大数（引数説明を短く保つ）。 */
const MAX_LIST_ARGUMENT_SAMPLES = 3;

/**
 * 複数 filter ノードの config 群から、「値の並び」を受け取る引数（`in`/`notIn` の valueBinding 先）を
 * field 単位に集約する。Tool 公開スキーマの説明文（カンマ区切りで複数渡せること）と、保存検証の
 * 「その引数は string でなければならない」がこの1つの集約を共有する。
 */
export function listValueArgumentSummaries(configs: readonly unknown[]): ListValueArgumentSummary[] {
  const byField = new Map<string, ValueBindingSite[]>();
  for (const config of configs) {
    for (const site of valueBindingsOf(config)) {
      if (!site.multiValue) continue;
      const existing = byField.get(site.field);
      if (existing === undefined) byField.set(site.field, [site]);
      else existing.push(site);
    }
  }
  return [...byField.entries()].map(([field, sites]) => ({
    field,
    columns: [...new Set(sites.map((site) => site.column).filter((column) => column !== ''))],
    samples: [...new Set(sites.flatMap((site) => site.samples ?? []).map((sample) => String(sample instanceof Date ? sample.toISOString() : sample)).filter((sample) => sample !== ''))]
      .slice(0, MAX_LIST_ARGUMENT_SAMPLES),
  }));
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
    const allowed = OPERATOR_BINDABLE_OPS.filter((op) => sites.every((site) => site.allowed.includes(op)));
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
