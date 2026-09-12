import type {
  ColumnDto, DataType, JsonCell, RunToolCheckDto, SchemaDto, SuggestToolCheckCasesDto, ToolCheckAssertionResultDto, ToolCheckCaseCategoryDto, ToolCheckCaseDto,
  ToolCheckCellOpDto, ToolCheckExpectationsDto, ToolCheckRunResultDto, ToolCheckSuggestionDto,
} from '../api/types';

/**
 * ツール検証画面の純粋ロジック。React から切り離し、引数の型変換・期待の組み立て・
 * 未保存判定を単体テストで固定する。画面（ToolCheckPage）は状態の保持と描画だけを担う。
 */

/** 引数1つの入力欄の状態。raw は入力欄の文字列、isNull は「未指定(null)」トグル。 */
export interface ArgumentDraft { readonly raw: string; readonly isNull: boolean }
export type ArgumentDrafts = Readonly<Record<string, ArgumentDraft>>;

export const EMPTY_DRAFT: ArgumentDraft = { raw: '', isNull: false };

/** 表示用スナップショットの上限行数。サーバーの既定と同じ値を明示して送る（DTO の固定化のため）。 */
export const ROW_LIMIT = 100;

/**
 * 入力スキーマから初期の下書きを作る。boolean は select（true/false）なので既定を 'false' にし、
 * それ以外は空欄（=未指定）から始める。
 */
export function initialDrafts(schema: SchemaDto | undefined): ArgumentDrafts {
  const drafts: Record<string, ArgumentDraft> = {};
  for (const column of schema?.columns ?? []) drafts[column.name] = column.type === 'boolean' ? { raw: 'false', isNull: false } : EMPTY_DRAFT;
  return drafts;
}

/** 保存済みケースの引数を入力欄の状態へ戻す（null は「未指定(null)」トグルとして復元する）。 */
export function draftsFromArguments(args: Readonly<Record<string, JsonCell>>, schema: SchemaDto | undefined): ArgumentDrafts {
  const drafts: Record<string, ArgumentDraft> = { ...initialDrafts(schema) };
  for (const [name, value] of Object.entries(args)) {
    drafts[name] = value === null ? { raw: '', isNull: true } : { raw: String(value), isNull: false };
  }
  return drafts;
}

/**
 * 入力欄の文字列を列の型へ変換して送信用の引数にする。
 * - 「未指定(null)」トグルが入っていれば null
 * - 空欄はキーごと送らない（必須かどうかの判定はサーバーに任せ、TOOL_ARGUMENTS の返答で該当欄を示す）
 * - number は数値、boolean は真偽値、date / string は文字列のまま
 * 数値欄に数値でない文字列が入っている場合は変換せず、argumentIssues が事前に弾く。
 */
export function buildArguments(schema: SchemaDto | undefined, drafts: ArgumentDrafts): Record<string, JsonCell> {
  const args: Record<string, JsonCell> = {};
  for (const column of schema?.columns ?? []) {
    const draft = drafts[column.name] ?? EMPTY_DRAFT;
    if (draft.isNull) { args[column.name] = null; continue; }
    const raw = draft.raw.trim();
    if (raw === '') continue;
    args[column.name] = coerceCell(raw, column.type);
  }
  return args;
}

/** 文字列を型に合わせて JsonCell に変換する。型が不明なら「数値に見えれば数値、true/false は真偽値、null は null」。 */
export function coerceCell(raw: string, type: DataType | undefined): JsonCell {
  if (type === 'number') { const parsed = Number(raw); return Number.isFinite(parsed) ? parsed : raw; }
  if (type === 'boolean') return raw === 'true';
  if (type === 'string' || type === 'date') return raw;
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const parsed = Number(raw);
  return raw !== '' && Number.isFinite(parsed) ? parsed : raw;
}

/** 送信前に分かる引数の不備（数値欄に数値でない文字列）。列名 → 文言キー。 */
export function argumentIssues(schema: SchemaDto | undefined, drafts: ArgumentDrafts): Readonly<Record<string, 'not-a-number'>> {
  const issues: Record<string, 'not-a-number'> = {};
  for (const column of schema?.columns ?? []) {
    const draft = drafts[column.name] ?? EMPTY_DRAFT;
    if (draft.isNull || column.type !== 'number') continue;
    const raw = draft.raw.trim();
    if (raw !== '' && !Number.isFinite(Number(raw))) issues[column.name] = 'not-a-number';
  }
  return issues;
}

/**
 * TOOL_ARGUMENTS の生メッセージから、直すべき引数欄の名前を取り出す。
 * サーバーの定型文（required argument missing: x / invalid argument 'x': … / unknown argument(s): x, y）を
 * 優先し、形が違うときは列名が本文に語として現れるものを拾う。
 */
export function argumentNamesInMessage(message: string, columnNames: readonly string[]): readonly string[] {
  const shaped = /^required argument missing: (.+)$/.exec(message) ?? /^invalid argument '(.+?)':/.exec(message) ?? /^unknown argument\(s\): (.+)$/.exec(message);
  if (shaped !== null) return (shaped[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
  return columnNames.filter((name) => new RegExp(`(^|[^\\w])${escapeRegExp(name)}($|[^\\w])`).test(message));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 期待（expectations）
// ---------------------------------------------------------------------------

export type RowCountOp = 'eq' | 'gte' | 'lte';
export type CellMode = 'any' | 'all';
/** 実行の結末の選択。'' = 指定なし（DTO に載せない）。'error' は「失敗すること」が期待（異常系ケース）。 */
export type OutcomeChoice = '' | 'success' | 'error';
export interface CellDraft { readonly column: string; readonly op: ToolCheckCellOpDto; readonly value: string; readonly mode: CellMode }
export interface ExpectationDraft {
  readonly rowCountOp: RowCountOp;
  /** 空欄 = 期待しない。'0' は 0 行を期待する（空欄と区別する）。 */
  readonly rowCountValue: string;
  readonly columns: readonly string[];
  readonly cells: readonly CellDraft[];
  readonly maxDurationMs: string;
  readonly outcome: OutcomeChoice;
}

export const EMPTY_EXPECTATIONS: ExpectationDraft = { rowCountOp: 'eq', rowCountValue: '', columns: [], cells: [], maxDurationMs: '', outcome: '' };
export const EMPTY_CELL: CellDraft = { column: '', op: 'eq', value: '', mode: 'any' };

export const CELL_OPS: readonly ToolCheckCellOpDto[] = ['eq', 'neq', 'gte', 'lte', 'contains'];
export const ROW_COUNT_OPS: readonly RowCountOp[] = ['eq', 'gte', 'lte'];

/**
 * 入力欄の下書きから送信用の期待を作る。埋まっている項目だけを含め、何も無ければ undefined
 * （DTO に空オブジェクトを載せない）。列名が空のセル条件は未完成として除く。
 */
export function buildExpectations(draft: ExpectationDraft, outputSchema: SchemaDto | undefined): ToolCheckExpectationsDto | undefined {
  const result: { -readonly [K in keyof ToolCheckExpectationsDto]: ToolCheckExpectationsDto[K] } = {};
  const rowCount = parseNonNegativeInteger(draft.rowCountValue);
  if (rowCount !== undefined) result.rowCount = { op: draft.rowCountOp, value: rowCount };
  const columns = draft.columns.map((name) => name.trim()).filter((name) => name !== '');
  if (columns.length > 0) result.columns = columns;
  const cells = draft.cells
    .filter((cell) => cell.column.trim() !== '')
    .map((cell) => ({ column: cell.column.trim(), op: cell.op, value: coerceCell(cell.value, columnType(outputSchema, cell.column.trim())), mode: cell.mode }));
  if (cells.length > 0) result.cells = cells;
  const maxDuration = parseNonNegativeInteger(draft.maxDurationMs);
  if (maxDuration !== undefined) result.maxDurationMs = maxDuration;
  // 「指定なし」は省略する。'success' も明示された選択なので送る（サーバーは省略時と同じ扱いだが、保存したケースに意図が残る）。
  if (draft.outcome !== '') result.outcome = draft.outcome;
  return Object.keys(result).length === 0 ? undefined : result;
}

/** 保存済みケースの期待を入力欄の状態へ戻す。 */
export function draftFromExpectations(expectations: ToolCheckExpectationsDto): ExpectationDraft {
  return {
    rowCountOp: expectations.rowCount?.op ?? 'eq',
    rowCountValue: expectations.rowCount === undefined ? '' : String(expectations.rowCount.value),
    columns: [...(expectations.columns ?? [])],
    cells: (expectations.cells ?? []).map((cell) => ({ column: cell.column, op: cell.op, value: cell.value === null ? 'null' : String(cell.value), mode: cell.mode })),
    maxDurationMs: expectations.maxDurationMs === undefined ? '' : String(expectations.maxDurationMs),
    outcome: expectations.outcome ?? '',
  };
}

function parseNonNegativeInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function columnType(schema: SchemaDto | undefined, name: string): DataType | undefined {
  return schema?.columns.find((column) => column.name === name)?.type;
}

// ---------------------------------------------------------------------------
// 送信 DTO と未保存判定
// ---------------------------------------------------------------------------

export interface EditorState {
  readonly toolId: string;
  /** '' = 最新版。 */
  readonly version: string;
  readonly caseName: string;
  readonly drafts: ArgumentDrafts;
  readonly expectations: ExpectationDraft;
}

export function buildRunDto(state: EditorState, scope: RunToolCheckDto['scope'], inputSchema: SchemaDto | undefined, outputSchema: SchemaDto | undefined): RunToolCheckDto {
  const expectations = buildExpectations(state.expectations, outputSchema);
  return {
    scope,
    toolId: state.toolId,
    ...(state.version === '' ? {} : { version: state.version }),
    arguments: buildArguments(inputSchema, state.drafts),
    ...(expectations === undefined ? {} : { expectations }),
    rowLimit: ROW_LIMIT,
  };
}

/** 未保存判定に使う安定した文字列表現（キー順を揃える）。 */
export function editorFingerprint(state: EditorState): string {
  const drafts = Object.keys(state.drafts).sort().map((name) => [name, state.drafts[name]]);
  return JSON.stringify({ toolId: state.toolId, version: state.version, caseName: state.caseName, drafts, expectations: state.expectations });
}

/** 保存済みケースをエディタの状態に展開する。 */
export function editorFromCase(item: ToolCheckCaseDto, inputSchema: SchemaDto | undefined): EditorState {
  return {
    toolId: item.toolId,
    version: item.toolVersion ?? '',
    caseName: item.name,
    drafts: draftsFromArguments(item.arguments, inputSchema),
    expectations: draftFromExpectations(item.expectations),
  };
}

// ---------------------------------------------------------------------------
// 表示用ラベル
// ---------------------------------------------------------------------------

export type ResultStatus = ToolCheckRunResultDto['status'];

export function statusLabel(status: ResultStatus | undefined): readonly [en: string, ja: string] {
  if (status === 'passed') return ['Passed', '合格'];
  if (status === 'failed') return ['Failed', '不合格'];
  if (status === 'error') return ['Error', 'エラー'];
  return ['Not run', '未実行'];
}

export function assertionKindLabel(kind: ToolCheckAssertionResultDto['kind']): readonly [en: string, ja: string] {
  if (kind === 'rowCount') return ['Row count', '行数'];
  if (kind === 'column') return ['Column', '列'];
  if (kind === 'cell') return ['Cell value', 'セル条件'];
  if (kind === 'outcome') return ['Outcome', '実行の結末'];
  return ['Duration', '所要時間'];
}

/**
 * 「失敗することが期待で、実際に失敗したので合格」の結果か。
 * サーバーは outcome = 'error' の期待が満たされたとき status = 'passed' のまま error を埋めて返す。
 * この場合の error は「直すべき失敗」ではなく「期待どおりの失敗」なので、直すボタンを出さず情報として見せる。
 */
export function isExpectedFailure(result: ToolCheckRunResultDto): boolean {
  return result.status === 'passed' && result.error !== undefined;
}

export function cellOpLabel(op: ToolCheckCellOpDto): string {
  return op === 'eq' ? '==' : op === 'neq' ? '!=' : op === 'gte' ? '>=' : op === 'lte' ? '<=' : 'contains';
}

/** 合否の件数。status = error のときも assertions は評価済みの分だけ入りうる。 */
export function assertionCounts(result: ToolCheckRunResultDto): { readonly passed: number; readonly failed: number } {
  let passed = 0;
  for (const assertion of result.assertions) if (assertion.passed) passed += 1;
  return { passed, failed: result.assertions.length - passed };
}

/** 「すべて実行」の集計。 */
export function summarizeStatuses(statuses: readonly ResultStatus[]): Readonly<Record<ResultStatus, number>> {
  const summary: Record<ResultStatus, number> = { passed: 0, failed: 0, error: 0 };
  for (const status of statuses) summary[status] += 1;
  return summary;
}

/** 引数欄の入力タイプ。日付は ISO 文字列で受ける（datetime-local はブラウザ差が大きく、タイムゾーンで値が変わる）。 */
export function inputKindFor(column: ColumnDto): 'number' | 'boolean' | 'text' {
  if (column.type === 'number') return 'number';
  if (column.type === 'boolean') return 'boolean';
  return 'text';
}

// ---------------------------------------------------------------------------
// LLM によるケース提案（正常 / 境界 / 異常）
// ---------------------------------------------------------------------------

export const SUGGESTION_CATEGORIES: readonly ToolCheckCaseCategoryDto[] = ['normal', 'boundary', 'abnormal'];
export const PER_CATEGORY_MIN = 1;
export const PER_CATEGORY_MAX = 5;
export const PER_CATEGORY_DEFAULT = 2;

export function categoryLabel(category: ToolCheckCaseCategoryDto): readonly [en: string, ja: string] {
  if (category === 'normal') return ['Normal', '正常'];
  if (category === 'boundary') return ['Boundary', '境界'];
  return ['Abnormal', '異常'];
}

/** 入力欄の値を 1〜5 に収める（数値でなければ既定値）。サーバー側の検証（1〜5）と同じ範囲。 */
export function clampPerCategory(raw: string | number): number {
  // Number('') は 0 になるので、空欄は数値でないものとして既定値へ戻す。
  const parsed = typeof raw === 'number' ? raw : raw.trim() === '' ? Number.NaN : Number(raw.trim());
  if (!Number.isFinite(parsed)) return PER_CATEGORY_DEFAULT;
  return Math.min(PER_CATEGORY_MAX, Math.max(PER_CATEGORY_MIN, Math.trunc(parsed)));
}

/** 提案リクエストの DTO。focus は前後の空白を除き、空なら載せない。version は最新（''）なら載せない。 */
export function buildSuggestDto(input: { readonly toolId: string; readonly version: string; readonly perCategory: number; readonly focus: string }, scope: SuggestToolCheckCasesDto['scope']): SuggestToolCheckCasesDto {
  const focus = input.focus.trim();
  return {
    scope,
    toolId: input.toolId,
    ...(input.version === '' ? {} : { version: input.version }),
    perCategory: clampPerCategory(input.perCategory),
    ...(focus === '' ? {} : { focus }),
  };
}

/** 提案をカテゴリ順（正常 → 境界 → 異常）にまとめる。空のカテゴリも見出しを出すため必ず 3 件返す。 */
export function groupSuggestions(suggestions: readonly ToolCheckSuggestionDto[]): readonly { readonly category: ToolCheckCaseCategoryDto; readonly items: readonly { readonly index: number; readonly suggestion: ToolCheckSuggestionDto }[] }[] {
  return SUGGESTION_CATEGORIES.map((category) => ({
    category,
    items: suggestions.map((suggestion, index) => ({ index, suggestion })).filter((item) => item.suggestion.category === category),
  }));
}

/**
 * 期待の要約（サーバーの英語定型文と同じ形）。カード上の表示は ResultPanel と同じ localizeToolCheckAssertion で
 * 日本語化できるよう、あえてサーバー定型文に揃える（`row count == 3` / `column 'x' exists` / `some row has x >= 1` / `duration <= 500ms` / `outcome error`）。
 */
export function summarizeExpectations(expectations: ToolCheckExpectationsDto): readonly string[] {
  const lines: string[] = [];
  if (expectations.outcome !== undefined) lines.push(`outcome ${expectations.outcome}`);
  if (expectations.rowCount !== undefined) lines.push(`row count ${cellOpLabel(expectations.rowCount.op)} ${expectations.rowCount.value}`);
  for (const column of expectations.columns ?? []) lines.push(`column '${column}' exists`);
  for (const cell of expectations.cells ?? []) {
    const value = typeof cell.value === 'string' ? JSON.stringify(cell.value) : String(cell.value);
    lines.push(`${cell.mode === 'all' ? 'every row has' : 'some row has'} ${cell.column} ${cellOpLabel(cell.op)} ${value}`);
  }
  if (expectations.maxDurationMs !== undefined) lines.push(`duration <= ${expectations.maxDurationMs}ms`);
  return lines;
}

/** 提案をエディタの状態へ展開する（「エディタに読み込む」）。版はリクエストで選んでいたものを引き継ぐ。 */
export function editorFromSuggestion(suggestion: ToolCheckSuggestionDto, base: Pick<EditorState, 'toolId' | 'version'>, inputSchema: SchemaDto | undefined): EditorState {
  return {
    toolId: base.toolId,
    version: base.version,
    caseName: suggestion.name,
    drafts: draftsFromArguments(suggestion.arguments, inputSchema),
    expectations: draftFromExpectations(suggestion.expectations),
  };
}
