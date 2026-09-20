/**
 * ドメイン: 段階的ツール生成の宣言的な仕様 `ToolSpec`（v42 実装契約 §2 / ADR-0048）。
 *
 * ToolSmith が 1 回のプロンプトでグラフ全体（ノード・エッジ・config・引数宣言・説明文）を書くと、
 * ローカル 12B では試行のたびに別の機械的な書き間違いが出た（ADR-0047 / ADR-0048）。そこで
 * 「何で絞るか」「何を計算したいか」「何を返すか」という**決定だけ**を小さなタスクに書かせ、
 * グラフの組み立ては決定的なコンパイラ（`compileToolSpec`）へ寄せる。この file はその決定の型と、
 * 「その決定はデータに対して成立するか」を決定的に見る純関数 `validateToolSpec` を持つ。
 *
 * 層の規律: domain は application を参照できないので、検証に要る材料だけを `ToolSpecContext`
 * （ソースごとの列名と型・期間ラベル列と存在する粒度・カテゴリ列と実在値・結合キー候補・
 * 追加ソースの有無）として受け取る。`DataProfile` からこの文脈を作るのは application 側
 * （`toolSpecContextOf`）の仕事である。
 */
import { FILTER_OPS } from '../etl/nodes/filter';
import type { PeriodGranularity } from '../etl/nodes/parse-period';

/** `ToolSpec` の版。互換性のない変更を入れるときに上げる。 */
export const TOOL_SPEC_VERSION = 1;

/** 決定を下したタスクの名前。違反はこの名前で担当タスクへ差し戻す（v42 §6）。 */
export type ToolSpecTaskName = 'decide-join' | 'decide-filters' | 'decide-computations' | 'decide-output' | 'write-expression';

/** 検証違反 1 件。**どのタスクの決定が悪いか**を必ず持つ。 */
export interface ToolSpecIssue {
  readonly task: ToolSpecTaskName;
  readonly message: string;
}

export interface ToolSpecJoin {
  /** 全ソース共通の結合キー（`context.joinKeyCandidates` から選ぶ。1..`MAX_TOOL_SPEC_JOIN_KEYS`）。 */
  readonly keys: readonly string[];
  readonly mode: 'inner' | 'left';
}

export interface ToolSpecPeriod {
  /** 期間ラベル列（主ソースの `periodColumns[].column` のどれか）。 */
  readonly column: string;
  /**
   * 粒度の決め方。`'argument'` は**必須**引数 `granularity`（string・`nullable: false`・eq 束縛）を
   * 宣言する（省略できると月次と年次が混ざるため）。固定なら `PeriodGranularity` の値。
   */
  readonly granularity: PeriodGranularity | 'argument';
  /** `granularity === 'argument'` のときの設計時サンプル兼「迷ったらこれ」（データに存在する粒度）。 */
  readonly defaultGranularity?: PeriodGranularity;
  /** 期間の範囲引数（`period_from` / `period_to`、date・nullable）を宣言するか。 */
  readonly range: boolean;
}

export interface ToolSpecCategoryFilter {
  /** 主ソースの `categoricalColumns[].column` のどれか。 */
  readonly column: string;
  /** 引数名（snake_case、`TOOL_SPEC_ARGUMENT_PATTERN`）。 */
  readonly argument: string;
  /** true = `in`（カンマ区切りで複数）/ false = `eq`（1 値）。 */
  readonly multi: boolean;
}

export interface ToolSpecComputation {
  /** 足す列名（既存列と衝突しない）。 */
  readonly outputColumn: string;
  /** 何を計算したいか（自然文。式ではない）。`write-expression` タスクへそのまま渡す。 */
  readonly intent: string;
}

export interface ToolSpecOutput {
  /** 返す列（結合後・計算後の表の列名。空なら全列）。期間ラベル列と値の列はコンパイラが必ず残す。 */
  readonly columns: readonly string[];
  readonly sort: 'latest-first' | 'oldest-first' | 'none';
  /** 1..`MAX_TOOL_SPEC_LIMIT`。`agent-output` の `maxRows` と `limit` に使う。 */
  readonly limit: number;
}

export interface ToolSpec {
  readonly version: 1;
  /** 結合（`plan.additionalDataSourceIds` があるときだけ）。無ければ undefined。 */
  readonly join?: ToolSpecJoin;
  /** 期間の扱い（主ソースに期間ラベル列があるときだけ）。 */
  readonly period?: ToolSpecPeriod;
  /** カテゴリ列での絞り込み（0..`MAX_TOOL_SPEC_CATEGORY_FILTERS`）。 */
  readonly categoryFilters: readonly ToolSpecCategoryFilter[];
  /** 計算列（0..`MAX_TOOL_SPEC_COMPUTATIONS`）。式は `write-expression` が埋める。 */
  readonly computations: readonly ToolSpecComputation[];
  /** 返す列・並び・件数。 */
  readonly output: ToolSpecOutput;
}

// ── 検証に使う文脈（`DataProfile` から application 層が作る最小の材料） ────────────────────

/** 1 列の名前と型（`DataProfile.columns` の部分集合）。 */
export interface ToolSpecColumnContext {
  readonly name: string;
  /** `DataType` の文字列（domain/data/types）。`'number'` の列を「値の列」とみなす。 */
  readonly type: string;
}

/** 期間ラベル列 1 つ（存在する粒度だけを並べる。`unknown` は含めない）。 */
export interface ToolSpecPeriodColumnContext {
  readonly column: string;
  readonly granularities: readonly PeriodGranularity[];
}

/** 値を列挙できる列 1 つ（設計時サンプルは実在値の先頭から採る）。 */
export interface ToolSpecCategoryColumnContext {
  readonly column: string;
  readonly values: readonly string[];
}

/** このツールが読むデータソース 1 件ぶんの文脈。先頭が主ソース。 */
export interface ToolSpecSourceContext {
  readonly dataSourceId: string;
  readonly name: string;
  readonly columns: readonly ToolSpecColumnContext[];
  readonly periodColumns: readonly ToolSpecPeriodColumnContext[];
  readonly categoricalColumns: readonly ToolSpecCategoryColumnContext[];
}

export interface ToolSpecContext {
  /** 主ソース（先頭）+ 結合する追加ソース（`plan.additionalDataSourceIds` の順）。 */
  readonly sources: readonly ToolSpecSourceContext[];
  /** 結合キーとして選んでよい列名（プロファイルの `joinCandidates` が挙げた列の和集合）。 */
  readonly joinKeyCandidates: readonly string[];
  /** 計画が追加データソースを持つか（= `join` が必要か）。 */
  readonly hasAdditionalSources: boolean;
}

// ── 定数 ─────────────────────────────────────────────────────────────────────────

/** `parse-period` が足す開始日の列名（コンパイラと検証が共有する）。 */
export const PERIOD_START_COLUMN = 'periodStart';
/** `parse-period` が足す粒度の列名。 */
export const PERIOD_GRANULARITY_COLUMN = 'periodGranularity';

/** 粒度を引数にするときの引数名。 */
export const GRANULARITY_ARGUMENT = 'granularity';
/** 期間の範囲引数の名前。 */
export const PERIOD_FROM_ARGUMENT = 'period_from';
export const PERIOD_TO_ARGUMENT = 'period_to';

/** コンパイラが自分で使う引数名。カテゴリ引数はこれらと衝突してはならない。 */
export const RESERVED_TOOL_SPEC_ARGUMENTS: readonly string[] = [GRANULARITY_ARGUMENT, PERIOD_FROM_ARGUMENT, PERIOD_TO_ARGUMENT];

/** 引数名の形（snake_case・1..40 文字）。 */
export const TOOL_SPEC_ARGUMENT_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const MAX_TOOL_SPEC_CATEGORY_FILTERS = 3;
export const MAX_TOOL_SPEC_COMPUTATIONS = 3;
export const MAX_TOOL_SPEC_JOIN_KEYS = 4;
export const MIN_TOOL_SPEC_LIMIT = 1;
export const MAX_TOOL_SPEC_LIMIT = 100;

/**
 * 注記・備考のような自由記述列（`generate-agent-assets` の `NOTE_LIKE_COLUMN` と同じ語彙）。
 * 主ソースの最初の該当列を「注記列」として `select` に必ず残す（数値だけ引用させないため）。
 */
const NOTE_LIKE_COLUMN = /注記|備考|摘要|remarks?|notes?|comments?/i;

/**
 * この配線の `filter` が複数値演算子（`in`）を持つか。持つビルドでは、カテゴリ列を `eq` で
 * 絞るツールは `describeToolSemanticViolations` が必ず差し戻す（1 回の呼び出しで 1 値しか
 * 頼めないと、比較の質問がツール呼び出し上限で落ちるため）。コンパイラの出力は既存の検査を
 * 必ず通らなければならないので、`multi: false` はここで先に弾く。
 */
const SUPPORTS_MULTI_VALUE_FILTER = (FILTER_OPS as readonly string[]).includes('in');

// ── 列の導出（検証とコンパイラが共有する 1 本の規則） ──────────────────────────────────

/** 主ソースの注記列（最初の該当列。無ければ undefined）。 */
export function noteColumnOf(source: ToolSpecSourceContext): string | undefined {
  return source.columns.find((column) => NOTE_LIKE_COLUMN.test(column.name))?.name;
}

/**
 * そのソースの「値の列」（数値列のうち結合キーでないもの）。数値列が 1 つも無いソースでは、
 * キーでも注記でもない列を値として扱う（結合しても何も持ち込まない枝を作らないため）。
 */
export function valueColumnsOf(source: ToolSpecSourceContext, joinKeys: readonly string[]): string[] {
  const keys = new Set(joinKeys);
  const numeric = source.columns.filter((column) => column.type === 'number' && !keys.has(column.name)).map((column) => column.name);
  if (numeric.length > 0) return numeric;
  return source.columns
    .filter((column) => !keys.has(column.name) && !NOTE_LIKE_COLUMN.test(column.name))
    .map((column) => column.name);
}

/**
 * 主ソース（左）の枝が `join` の前に残す列 = そのソースの全列。
 *
 * 契約は「結合キー + そのソースの値列 + 主ソースだけ注記列」だが、左の枝は他の枝と列名が衝突しない
 * （衝突するのは右から来た列だけで、そちらには suffix が付く）ので、削る理由が無い。絞る必要が
 * あるのは**右の枝**だけで、そこでキー以外の余計な列（相手の地域名・注記）を落とすことで
 * 「suffix 後もまだ衝突する」を構造的に防ぐ。左を削ると、結合キーにしなかった地域名のような
 * 「答えに要る列」が黙って消える。
 */
export function primaryBranchColumnsOf(_spec: ToolSpec, source: ToolSpecSourceContext): string[] {
  return source.columns.map((column) => column.name);
}

/** 追加ソースの枝が `join` の前に残す列（結合キー + そのソースの値の列）。 */
export function additionalBranchColumnsOf(spec: ToolSpec, source: ToolSpecSourceContext): string[] {
  const keys = spec.join?.keys ?? [];
  const wanted = new Set<string>([...keys, ...valueColumnsOf(source, keys)]);
  return source.columns.map((column) => column.name).filter((name) => wanted.has(name));
}

/** i 番目（1 起点）の `join` が右側の同名列へ付ける suffix（`_2` / `_3`）。 */
export function rightSuffixOf(joinIndex: number): string {
  return `_${joinIndex + 1}`;
}

/** 結合後の列 1 つ（出自つき）。`select` が何を必ず残すかを決めるのに使う。 */
export interface ToolSpecJoinedColumn {
  /** 結合後の列名（右側の同名列は suffix 付き）。 */
  readonly name: string;
  /** どのソース由来か（0 = 主ソース）。 */
  readonly sourceIndex: number;
  /** そのソースの「値の列」か（`select` が必ず残す対象）。 */
  readonly value: boolean;
}

/**
 * 結合だけを済ませた表の列（`join` ノードの出力規則をそのまま写す: 左の全列 → 右の非キー列、
 * 同名は suffix 付き）。結合しないツールでは主ソースの全列。
 */
export function planJoinedColumns(spec: ToolSpec, context: ToolSpecContext): ToolSpecJoinedColumn[] {
  const primary = context.sources[0];
  if (primary === undefined) return [];
  const keys = spec.join?.keys ?? [];
  if (spec.join === undefined || context.sources.length < 2) {
    const values = new Set(valueColumnsOf(primary, keys));
    return primary.columns.map((column) => ({ name: column.name, sourceIndex: 0, value: values.has(column.name) }));
  }

  const keySet = new Set(keys);
  const primaryValues = new Set(valueColumnsOf(primary, keys));
  const columns: ToolSpecJoinedColumn[] = primaryBranchColumnsOf(spec, primary)
    .map((name) => ({ name, sourceIndex: 0, value: primaryValues.has(name) }));
  const used = new Set(columns.map((column) => column.name));
  context.sources.slice(1).forEach((source, index) => {
    const suffix = rightSuffixOf(index + 1);
    for (const name of additionalBranchColumnsOf(spec, source)) {
      if (keySet.has(name)) continue; // 結合キーに使った右列は join が出力から落とす。
      const outName = used.has(name) ? `${name}${suffix}` : name;
      if (used.has(outName)) continue; // suffix 後も衝突する列は join が error にする（検証が先に弾く）。
      used.add(outName);
      // 右の枝は「結合キー + 値の列」しか残さないので、キーでない列はすべて値の列。
      columns.push({ name: outName, sourceIndex: index + 1, value: true });
    }
  });
  return columns;
}

/** 結合だけを済ませた表の列名。 */
export function joinedColumnsOf(spec: ToolSpec, context: ToolSpecContext): string[] {
  return planJoinedColumns(spec, context).map((column) => column.name);
}

/** 結合後の「値の列」（ソースごとに 1 つ以上残っていないと、答えに使える数字が無くなる）。 */
export function joinedValueColumnsOf(spec: ToolSpec, context: ToolSpecContext): string[] {
  return planJoinedColumns(spec, context).filter((column) => column.value).map((column) => column.name);
}

/**
 * `decide-output` が「返す列」を選ぶ母集合 = 結合後・`parse-period` 後・計算後の表の列名。
 * コンパイラの `columnsAfterJoinAndCompute` はこの関数へ委譲する（列の導出を 2 か所に書かない）。
 */
export function toolSpecColumns(spec: ToolSpec, context: ToolSpecContext): string[] {
  const columns = joinedColumnsOf(spec, context);
  const seen = new Set(columns);
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    columns.push(name);
  };
  if (spec.period !== undefined) {
    push(PERIOD_START_COLUMN);
    push(PERIOD_GRANULARITY_COLUMN);
  }
  for (const computation of spec.computations) push(computation.outputColumn);
  return columns;
}

// ── 検証 ─────────────────────────────────────────────────────────────────────────

function issue(task: ToolSpecTaskName, message: string): ToolSpecIssue {
  return { task, message };
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function validateJoin(spec: ToolSpec, context: ToolSpecContext): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  const join = spec.join;
  if (join === undefined) {
    if (context.hasAdditionalSources) {
      issues.push(issue('decide-join', `this tool plan reads ${context.sources.length} data sources, so it needs a join: choose the key columns the sources share (${context.joinKeyCandidates.join(', ') || 'none were detected'})`));
    }
    return issues;
  }
  if (!context.hasAdditionalSources) {
    issues.push(issue('decide-join', 'this tool plan reads a single data source, so it must not declare a join'));
    return issues;
  }
  if (join.mode !== 'inner' && join.mode !== 'left') {
    issues.push(issue('decide-join', `join.mode must be 'inner' or 'left', got '${String(join.mode)}'`));
  }
  if (join.keys.length === 0) {
    issues.push(issue('decide-join', `join.keys is empty: join on at least one of the shared key columns (${context.joinKeyCandidates.join(', ') || 'none were detected'})`));
  }
  if (join.keys.length > MAX_TOOL_SPEC_JOIN_KEYS) {
    issues.push(issue('decide-join', `join.keys has ${join.keys.length} columns, at most ${MAX_TOOL_SPEC_JOIN_KEYS} are allowed`));
  }
  const seen = new Set<string>();
  const candidates = new Set(context.joinKeyCandidates);
  for (const key of join.keys) {
    if (seen.has(key)) {
      issues.push(issue('decide-join', `join.keys repeats the column '${key}'`));
      continue;
    }
    seen.add(key);
    if (!candidates.has(key)) {
      issues.push(issue('decide-join', `join key '${key}' is not one of the shared key columns the data profile found (${context.joinKeyCandidates.join(', ') || 'none'})`));
      continue;
    }
    const types = new Set<string>();
    for (const source of context.sources) {
      const column = source.columns.find((candidate) => candidate.name === key);
      if (column === undefined) {
        issues.push(issue('decide-join', `join key '${key}' does not exist in data source "${source.dataSourceId}" (${source.name})`));
        continue;
      }
      if (column.type !== 'unknown') types.add(column.type);
    }
    if (types.size > 1) {
      issues.push(issue('decide-join', `join key '${key}' has different types across the sources (${[...types].join(', ')}): the key types must match`));
    }
  }
  return issues;
}

function validatePeriod(spec: ToolSpec, context: ToolSpecContext): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  const primary = context.sources[0];
  if (primary === undefined) return issues;
  const period = spec.period;

  if (period === undefined) {
    const mixed = primary.periodColumns.find((column) => column.granularities.length > 1);
    if (mixed !== undefined) {
      issues.push(issue('decide-filters', `the period column '${mixed.column}' mixes ${mixed.granularities.join(' / ')} rows, so a tool that does not narrow the granularity returns monthly and yearly numbers in one table. Set period.granularity to one of them, or to 'argument'`));
    }
    return issues;
  }

  if (primary.periodColumns.length === 0) {
    issues.push(issue('decide-filters', `data source "${primary.dataSourceId}" (${primary.name}) has no period label column, so period must be omitted`));
    return issues;
  }
  const column = primary.periodColumns.find((candidate) => candidate.column === period.column);
  if (column === undefined) {
    issues.push(issue('decide-filters', `period.column '${period.column}' is not a period label column: choose one of ${primary.periodColumns.map((candidate) => `'${candidate.column}'`).join(', ')}`));
    return issues;
  }
  for (const source of context.sources) {
    for (const reserved of [PERIOD_START_COLUMN, PERIOD_GRANULARITY_COLUMN]) {
      if (source.columns.some((candidate) => candidate.name === reserved)) {
        issues.push(issue('decide-filters', `data source "${source.dataSourceId}" already has a column named '${reserved}', which is the name 'parse-period' adds: this tool cannot parse periods`));
      }
    }
  }

  const present = new Set<string>(column.granularities);
  if (period.granularity === 'argument') {
    const fallback = period.defaultGranularity;
    if (fallback === undefined) {
      issues.push(issue('decide-filters', `period.granularity is 'argument', so defaultGranularity is required: it is the sample the preview runs with and the value the description tells the agent to use when in doubt (available: ${[...present].join(', ')})`));
    } else if (!present.has(fallback)) {
      issues.push(issue('decide-filters', `period.defaultGranularity '${fallback}' does not occur in '${period.column}': choose one of ${[...present].join(', ')}`));
    }
  } else if (!present.has(period.granularity)) {
    issues.push(issue('decide-filters', `period.granularity '${String(period.granularity)}' does not occur in '${period.column}': choose one of ${[...present].join(', ')}, or 'argument' to let the agent pick`));
  } else if (period.defaultGranularity !== undefined && !present.has(period.defaultGranularity)) {
    issues.push(issue('decide-filters', `period.defaultGranularity '${period.defaultGranularity}' does not occur in '${period.column}': choose one of ${[...present].join(', ')}`));
  }
  return issues;
}

function validateCategoryFilters(spec: ToolSpec, context: ToolSpecContext): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  const primary = context.sources[0];
  if (primary === undefined) return issues;
  if (spec.categoryFilters.length > MAX_TOOL_SPEC_CATEGORY_FILTERS) {
    issues.push(issue('decide-filters', `${spec.categoryFilters.length} category filters were chosen, at most ${MAX_TOOL_SPEC_CATEGORY_FILTERS} are allowed: narrowing a tool further makes it answer fewer questions`));
  }
  const categories = new Map(primary.categoricalColumns.map((column) => [column.column, column] as const));
  const seenColumns = new Set<string>();
  const seenArguments = new Set<string>();
  for (const filter of spec.categoryFilters) {
    const category = categories.get(filter.column);
    if (category === undefined) {
      issues.push(issue('decide-filters', `category filter column '${filter.column}' is not a column whose values can be listed: choose one of ${primary.categoricalColumns.map((column) => `'${column.column}'`).join(', ') || 'none'}`));
    } else if (category.values.length === 0) {
      issues.push(issue('decide-filters', `category filter column '${filter.column}' has no sample value in the data profile, so the tool cannot be previewed`));
    }
    if (seenColumns.has(filter.column)) {
      issues.push(issue('decide-filters', `category filter column '${filter.column}' is used twice: one argument per column`));
    }
    seenColumns.add(filter.column);

    if (isBlank(filter.argument) || !TOOL_SPEC_ARGUMENT_PATTERN.test(filter.argument)) {
      issues.push(issue('decide-filters', `argument name '${String(filter.argument)}' is not snake_case: it must match ${TOOL_SPEC_ARGUMENT_PATTERN.source}`));
    } else if (RESERVED_TOOL_SPEC_ARGUMENTS.includes(filter.argument)) {
      issues.push(issue('decide-filters', `argument name '${filter.argument}' is reserved for the period arguments (${RESERVED_TOOL_SPEC_ARGUMENTS.join(', ')}): pick another name`));
    }
    if (seenArguments.has(filter.argument)) {
      issues.push(issue('decide-filters', `argument name '${filter.argument}' is declared twice`));
    }
    seenArguments.add(filter.argument);

    if (filter.multi !== true && SUPPORTS_MULTI_VALUE_FILTER) {
      issues.push(issue('decide-filters', `category filter on '${filter.column}' sets multi: false, so one call can only ask for a single value and comparing a few of them would need one call per value (the number of tool calls per conversation is capped). Set multi: true — the argument then takes a comma-separated list`));
    }
  }
  return issues;
}

function validateComputations(spec: ToolSpec, context: ToolSpecContext): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  if (spec.computations.length > MAX_TOOL_SPEC_COMPUTATIONS) {
    issues.push(issue('decide-computations', `${spec.computations.length} computed columns were chosen, at most ${MAX_TOOL_SPEC_COMPUTATIONS} are allowed`));
  }
  const existing = new Set([
    ...joinedColumnsOf(spec, context),
    ...(spec.period === undefined ? [] : [PERIOD_START_COLUMN, PERIOD_GRANULARITY_COLUMN]),
  ]);
  const seen = new Set<string>();
  for (const computation of spec.computations) {
    if (isBlank(computation.outputColumn)) {
      issues.push(issue('decide-computations', 'a computed column needs a non-empty outputColumn'));
      continue;
    }
    if (isBlank(computation.intent)) {
      issues.push(issue('decide-computations', `computed column '${computation.outputColumn}' needs an intent: one sentence saying what to compute from the columns of the table (the expression itself is written by another task)`));
    }
    if (existing.has(computation.outputColumn)) {
      issues.push(issue('decide-computations', `computed column '${computation.outputColumn}' collides with a column the table already has: pick a new name so the original value stays readable`));
    }
    if (seen.has(computation.outputColumn)) {
      issues.push(issue('decide-computations', `computed column '${computation.outputColumn}' is declared twice`));
    }
    seen.add(computation.outputColumn);
  }
  return issues;
}

function validateOutput(spec: ToolSpec, context: ToolSpecContext): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  const output = spec.output;
  if (output === undefined) return [issue('decide-output', 'output is missing: say which columns to return, how to sort them and how many rows at most')];

  if (!['latest-first', 'oldest-first', 'none'].includes(output.sort)) {
    issues.push(issue('decide-output', `output.sort must be 'latest-first', 'oldest-first' or 'none', got '${String(output.sort)}'`));
  } else if (output.sort !== 'none' && spec.period === undefined) {
    issues.push(issue('decide-output', `output.sort is '${output.sort}' but this tool does not parse periods, so there is nothing to order by: use 'none'`));
  }

  if (!Number.isInteger(output.limit) || output.limit < MIN_TOOL_SPEC_LIMIT || output.limit > MAX_TOOL_SPEC_LIMIT) {
    issues.push(issue('decide-output', `output.limit must be an integer between ${MIN_TOOL_SPEC_LIMIT} and ${MAX_TOOL_SPEC_LIMIT}, got ${String(output.limit)}`));
  }

  const available = new Set(toolSpecColumns(spec, context));
  for (const column of output.columns) {
    if (available.has(column)) continue;
    issues.push(issue('decide-output', `output column '${column}' does not exist in the joined table: choose from ${[...available].join(', ')}`));
  }
  return issues;
}

/**
 * `ToolSpec` がこのデータに対して成立するかを決定的に見る（副作用なし・純関数）。
 *
 * 返す違反にはそれを決めたタスク名が付く: 呼び出し側は**そのタスクだけ**を理由つきでやり直す
 * （v42 §6 の対応表）。ここを通った spec からコンパイラが作るグラフは、既存の
 * `describeGraphShapeViolations` / `describeToolSemanticViolations` を必ず通る
 * （通らない組み合わせ — 例えばカテゴリ列の `eq` 束縛 — はここで先に弾く）。
 */
export function validateToolSpec(spec: ToolSpec, context: ToolSpecContext): ToolSpecIssue[] {
  const issues: ToolSpecIssue[] = [];
  if (spec.version !== TOOL_SPEC_VERSION) {
    // 版の不一致はどのタスクの決定でもないが、issue は必ずタスクを持つ契約なので最初のタスクへ寄せる。
    issues.push(issue('decide-filters', `ToolSpec version ${String(spec.version)} is not supported (expected ${TOOL_SPEC_VERSION})`));
  }
  if (context.sources.length === 0) {
    issues.push(issue('decide-join', 'no data source profile was given for this tool plan'));
    return issues;
  }
  issues.push(...validateJoin(spec, context));
  issues.push(...validatePeriod(spec, context));
  issues.push(...validateCategoryFilters(spec, context));
  issues.push(...validateComputations(spec, context));
  issues.push(...validateOutput(spec, context));
  return issues;
}
