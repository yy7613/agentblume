/**
 * ドメイン: ツール検証ケース（ToolCheckCase）集約。
 *
 * 保存済み Tool を「Agent が渡すのと同じ引数」で単体実行し、期待（行数・列・セル値・所要時間）
 * との合否を出すための定義。ケースは版を持たず id で上書きする。直近の実行結果は要約だけを
 * `lastResult` として持ち、出力テーブルそのものは保存しない（再実行すれば得られる）。
 *
 * 引数は JSON セル（string / number / boolean / null）に限る。Agent の function calling が
 * 渡せる値と同じ集合で、Date は文字列として渡し実行側（validateToolArguments）が解釈する。
 */
import { assertNonEmpty } from '../shared/assert';
import type { ErrorFactory } from '../shared/errors';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import type { ToolId } from '../tool/ids';
import { SemVer } from '../tool/semver';
import { ToolCheckValidationError } from './errors';

/** Agent 引数・セル期待値として扱える JSON セル。 */
export type JsonCell = string | number | boolean | null;

export const TOOL_CHECK_ROW_COUNT_OPS = ['eq', 'gte', 'lte'] as const;
export type ToolCheckRowCountOp = (typeof TOOL_CHECK_ROW_COUNT_OPS)[number];

export const TOOL_CHECK_CELL_OPS = ['eq', 'neq', 'gte', 'lte', 'contains'] as const;
export type ToolCheckCellOp = (typeof TOOL_CHECK_CELL_OPS)[number];

export const TOOL_CHECK_CELL_MODES = ['any', 'all'] as const;
export type ToolCheckCellMode = (typeof TOOL_CHECK_CELL_MODES)[number];

export const TOOL_CHECK_STATUSES = ['passed', 'failed', 'error'] as const;
export type ToolCheckStatus = (typeof TOOL_CHECK_STATUSES)[number];

/**
 * 実行の結末への期待。'error' は「引数不正やノードエラーで失敗すること」自体を期待する（異常系ケース）。
 * 省略時と 'success' は実行が成功したうえで他の期待を評価する。
 */
export const TOOL_CHECK_OUTCOMES = ['success', 'error'] as const;
export type ToolCheckOutcome = (typeof TOOL_CHECK_OUTCOMES)[number];

/** セル値の期待。mode: any = 1行でも満たせば合格、all = 全行が満たす必要あり。 */
export interface ToolCheckCellExpectation {
  readonly column: string;
  readonly op: ToolCheckCellOp;
  readonly value: JsonCell;
  readonly mode: ToolCheckCellMode;
}

/** 行の特定条件（`column == value` に最初に一致した行）。 */
export interface ToolCheckRowLocator {
  readonly column: string;
  readonly value: JsonCell;
}

/** 特定した 1 行のセルへの期待（mode は無い: 特定した行だけを見る）。 */
export interface ToolCheckRowCellExpectation {
  readonly column: string;
  readonly op: ToolCheckCellOp;
  readonly value: JsonCell;
}

/**
 * 終端出力の 1 行を特定して検証する期待。
 * 「id が E1 の行が残り、金額 >= 10000」「id が E2 の行は無い」のように書く。
 */
export interface ToolCheckRowExpectation {
  readonly where: ToolCheckRowLocator;
  /** false なら「その行が無い」ことを期待する（cells は評価しない）。既定 true。 */
  readonly present?: boolean;
  readonly cells?: readonly ToolCheckRowCellExpectation[];
}

/**
 * AI 判定ノード（`ai-judge`）の判定を、そのノードの**入力行**を特定して検証する期待。
 * 終端出力ではなくノードの判定結果を見るので、keep / exclude で行が消えても「E2 は no と判定された」を確かめられる。
 */
export interface ToolCheckJudgmentExpectation {
  readonly nodeId: string;
  readonly where: ToolCheckRowLocator;
  /** 期待する判定値。いずれかに一致すれば合格（AI の揺れを許容するため複数書ける）。 */
  readonly verdict: readonly string[];
  /** 理由に含まれるべき文字列（任意）。 */
  readonly reasonContains?: string;
}

export interface ToolCheckExpectations {
  /** 出力行数（全行数。表示上限に依存しない）。 */
  readonly rowCount?: { readonly op: ToolCheckRowCountOp; readonly value: number };
  /** 出力スキーマに含まれるべき列名。 */
  readonly columns?: readonly string[];
  readonly cells?: readonly ToolCheckCellExpectation[];
  /** 終端出力の行を特定した期待。 */
  readonly rows?: readonly ToolCheckRowExpectation[];
  /** AI 判定ノードの判定への期待。 */
  readonly judgments?: readonly ToolCheckJudgmentExpectation[];
  /** 実行時間の上限（ms）。 */
  readonly maxDurationMs?: number;
  /** 実行の結末（省略時は 'success' と同じ扱いだが、明示したときだけ結末の assertion が出る）。 */
  readonly outcome?: ToolCheckOutcome;
}

/** 直近の実行結果の要約。 */
export interface ToolCheckLastResult {
  readonly status: ToolCheckStatus;
  readonly checkedAt: IsoDateTime;
  /** 実際に実行した Tool の版（最新版を追うケースでは実行時点の版）。 */
  readonly toolVersion: string;
  readonly summary: string;
}

export interface ToolCheckCase {
  readonly scope: TenantScope;
  readonly id: string;
  readonly toolId: ToolId;
  /** 固定する版。省略時は実行時点の最新版。 */
  readonly toolVersion?: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonCell>>;
  readonly expectations: ToolCheckExpectations;
  readonly lastResult?: ToolCheckLastResult;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreateToolCheckCaseProps {
  readonly scope: TenantScope;
  /** 省略時は `makeId` で生成する。 */
  readonly id?: string;
  readonly toolId: string;
  readonly toolVersion?: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonCell>>;
  readonly expectations: ToolCheckExpectations;
  readonly lastResult?: ToolCheckLastResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const TOOL_CHECK_NAME_MAX_LENGTH = 120;
export const TOOL_CHECK_MAX_COLUMNS = 50;
export const TOOL_CHECK_MAX_CELLS = 50;
export const TOOL_CHECK_MAX_ROWS = 50;
export const TOOL_CHECK_MAX_ROW_CELLS = 20;
export const TOOL_CHECK_MAX_JUDGMENTS = 100;
export const TOOL_CHECK_MAX_VERDICTS = 21;
/** 所要時間上限の最大値（10分）。モデルのタイムアウト既定（LM_STUDIO_TIMEOUT_MS）と同じ桁に揃える。 */
export const TOOL_CHECK_MAX_DURATION_MS = 600_000;

const fail: ErrorFactory = (message) => new ToolCheckValidationError(message);

function isJsonCell(value: unknown): value is JsonCell {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function validateArguments(value: unknown): Readonly<Record<string, JsonCell>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('createToolCheckCase: arguments must be an object');
  }
  const copy: Record<string, JsonCell> = {};
  for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim().length === 0) throw fail('createToolCheckCase: argument names must be non-empty strings');
    if (!isJsonCell(cell)) throw fail(`createToolCheckCase: argument '${key}' must be a string, number, boolean or null`);
    copy[key] = cell;
  }
  return copy;
}

/**
 * 期待（expectations）だけを検証して正規化する。集約の組み立て（createToolCheckCase）と、
 * LLM が提案した期待を1件ずつ検証して不正なものだけ落とす用途（suggest-tool-check-cases）が共有する。
 * エラーメッセージの接頭辞は createToolCheckCase のままにしてある（保存時の 400 の文言を変えないため）。
 */
export function validateToolCheckExpectations(value: unknown): ToolCheckExpectations {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('createToolCheckCase: expectations must be an object');
  }
  const input = value as ToolCheckExpectations;
  const result: { -readonly [K in keyof ToolCheckExpectations]: ToolCheckExpectations[K] } = {};

  if (input.rowCount !== undefined) {
    const { op, value: count } = input.rowCount;
    if (!TOOL_CHECK_ROW_COUNT_OPS.includes(op)) throw fail(`createToolCheckCase: expectations.rowCount.op must be one of ${TOOL_CHECK_ROW_COUNT_OPS.join(', ')}`);
    if (!Number.isInteger(count) || count < 0) throw fail('createToolCheckCase: expectations.rowCount.value must be a non-negative integer');
    result.rowCount = { op, value: count };
  }

  if (input.columns !== undefined) {
    if (!Array.isArray(input.columns)) throw fail('createToolCheckCase: expectations.columns must be an array');
    if (input.columns.length > TOOL_CHECK_MAX_COLUMNS) throw fail(`createToolCheckCase: expectations.columns must have at most ${TOOL_CHECK_MAX_COLUMNS} entries`);
    const seen = new Set<string>();
    for (const column of input.columns) {
      assertNonEmpty(column, 'createToolCheckCase: expectations.columns[]', fail);
      if (seen.has(column)) throw fail(`createToolCheckCase: expectations.columns contains a duplicate: ${column}`);
      seen.add(column);
    }
    result.columns = [...input.columns];
  }

  if (input.cells !== undefined) {
    if (!Array.isArray(input.cells)) throw fail('createToolCheckCase: expectations.cells must be an array');
    if (input.cells.length > TOOL_CHECK_MAX_CELLS) throw fail(`createToolCheckCase: expectations.cells must have at most ${TOOL_CHECK_MAX_CELLS} entries`);
    result.cells = input.cells.map((cell, index) => {
      assertNonEmpty(cell?.column, `createToolCheckCase: expectations.cells[${index}].column`, fail);
      if (!TOOL_CHECK_CELL_OPS.includes(cell.op)) throw fail(`createToolCheckCase: expectations.cells[${index}].op must be one of ${TOOL_CHECK_CELL_OPS.join(', ')}`);
      if (!TOOL_CHECK_CELL_MODES.includes(cell.mode)) throw fail(`createToolCheckCase: expectations.cells[${index}].mode must be one of ${TOOL_CHECK_CELL_MODES.join(', ')}`);
      if (!isJsonCell(cell.value)) throw fail(`createToolCheckCase: expectations.cells[${index}].value must be a string, number, boolean or null`);
      return { column: cell.column, op: cell.op, value: cell.value, mode: cell.mode };
    });
  }

  if (input.rows !== undefined) {
    if (!Array.isArray(input.rows)) throw fail('createToolCheckCase: expectations.rows must be an array');
    if (input.rows.length > TOOL_CHECK_MAX_ROWS) throw fail(`createToolCheckCase: expectations.rows must have at most ${TOOL_CHECK_MAX_ROWS} entries`);
    result.rows = input.rows.map((row, index) => {
      const where = validateLocator(row?.where, `createToolCheckCase: expectations.rows[${index}].where`);
      if (row.present !== undefined && typeof row.present !== 'boolean') throw fail(`createToolCheckCase: expectations.rows[${index}].present must be a boolean`);
      let cells: ToolCheckRowCellExpectation[] | undefined;
      if (row.cells !== undefined) {
        if (!Array.isArray(row.cells)) throw fail(`createToolCheckCase: expectations.rows[${index}].cells must be an array`);
        if (row.cells.length > TOOL_CHECK_MAX_ROW_CELLS) throw fail(`createToolCheckCase: expectations.rows[${index}].cells must have at most ${TOOL_CHECK_MAX_ROW_CELLS} entries`);
        cells = row.cells.map((cell: ToolCheckRowCellExpectation, cellIndex: number) => {
          const prefix = `createToolCheckCase: expectations.rows[${index}].cells[${cellIndex}]`;
          assertNonEmpty(cell?.column, `${prefix}.column`, fail);
          if (!TOOL_CHECK_CELL_OPS.includes(cell.op)) throw fail(`${prefix}.op must be one of ${TOOL_CHECK_CELL_OPS.join(', ')}`);
          if (!isJsonCell(cell.value)) throw fail(`${prefix}.value must be a string, number, boolean or null`);
          return { column: cell.column, op: cell.op, value: cell.value };
        });
      }
      return { where, ...(row.present === undefined ? {} : { present: row.present }), ...(cells === undefined ? {} : { cells }) };
    });
  }

  if (input.judgments !== undefined) {
    if (!Array.isArray(input.judgments)) throw fail('createToolCheckCase: expectations.judgments must be an array');
    if (input.judgments.length > TOOL_CHECK_MAX_JUDGMENTS) throw fail(`createToolCheckCase: expectations.judgments must have at most ${TOOL_CHECK_MAX_JUDGMENTS} entries`);
    result.judgments = input.judgments.map((judgment, index) => {
      const prefix = `createToolCheckCase: expectations.judgments[${index}]`;
      assertNonEmpty(judgment?.nodeId, `${prefix}.nodeId`, fail);
      const where = validateLocator(judgment.where, `${prefix}.where`);
      if (!Array.isArray(judgment.verdict) || judgment.verdict.length === 0) throw fail(`${prefix}.verdict must be a non-empty array of strings`);
      if (judgment.verdict.length > TOOL_CHECK_MAX_VERDICTS) throw fail(`${prefix}.verdict must have at most ${TOOL_CHECK_MAX_VERDICTS} entries`);
      for (const value of judgment.verdict) assertNonEmpty(value, `${prefix}.verdict[]`, fail);
      if (judgment.reasonContains !== undefined && (typeof judgment.reasonContains !== 'string' || judgment.reasonContains === '')) throw fail(`${prefix}.reasonContains must be a non-empty string`);
      return { nodeId: judgment.nodeId, where, verdict: [...judgment.verdict], ...(judgment.reasonContains === undefined ? {} : { reasonContains: judgment.reasonContains }) };
    });
  }

  if (input.maxDurationMs !== undefined) {
    const max = input.maxDurationMs;
    if (!Number.isInteger(max) || max <= 0 || max > TOOL_CHECK_MAX_DURATION_MS) {
      throw fail(`createToolCheckCase: expectations.maxDurationMs must be a positive integer up to ${TOOL_CHECK_MAX_DURATION_MS}`);
    }
    result.maxDurationMs = max;
  }

  if (input.outcome !== undefined) {
    if (!TOOL_CHECK_OUTCOMES.includes(input.outcome)) throw fail(`createToolCheckCase: expectations.outcome must be one of ${TOOL_CHECK_OUTCOMES.join(', ')}`);
    result.outcome = input.outcome;
  }
  return result;
}

function validateLocator(value: ToolCheckRowLocator | undefined, prefix: string): ToolCheckRowLocator {
  if (value === null || typeof value !== 'object') throw fail(`${prefix} must be an object with column and value`);
  assertNonEmpty(value.column, `${prefix}.column`, fail);
  if (!isJsonCell(value.value)) throw fail(`${prefix}.value must be a string, number, boolean or null`);
  return { column: value.column, value: value.value };
}

function validateLastResult(value: ToolCheckLastResult): ToolCheckLastResult {
  if (!TOOL_CHECK_STATUSES.includes(value.status)) throw fail(`createToolCheckCase: lastResult.status must be one of ${TOOL_CHECK_STATUSES.join(', ')}`);
  assertIsoDateTime(value.checkedAt, 'createToolCheckCase: lastResult.checkedAt', fail);
  if (typeof value.toolVersion !== 'string') throw fail('createToolCheckCase: lastResult.toolVersion must be a string');
  if (typeof value.summary !== 'string') throw fail('createToolCheckCase: lastResult.summary must be a string');
  return { status: value.status, checkedAt: value.checkedAt, toolVersion: value.toolVersion, summary: value.summary };
}

/**
 * 検証ケースを組み立てて不変条件を検証する。
 * `id` が無いときは `makeId` で生成する（呼び出し側が乱数生成を注入する。domain は乱数を持たない）。
 */
export function createToolCheckCase(props: CreateToolCheckCaseProps, makeId?: () => string): ToolCheckCase {
  if (props === null || typeof props !== 'object') throw fail('createToolCheckCase: props are required');
  if (props.scope === null || typeof props.scope !== 'object') throw fail('createToolCheckCase: scope is required');
  assertNonEmpty(props.scope.tenantId, 'createToolCheckCase: scope.tenantId', fail);
  assertNonEmpty(props.scope.workspaceId, 'createToolCheckCase: scope.workspaceId', fail);

  const id = props.id ?? makeId?.();
  assertNonEmpty(id, 'createToolCheckCase: id', fail);
  assertNonEmpty(props.toolId, 'createToolCheckCase: toolId', fail);
  assertNonEmpty(props.name, 'createToolCheckCase: name', fail);
  const name = props.name.trim();
  if (name.length > TOOL_CHECK_NAME_MAX_LENGTH) throw fail(`createToolCheckCase: name must be at most ${TOOL_CHECK_NAME_MAX_LENGTH} characters`);

  if (props.toolVersion !== undefined) {
    try { SemVer.parse(props.toolVersion); } catch { throw fail(`createToolCheckCase: toolVersion must be a valid SemVer: ${String(props.toolVersion)}`); }
  }
  assertIsoDateTime(props.createdAt, 'createToolCheckCase: createdAt', fail);
  assertIsoDateTime(props.updatedAt, 'createToolCheckCase: updatedAt', fail);

  return {
    scope: { tenantId: props.scope.tenantId, workspaceId: props.scope.workspaceId },
    id,
    toolId: props.toolId,
    ...(props.toolVersion === undefined ? {} : { toolVersion: props.toolVersion }),
    name,
    arguments: validateArguments(props.arguments),
    expectations: validateToolCheckExpectations(props.expectations),
    ...(props.lastResult === undefined ? {} : { lastResult: validateLastResult(props.lastResult) }),
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/**
 * 直近の実行結果を差し替える。`updatedAt` は**変えない**: それは定義（名前・引数・期待）の
 * 更新時刻であり、一覧の並び順に使う。実行しただけでケースが一覧の先頭へ動くのは紛らわしい。
 */
export function withToolCheckLastResult(item: ToolCheckCase, lastResult: ToolCheckLastResult): ToolCheckCase {
  return { ...item, lastResult: validateLastResult(lastResult) };
}
