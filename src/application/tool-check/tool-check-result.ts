/**
 * application層: ツール検証の結果表現と、期待（expectations）の評価。
 *
 * 評価は**全行**（engine.preview の fullOutput）に対して行う。表示用スナップショットは
 * rowLimit で切られているので、そちらで数えると「100行しか無いのに 500 行のはず」の誤判定になる。
 *
 * `expected` / `actual` は英語の定型文で、UI が正規表現で日本語化する。文言を変えると
 * UI 側の対応表が外れるので、書式は src/ui/api/types.ts の「ツール検証」節と対で保守する。
 */
import type { Cell, Row, Table } from '../../domain/data/types';
import type { JsonCell, ToolCheckCellExpectation, ToolCheckCellOp, ToolCheckExpectations, ToolCheckJudgmentExpectation, ToolCheckOutcome, ToolCheckRowCountOp, ToolCheckRowExpectation, ToolCheckRowLocator, ToolCheckStatus } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckJudgmentTable } from './judgments';

export interface ToolCheckAssertion {
  readonly kind: 'rowCount' | 'column' | 'cell' | 'row' | 'judgment' | 'duration' | 'outcome';
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface ToolCheckToolRef {
  readonly internalId: string;
  readonly version: string;
  readonly publishName: string;
}

export interface ToolCheckRunError {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
}

export interface ToolCheckRunResult {
  readonly tool: ToolCheckToolRef;
  /** passed = 全期待合格、failed = 期待不合格あり、error = 実行自体が失敗。 */
  readonly status: ToolCheckStatus;
  readonly assertions: readonly ToolCheckAssertion[];
  /** 表示用スナップショット（rowLimit 行まで）。 */
  readonly output: Table;
  /** 実際の出力行数（全行）。 */
  readonly rowCount: number;
  readonly nodes: readonly { readonly nodeId: string; readonly rowCount: number }[];
  /**
   * AI 判定ノードごとの判定結果（入力行 + 判定列 + 理由列。表示用スナップショット）。
   * ai-judge ノードが無ければ省略する（従来の結果と同じ形）。
   */
  readonly judgments?: readonly ToolCheckJudgmentSnapshot[];
  /** 判定に使ったモデルの識別（provider/model）。judgments があるときだけ。 */
  readonly judgedBy?: string;
  readonly durationMs: number;
  readonly error?: ToolCheckRunError;
  readonly checkedAt: string;
}

/** 結果に載せる判定表（rowLimit 行までのスナップショット）。 */
export interface ToolCheckJudgmentSnapshot {
  readonly nodeId: string;
  readonly verdictColumn: string;
  readonly reasonColumn: string;
  readonly table: Table;
  readonly rowCount: number;
}

const OP_SYMBOLS: Record<ToolCheckCellOp, string> = { eq: '==', neq: '!=', gte: '>=', lte: '<=', contains: 'contains' };

export const EMPTY_TABLE: Table = { schema: { columns: [] }, rows: [] };

function compareRowCount(op: ToolCheckRowCountOp, actual: number, expected: number): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'gte': return actual >= expected;
    case 'lte': return actual <= expected;
  }
}

/** Date は ISO 文字列へ寄せてから比較する（JSON 経由で渡される期待値と同じ表現にする）。 */
function normalizeCell(cell: Cell | undefined): JsonCell {
  if (cell === undefined) return null;
  return cell instanceof Date ? cell.toISOString() : cell;
}

/**
 * 1セルが期待を満たすか。
 * - null セルは `eq null` にだけ一致する（「無い値」は不等号でも contains でも判定しない）。
 * - eq / neq は JSON 表現の一致で判定する（型違いの `1` と `"1"` は別物）。
 * - gte / lte は数値同士だけ（数値でないセルは不一致）。
 * - contains は文字列化した部分一致。
 */
export function cellMatches(cell: Cell | undefined, op: ToolCheckCellOp, value: JsonCell): boolean {
  const normalized = normalizeCell(cell);
  if (normalized === null) return op === 'eq' && value === null;
  switch (op) {
    case 'eq': return JSON.stringify(normalized) === JSON.stringify(value);
    case 'neq': return JSON.stringify(normalized) !== JSON.stringify(value);
    case 'gte': return typeof normalized === 'number' && typeof value === 'number' && normalized >= value;
    case 'lte': return typeof normalized === 'number' && typeof value === 'number' && normalized <= value;
    case 'contains': return String(normalized).includes(String(value));
  }
}

function evaluateCell(expectation: ToolCheckCellExpectation, output: Table): ToolCheckAssertion {
  const symbol = OP_SYMBOLS[expectation.op];
  const expected = `${expectation.mode === 'any' ? 'some row has' : 'every row has'} ${expectation.column} ${symbol} ${JSON.stringify(expectation.value)}`;
  if (!output.schema.columns.some((column) => column.name === expectation.column)) {
    return { kind: 'cell', passed: false, expected, actual: `column '${expectation.column}' not in output` };
  }
  const matched = output.rows.filter((row) => cellMatches(row[expectation.column], expectation.op, expectation.value)).length;
  const total = output.rows.length;
  const passed = expectation.mode === 'any' ? matched > 0 : matched === total;
  return { kind: 'cell', passed, expected, actual: `${matched} of ${total} rows match` };
}

/** `row[id == "E1"]` の書式。行の特定条件を定型文にする（UI の対応表と対）。 */
function describeLocator(where: ToolCheckRowLocator): string {
  return `${where.column} == ${JSON.stringify(where.value)}`;
}

/** 特定条件に最初に一致した行（列が無ければ undefined）。 */
function locateRow(where: ToolCheckRowLocator, table: Table): { readonly row: Row | undefined; readonly columnExists: boolean } {
  const columnExists = table.schema.columns.some((column) => column.name === where.column);
  if (!columnExists) return { row: undefined, columnExists };
  return { row: table.rows.find((row) => cellMatches(row[where.column], 'eq', where.value)), columnExists };
}

/**
 * 行を特定した期待。
 * - present:false → `row[<where>] absent` に対して actual `present` / `absent`。
 * - cells が無ければ存在だけ → `row[<where>] present`。
 * - cells は 1 セル 1 assertion → `row[<where>].<column> <op> <value>`、actual は実際の値（JSON）か `row not found`。
 */
function evaluateRow(expectation: ToolCheckRowExpectation, output: Table): readonly ToolCheckAssertion[] {
  const locator = describeLocator(expectation.where);
  const { row, columnExists } = locateRow(expectation.where, output);
  const presence = !columnExists ? `column '${expectation.where.column}' not in output` : row === undefined ? 'absent' : 'present';
  if (expectation.present === false) {
    return [{ kind: 'row', passed: columnExists && row === undefined, expected: `row[${locator}] absent`, actual: presence }];
  }
  const cells = expectation.cells ?? [];
  if (cells.length === 0) return [{ kind: 'row', passed: row !== undefined, expected: `row[${locator}] present`, actual: presence }];
  return cells.map((cell) => {
    const expected = `row[${locator}].${cell.column} ${OP_SYMBOLS[cell.op]} ${JSON.stringify(cell.value)}`;
    if (row === undefined) return { kind: 'row' as const, passed: false, expected, actual: 'row not found' };
    if (!output.schema.columns.some((column) => column.name === cell.column)) return { kind: 'row' as const, passed: false, expected, actual: `column '${cell.column}' not in output` };
    return { kind: 'row' as const, passed: cellMatches(row[cell.column], cell.op, cell.value), expected, actual: JSON.stringify(normalizeCell(row[cell.column])) };
  });
}

/**
 * AI 判定の期待。判定表（ノードの入力行 + 判定列 + 理由列）から行を特定して判定値を照合する。
 * - `judgment[<nodeId>][<where>] in [<verdicts>]` に対して actual `<verdict> (<reason>)`。
 * - reasonContains があれば `judgment[<nodeId>][<where>] reason contains <text>` を別 assertion で出す。
 * - ノードが無い / 判定が無い / 行が無いときは actual にその旨（`node not judged` / `row not found`）。
 */
function evaluateJudgment(expectation: ToolCheckJudgmentExpectation, judgments: readonly ToolCheckJudgmentTable[]): readonly ToolCheckAssertion[] {
  const locator = `judgment[${expectation.nodeId}][${describeLocator(expectation.where)}]`;
  const expectedVerdict = `${locator} in [${expectation.verdict.map((value) => JSON.stringify(value)).join(', ')}]`;
  const judgment = judgments.find((item) => item.nodeId === expectation.nodeId);
  const failAll = (actual: string): readonly ToolCheckAssertion[] => [
    { kind: 'judgment', passed: false, expected: expectedVerdict, actual },
    ...(expectation.reasonContains === undefined ? [] : [{ kind: 'judgment' as const, passed: false, expected: `${locator} reason contains ${JSON.stringify(expectation.reasonContains)}`, actual }]),
  ];
  if (judgment === undefined) return failAll(`node '${expectation.nodeId}' not judged`);
  const { row, columnExists } = locateRow(expectation.where, judgment.table);
  if (!columnExists) return failAll(`column '${expectation.where.column}' not in node input`);
  if (row === undefined) return failAll('row not found');
  const verdict = String(row[judgment.verdictColumn] ?? '');
  const reason = String(row[judgment.reasonColumn] ?? '');
  const assertions: ToolCheckAssertion[] = [{ kind: 'judgment', passed: expectation.verdict.includes(verdict), expected: expectedVerdict, actual: `${verdict} (${reason})` }];
  if (expectation.reasonContains !== undefined) {
    assertions.push({ kind: 'judgment', passed: reason.includes(expectation.reasonContains), expected: `${locator} reason contains ${JSON.stringify(expectation.reasonContains)}`, actual: JSON.stringify(reason) });
  }
  return assertions;
}

/** 期待を全行の出力と所要時間（と AI 判定表）に対して評価する。期待が無ければ空配列（＝合格）。 */
export function evaluateExpectations(expectations: ToolCheckExpectations | undefined, output: Table, durationMs: number, judgments: readonly ToolCheckJudgmentTable[] = []): readonly ToolCheckAssertion[] {
  if (expectations === undefined) return [];
  const assertions: ToolCheckAssertion[] = [];
  const rowCount = output.rows.length;
  if (expectations.rowCount !== undefined) {
    const { op, value } = expectations.rowCount;
    assertions.push({ kind: 'rowCount', passed: compareRowCount(op, rowCount, value), expected: `row count ${OP_SYMBOLS[op]} ${value}`, actual: `row count ${rowCount}` });
  }
  if (expectations.columns !== undefined) {
    const names = output.schema.columns.map((column) => column.name);
    const actual = names.length === 0 ? 'columns: (none)' : `columns: ${names.join(', ')}`;
    for (const column of expectations.columns) {
      assertions.push({ kind: 'column', passed: names.includes(column), expected: `column '${column}' exists`, actual });
    }
  }
  for (const cell of expectations.cells ?? []) assertions.push(evaluateCell(cell, output));
  for (const row of expectations.rows ?? []) assertions.push(...evaluateRow(row, output));
  for (const judgment of expectations.judgments ?? []) assertions.push(...evaluateJudgment(judgment, judgments));
  if (expectations.maxDurationMs !== undefined) {
    assertions.push({ kind: 'duration', passed: durationMs <= expectations.maxDurationMs, expected: `duration <= ${expectations.maxDurationMs}ms`, actual: `${durationMs}ms` });
  }
  return assertions;
}

/** 実行の結末（成功 / 失敗コード）を定型文にする。`outcome error (<code>)` の書式は UI の対応表と対。 */
function describeOutcome(actual: { readonly code: string } | undefined): string {
  return actual === undefined ? 'outcome success' : `outcome error (${actual.code})`;
}

/**
 * 結末（outcome）の期待を評価する。期待が省略されていれば assertion を出さない（従来どおり）。
 * `error` は「実行が失敗したときだけ返る」失敗情報で、undefined なら実行は成功している。
 */
export function evaluateOutcome(expected: ToolCheckOutcome | undefined, error: { readonly code: string } | undefined): ToolCheckAssertion | undefined {
  if (expected === undefined) return undefined;
  const actual = describeOutcome(error);
  const passed = expected === 'error' ? error !== undefined : error === undefined;
  return { kind: 'outcome', passed, expected: `outcome ${expected}`, actual };
}

/**
 * 実行が成功したときの assertion 一覧と status。
 * outcome: 'error' を期待していたのに成功した場合は failed だが、残りの期待も評価して
 * 「実際に何が起きたか」を見せる（結末の assertion が先頭）。
 */
export function evaluateSuccessfulRun(expectations: ToolCheckExpectations | undefined, output: Table, durationMs: number, judgments: readonly ToolCheckJudgmentTable[] = []): { readonly status: ToolCheckStatus; readonly assertions: readonly ToolCheckAssertion[] } {
  const outcome = evaluateOutcome(expectations?.outcome, undefined);
  const assertions = [...(outcome === undefined ? [] : [outcome]), ...evaluateExpectations(expectations, output, durationMs, judgments)];
  return { status: assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed', assertions };
}

/**
 * 実行が失敗したときの assertion 一覧と status。
 * - outcome: 'error' を期待していれば **passed**（異常系ケースの合格）。他の期待は評価しない（出力が無い）。
 * - outcome: 'success' を明示していれば error のまま、結末の不合格 assertion を添える。
 * - 省略時は従来どおり error・assertion なし。
 */
export function evaluateFailedRun(expectations: ToolCheckExpectations | undefined, error: ToolCheckRunError): { readonly status: ToolCheckStatus; readonly assertions: readonly ToolCheckAssertion[] } {
  const outcome = evaluateOutcome(expectations?.outcome, error);
  if (outcome === undefined) return { status: 'error', assertions: [] };
  return { status: outcome.passed ? 'passed' : 'error', assertions: [outcome] };
}

/**
 * 保存する要約（一覧で状態を一目で読むための1行）。
 * - `passed 3/3`
 * - `failed 1/3: row count == 3 → row count 5`（最初に落ちた期待）
 * - `error: <message>`
 * - `passed 1/1 (expected error: <message>)`（失敗すること自体が期待どおりだったケース）
 */
export function summarizeToolCheckResult(result: ToolCheckRunResult): string {
  if (result.status === 'error') return `error: ${result.error?.message ?? 'tool execution failed'}`;
  const total = result.assertions.length;
  const failed = result.assertions.filter((assertion) => !assertion.passed);
  if (failed.length === 0) {
    // 異常系ケース: 合格だが実行は失敗している。理由を要約に残すと一覧だけで「どう失敗したか」が読める。
    return result.error === undefined ? `passed ${total}/${total}` : `passed ${total}/${total} (expected error: ${result.error.message})`;
  }
  const first = failed[0]!;
  return `failed ${failed.length}/${total}: ${first.expected} → ${first.actual}`;
}
