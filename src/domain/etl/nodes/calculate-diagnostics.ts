/**
 * ドメイン: 関数電卓の式の診断（v40 実装契約 §3 / §4 / ADR-0045）
 *
 * 「式が妥当か」「実際に何が出るか」を **1 か所** で答える。
 * ノード（`calculate.ts`）の `inferSchema` もここへ委ねる。判定の規則が 2 か所にあると、
 * 画面の案内・LLM への差し戻し・実行時の挙動が少しずつずれ、
 * 「プレビューでは通ったのに実行すると違う」という最も直しにくい不具合になるため。
 *
 * 値の計算もノードと同じ関数を通す（数値への寄せ・丸めをここに置き、ノードが使う）。
 */
import type { Cell, Column, Row, Schema } from '../../data/types';
import { columnNames, findColumn } from '../../data/schema';
import {
  EXPRESSION_ERROR_CODES,
  evaluateExpressionDetailed,
  parseExpression,
  roundAwayFromZero,
  suggestName,
  type CalculateFailureReason,
} from './calculate-expression';

/**
 * 診断の種別。式そのものの失敗（`EXPRESSION_ERROR_CODES`）に、
 * スキーマと突き合わせて初めて分かる 3 つを足したもの。
 */
export const EXPRESSION_DIAGNOSTIC_CODES = [
  ...EXPRESSION_ERROR_CODES,
  'unknown-column',
  'type-coerced',
  'type-not-numeric',
] as const;
export type ExpressionDiagnosticCode = (typeof EXPRESSION_DIAGNOSTIC_CODES)[number];

/** 診断 1 件。 */
export interface ExpressionDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: ExpressionDiagnosticCode;
  readonly message: string;
  /** 式の中の位置（0 起点）。列の問題など位置を特定できないものには入らない。 */
  readonly position?: number;
  readonly column?: string;
  readonly suggestion?: string;
}

/** 式をスキーマに対して判定した結果。 */
export interface ExpressionValidation {
  /** error が 1 つも無い。warning はあってもよい。 */
  readonly ok: boolean;
  readonly diagnostics: readonly ExpressionDiagnostic[];
  /** 参照した列（重複なし・出現順）。読めなかったときは空。 */
  readonly references: readonly string[];
  /** 入力に無い参照列（重複なし・出現順）。 */
  readonly unknownColumns: readonly string[];
}

/** プレビュー 1 行の結果。 */
export interface ExpressionPreviewRow {
  readonly index: number;
  readonly value: number | null;
  /** value が null のときだけ。 */
  readonly reason?: CalculateFailureReason;
}

/** 式を実際の行へ当てた結果。 */
export interface ExpressionPreview {
  /** 式が読めてスキーマに対して妥当（= validation.ok）。false なら rows は空。 */
  readonly ok: boolean;
  readonly validation: ExpressionValidation;
  readonly rows: readonly ExpressionPreviewRow[];
  readonly evaluated: number;
  readonly failed: number;
  /** 理由ごとの件数。0 件の理由はキーごと入れない。 */
  readonly failureCounts: Readonly<Partial<Record<CalculateFailureReason, number>>>;
  /** 最初に失敗した行。差し戻しと画面の案内に使う。失敗が無ければ入らない。 */
  readonly firstFailure?: ExpressionPreviewRow;
}

/** プレビューの見方。 */
export interface ExpressionPreviewOptions {
  /** 見る行数の上限。既定 100、上限 1000。超える入力は先頭から切る。 */
  readonly limit?: number;
  /** ノードと同じ丸め。0..15 の整数。 */
  readonly precision?: number;
}

/** プレビューで見る行数の既定。画面に出す量として十分で、打つたびに走っても重くない。 */
export const DEFAULT_PREVIEW_LIMIT = 100;
/** プレビューで見る行数の上限。 */
export const MAX_PREVIEW_LIMIT = 1000;

/**
 * セルを計算に使える数値へ寄せる。寄せられない値は null（参照列が null のときと同じ扱い）。
 * ノードの実行とプレビューが必ず同じ値を出すよう、寄せ方はここ 1 か所だけに置く。
 */
export function toCalculationNumber(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // boolean / Date は数値の意味が一意に決まらないので寄せない（判定では warning 済み）。
  return null;
}

/** 行から 1 列を読む。壊れた行（オブジェクトでない）でも落ちずに null。 */
function cellOf(row: Row | undefined, name: string): Cell {
  if (row === null || row === undefined || typeof row !== 'object') return null;
  const value = (row as Record<string, Cell>)[name];
  return value ?? null;
}

/**
 * 1 行分の列参照。ノードの実行とプレビューが同じ関数を使うことで、
 * 「寄せ方が片方だけ変わる」事故を構造的に起こせなくする。
 */
export function rowLookup(row: Row): (column: string) => number | null {
  return (name) => toCalculationNumber(cellOf(row, name));
}

/**
 * 評価結果へ丸めを当てる。桁数が範囲外なら null（ノードはそれを invalid-argument として扱う）。
 * 丸めもノードと共有する（`precision` の解釈が分かれると出る数が変わる）。
 */
export function applyPrecision(value: number | null, precision: number | undefined): number | null {
  if (value === null || precision === undefined) return value;
  return roundAwayFromZero(value, precision);
}

/** 壊れたスキーマでも落ちないよう、列の形をしているものだけ取り出す（契約: 投げない）。 */
function safeSchema(schema: Schema): Schema {
  const columns = (schema as { readonly columns?: unknown } | null | undefined)?.columns;
  if (!Array.isArray(columns)) return { columns: [] };
  return {
    columns: columns.filter(
      (column): column is Column =>
        column !== null && typeof column === 'object' && typeof (column as Column).name === 'string',
    ),
  };
}

/**
 * 参照列の型から出る診断。number なら何も出さない。
 *
 * どちらも warning なのは、型が合わなくても**実行はできる**ため（値が null になるだけ）。
 * error にすると、上流の cast をまだ入れていない途中の状態で組み立てを止めてしまう。
 */
function typeDiagnostic(column: Column): ExpressionDiagnostic | undefined {
  switch (column.type) {
    case 'number':
      return undefined;
    case 'string':
    case 'unknown':
    case 'null':
      return {
        severity: 'warning',
        code: 'type-coerced',
        message: `列 '${column.name}' は ${column.type} 型です。実行時に数値へ寄せます（数値にできない値は null）`,
        column: column.name,
      };
    default:
      return {
        severity: 'warning',
        code: 'type-not-numeric',
        message: `列 '${column.name}' は ${column.type} 型です。数値にできないため実行時は null になります`,
        column: column.name,
      };
  }
}

function emptyValidation(diagnostic: ExpressionDiagnostic): ExpressionValidation {
  return { ok: false, diagnostics: [diagnostic], references: [], unknownColumns: [] };
}

/** 式をスキーマに対して判定する。実行はしない。**投げない**。 */
export function validateExpression(expression: string, schema: Schema): ExpressionValidation {
  const text = typeof expression === 'string' ? expression : '';
  if (text.trim() === '') {
    // 設定途中の空欄。位置を指しても指す先が無いので position は入れない。
    return emptyValidation({ severity: 'error', code: 'empty', message: '式を入力してください' });
  }

  const input = safeSchema(schema);
  const known = columnNames(input);

  const parsed = parseExpression(text, known);
  if (!parsed.ok) {
    // 読めない式では列の検査をしない。構文が崩れている間の参照列は当てにならず、
    // 本当の原因（構文）より後ろの話で画面を埋めてしまう。
    return emptyValidation({
      severity: 'error',
      code: parsed.code,
      message: parsed.message,
      position: parsed.position,
      ...(parsed.suggestion === undefined ? {} : { suggestion: parsed.suggestion }),
    });
  }

  const diagnostics: ExpressionDiagnostic[] = [];
  const unknownColumns: string[] = [];
  for (const reference of parsed.references) {
    const column = findColumn(input, reference);
    if (column === undefined) {
      const suggestion = suggestName(reference, known);
      unknownColumns.push(reference);
      diagnostics.push({
        severity: 'error',
        code: 'unknown-column',
        message: `式が参照する列がありません: ${reference}`,
        column: reference,
        ...(suggestion === undefined ? {} : { suggestion }),
      });
      continue;
    }
    const typed = typeDiagnostic(column);
    if (typed !== undefined) diagnostics.push(typed);
  }

  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    diagnostics,
    references: parsed.references,
    unknownColumns,
  };
}

/** 見る行数を決める。0 以下・整数でない値は既定に寄せる（指定ミスで 0 行にしない）。 */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return DEFAULT_PREVIEW_LIMIT;
  return Math.min(limit, MAX_PREVIEW_LIMIT);
}

function noRows(validation: ExpressionValidation): ExpressionPreview {
  return { ok: false, validation, rows: [], evaluated: 0, failed: 0, failureCounts: {} };
}

/**
 * 式を実際の行へ当てて結果を返す。**保存も変更もしない**。**投げない**。
 * 値の計算はノードと同じ規則（数値への寄せ・丸め・非有限は null）。
 */
export function previewExpression(
  expression: string,
  schema: Schema,
  rows: readonly Row[],
  options?: ExpressionPreviewOptions,
): ExpressionPreview {
  const validation = validateExpression(expression, schema);
  // 読めない式で「全行 null」の表を作らない。原因は式にあり、行を見ても何も分からない。
  if (!validation.ok) return noRows(validation);

  const input = safeSchema(schema);
  const parsed = parseExpression(typeof expression === 'string' ? expression : '', columnNames(input));
  if (!parsed.ok) return noRows(validation); // 保険: validation.ok が true ならここへは来ない。

  const limit = resolveLimit(options?.limit);
  const precision = options?.precision;
  const source: readonly Row[] = Array.isArray(rows) ? rows : [];

  const previewRows: ExpressionPreviewRow[] = [];
  const failureCounts: Partial<Record<CalculateFailureReason, number>> = {};
  let evaluated = 0;
  let failed = 0;
  let firstFailure: ExpressionPreviewRow | undefined;

  for (let index = 0; index < source.length && previewRows.length < limit; index += 1) {
    // 入力の行は読むだけ（配列もオブジェクトも複製せず、書き換えもしない）。
    const outcome = evaluateExpressionDetailed(parsed.ast, rowLookup(source[index] ?? {}));
    const value = applyPrecision(outcome.value, precision);
    if (value === null) {
      // 丸めで初めて null になった場合は評価そのものが成功しているので理由が入らない。
      const reason = outcome.reason ?? 'invalid-argument';
      const row: ExpressionPreviewRow = { index, value: null, reason };
      previewRows.push(row);
      failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;
      failed += 1;
      firstFailure ??= row;
      continue;
    }
    previewRows.push({ index, value });
    evaluated += 1;
  }

  return {
    ok: true,
    validation,
    rows: previewRows,
    evaluated,
    failed,
    failureCounts,
    ...(firstFailure === undefined ? {} : { firstFailure }),
  };
}
