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

/**
 * 診断の大分類。**直し方が同じものを 1 つにまとめる**ための軸。
 *
 * 種別は原因を細かく言い当てるが、利用者（と LLM）が取る行動は種別より粗い。
 * 列の指定ミスは `[列名]` で書いても裸で書いても「列名を直す」であり、
 * 種別が 3 つに分かれていること自体は差し戻しの材料にならない。
 */
export const EXPRESSION_DIAGNOSTIC_CATEGORIES = ['empty', 'syntax', 'function', 'column', 'type', 'limit'] as const;
export type ExpressionDiagnosticCategory = (typeof EXPRESSION_DIAGNOSTIC_CATEGORIES)[number];

const CATEGORY_BY_CODE: Readonly<Record<ExpressionDiagnosticCode, ExpressionDiagnosticCategory>> = {
  empty: 'empty',
  'too-long': 'limit',
  'too-many-tokens': 'limit',
  'too-deep': 'limit',
  'illegal-character': 'syntax',
  'invalid-number': 'syntax',
  'unclosed-bracket': 'syntax',
  'unexpected-bracket': 'syntax',
  'empty-column-name': 'column',
  'unknown-function': 'function',
  'function-needs-parens': 'function',
  // 裸の識別子の打ち間違いは、関数名の可能性もあるが大半は列名。直し方も列と同じ。
  'unknown-name': 'column',
  'wrong-argument-count': 'function',
  'missing-argument': 'function',
  'misplaced-comma': 'syntax',
  'unclosed-paren': 'syntax',
  'unexpected-paren': 'syntax',
  'missing-operand': 'syntax',
  'unexpected-end': 'syntax',
  'trailing-input': 'syntax',
  unreadable: 'syntax',
  'unknown-column': 'column',
  'type-coerced': 'type',
  'type-not-numeric': 'type',
};

/** 種別 → 大分類。知らない種別は `syntax` に寄せる（投げない）。 */
export function diagnosticCategory(code: ExpressionDiagnosticCode): ExpressionDiagnosticCategory {
  return CATEGORY_BY_CODE[code] ?? 'syntax';
}

/** 診断 1 件。 */
export interface ExpressionDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: ExpressionDiagnosticCode;
  /** 直し方が同じものをまとめた軸。差し戻しと画面の出し分けはこちらを見る。 */
  readonly category: ExpressionDiagnosticCategory;
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

/**
 * 失敗の読み替え。件数の表を見て人が推理しなくて済むようにする。
 *
 * 型の警告（`type-coerced`）は「寄せられるかもしれない」に留まり、それだけでは
 * 上流に型変換が要るかどうか決められない。実際の行を見て初めて「この列は数値にならない」と
 * 言い切れる。その判断をここで済ませる。
 */
export interface ExpressionPreviewDiagnosis {
  /** 見た行がすべて失敗した。式かデータのどちらかが根本的に合っていない合図。 */
  readonly allFailed: boolean;
  /** 最も多い失敗理由。失敗が無ければ入らない。 */
  readonly dominantReason?: CalculateFailureReason;
  /**
   * **実データで数値にできなかった列**（空でない値が 1 つも数値にならなかったもの）。
   * 型の警告と違い、上流に型変換が要ると言い切れる。出現順。
   */
  readonly notNumericColumns: readonly string[];
  /** 参照列のうち、見た行すべてが空だったもの。出現順。 */
  readonly allNullColumns: readonly string[];
  /** 次の一手（1 文）。差し戻しと画面の案内でそのまま使える。読み替えが要らなければ入らない。 */
  readonly nextStep?: string;
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
  /** 失敗の読み替え。行を 1 つも見ていないときも形は返る（すべて空・false）。 */
  readonly diagnosis: ExpressionPreviewDiagnosis;
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
/**
 * 診断を組み立てる唯一の口。分類は種別から必ず導くので、作る側が付け忘れられない。
 * 診断を作る場所は 4 か所に散っており、各所で手書きすると分類の付け漏れが起きる。
 */
function diagnostic(
  severity: 'error' | 'warning',
  code: ExpressionDiagnosticCode,
  message: string,
  extra: { readonly position?: number; readonly column?: string; readonly suggestion?: string } = {},
): ExpressionDiagnostic {
  return {
    severity,
    code,
    category: diagnosticCategory(code),
    message,
    ...(extra.position === undefined ? {} : { position: extra.position }),
    ...(extra.column === undefined ? {} : { column: extra.column }),
    ...(extra.suggestion === undefined ? {} : { suggestion: extra.suggestion }),
  };
}

function typeDiagnostic(column: Column): ExpressionDiagnostic | undefined {
  switch (column.type) {
    case 'number':
      return undefined;
    case 'string':
    case 'unknown':
    case 'null':
      return diagnostic(
        'warning',
        'type-coerced',
        `列 '${column.name}' は ${column.type} 型です。実行時に数値へ寄せます（数値にできない値は null）`,
        { column: column.name },
      );
    default:
      return diagnostic(
        'warning',
        'type-not-numeric',
        `列 '${column.name}' は ${column.type} 型です。数値にできないため実行時は null になります`,
        { column: column.name },
      );
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
    return emptyValidation(diagnostic('error', 'empty', '式を入力してください'));
  }

  const input = safeSchema(schema);
  const known = columnNames(input);

  const parsed = parseExpression(text, known);
  if (!parsed.ok) {
    // 読めない式では列の検査をしない。構文が崩れている間の参照列は当てにならず、
    // 本当の原因（構文）より後ろの話で画面を埋めてしまう。
    return emptyValidation(diagnostic('error', parsed.code, parsed.message, {
      position: parsed.position,
      ...(parsed.suggestion === undefined ? {} : { suggestion: parsed.suggestion }),
    }));
  }

  const diagnostics: ExpressionDiagnostic[] = [];
  const unknownColumns: string[] = [];
  for (const reference of parsed.references) {
    const column = findColumn(input, reference);
    if (column === undefined) {
      const suggestion = suggestName(reference, known);
      unknownColumns.push(reference);
      diagnostics.push(diagnostic('error', 'unknown-column', `式が参照する列がありません: ${reference}`, {
        column: reference,
        ...(suggestion === undefined ? {} : { suggestion }),
      }));
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

const EMPTY_DIAGNOSIS: ExpressionPreviewDiagnosis = { allFailed: false, notNumericColumns: [], allNullColumns: [] };

function noRows(validation: ExpressionValidation): ExpressionPreview {
  return { ok: false, validation, rows: [], evaluated: 0, failed: 0, failureCounts: {}, diagnosis: EMPTY_DIAGNOSIS };
}

/** 参照列 1 つぶんの、実データの内訳。 */
interface ColumnTally {
  /** 数値として使えた値の数。 */
  numeric: number;
  /** 空でないのに数値にできなかった値の数。 */
  notNumeric: number;
  /** 空（null / undefined / 空文字）の数。 */
  empty: number;
}

/** 最も多い失敗理由。同数なら `failureCounts` に先に入った方（評価の順）を採る。 */
function dominantReasonOf(counts: Readonly<Partial<Record<CalculateFailureReason, number>>>): CalculateFailureReason | undefined {
  let best: CalculateFailureReason | undefined;
  let bestCount = 0;
  for (const [reason, count] of Object.entries(counts) as [CalculateFailureReason, number][]) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 件数の表を読み替えて、次の一手を 1 文にする。
 *
 * 型の警告だけでは「寄せられるかもしれない」に留まる。実データで 1 つも数値にならなかった列が
 * あって初めて「上流に型変換が要る」と言い切れるので、その判断をここで済ませる
 * （利用者にも LLM にも、件数の表から推理させない）。
 */
function diagnoseFailures(
  tallies: ReadonlyMap<string, ColumnTally>,
  seen: number,
  failed: number,
  counts: Readonly<Partial<Record<CalculateFailureReason, number>>>,
): ExpressionPreviewDiagnosis {
  const notNumericColumns: string[] = [];
  const allNullColumns: string[] = [];
  for (const [column, tally] of tallies) {
    if (tally.numeric === 0 && tally.notNumeric > 0) notNumericColumns.push(column);
    else if (tally.numeric === 0 && tally.empty > 0) allNullColumns.push(column);
  }

  const allFailed = seen > 0 && failed === seen;
  const dominantReason = dominantReasonOf(counts);

  const base: ExpressionPreviewDiagnosis = {
    allFailed,
    ...(dominantReason === undefined ? {} : { dominantReason }),
    notNumericColumns,
    allNullColumns,
  };
  if (failed === 0) return base;

  // 言い切れる順に見る。型変換が要るなら、それが根本原因で他は結果にすぎない。
  if (notNumericColumns.length > 0) {
    return { ...base, nextStep: `列 ${notNumericColumns.join(' / ')} の値を数値にできません。上流に型変換（cast）を入れてください。` };
  }
  if (allNullColumns.length > 0) {
    return { ...base, nextStep: `列 ${allNullColumns.join(' / ')} は見た行がすべて空です。上流の null 処理で既定値を入れるか、参照する列を見直してください。` };
  }
  if (allFailed && dominantReason === 'divide-by-zero') {
    return { ...base, nextStep: '見た行すべてで 0 で割っています。分母の列を見直すか、0 の行を上流の行フィルターで除いてください。' };
  }
  if (allFailed && dominantReason === 'domain-error') {
    return { ...base, nextStep: '見た行すべてが関数の定義域の外です。式を見直してください。' };
  }
  return base;
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

  // 参照列ごとに実データの内訳を数える。型の警告だけでは上流の型変換が要るか決められないので、
  // 実際の値を見て「1 つも数値にならなかった列」を特定する（その判断は diagnoseFailures が使う）。
  const tallies = new Map<string, ColumnTally>();
  for (const reference of validation.references) tallies.set(reference, { numeric: 0, notNumeric: 0, empty: 0 });

  for (let index = 0; index < source.length && previewRows.length < limit; index += 1) {
    const row = source[index] ?? {};
    for (const [column, tally] of tallies) {
      const cell = row[column] ?? null;
      if (cell === null || cell === '') tally.empty += 1;
      else if (toCalculationNumber(cell) === null) tally.notNumeric += 1;
      else tally.numeric += 1;
    }
    // 入力の行は読むだけ（配列もオブジェクトも複製せず、書き換えもしない）。
    const outcome = evaluateExpressionDetailed(parsed.ast, rowLookup(row));
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
    diagnosis: diagnoseFailures(tallies, previewRows.length, failed, failureCounts),
  };
}
