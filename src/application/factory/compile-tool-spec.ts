/**
 * application層: 宣言的な `ToolSpec` を Tool のグラフ・引数宣言・説明文へ組み立てる決定的コンパイラ
 * （v42 実装契約 §3 / ADR-0048）。**LLM は一切関与しない**（純関数・同じ入力なら同じ出力）。
 *
 * なぜ決定的に組むか: ノード・エッジ・ポート・`toInput`・`valueBinding`・引数の型と nullable・
 * 設計時サンプル・説明文は、どれも「書き間違えると静かに壊れる」部分で、ローカル 12B が毎回
 * 別の壊し方をしていた（ADR-0047）。モデルには**決定だけ**（何で絞るか・何を計算したいか・
 * 何を返すか）を書かせ、形はここで作る。
 *
 * **計算列（`calculate`）の式は空のまま置く**。空の式は `calculate` の `inferSchema` が error
 * issue にし、`execute` は `ConfigError` を投げる（設定途中の状態）。したがって、ここが返す
 * `CompiledTool.graph` は**中間生成物**であり、
 *   1. `write-expression` タスクが `withExpression` で式を入れたあと、または
 *   2. `withoutComputation` で計算列を落としたあと
 * でなければ `propagateSchemas` / `preview` / 保存検証へ掛けてはならない。
 * 計算列が 0 件のときは最初から完成したグラフである。
 */
import type { Schema } from '../../domain/data/types';
import type { GraphEdge, GraphNode, ToolGraph } from '../../domain/etl/graph';
import { CALCULATE_TYPE } from '../../domain/etl/nodes/calculate';
import { PARSE_PERIOD_TYPE, type PeriodGranularity } from '../../domain/etl/nodes/parse-period';
import { FactoryValidationError } from '../../domain/factory/errors';
import type { FactoryToolPlan } from '../../domain/factory/factory-plan';
import {
  GRANULARITY_ARGUMENT,
  PERIOD_FROM_ARGUMENT,
  PERIOD_GRANULARITY_COLUMN,
  PERIOD_START_COLUMN,
  PERIOD_TO_ARGUMENT,
  additionalBranchColumnsOf,
  joinedValueColumnsOf,
  noteColumnOf,
  primaryBranchColumnsOf,
  rightSuffixOf,
  toolSpecColumns,
  type ToolSpec,
  type ToolSpecContext,
  type ToolSpecSourceContext,
} from '../../domain/factory/tool-spec';
import type { DataProfile } from './profile-data-sources';

/** コンパイル結果。`graph` は計算列の式が空なら中間生成物（この file の冒頭を参照）。 */
export interface CompiledTool {
  readonly graph: ToolGraph;
  /** 引数が 1 つも無ければ undefined（`agent-input` ノードも置かない）。 */
  readonly inputSchema?: Schema;
  readonly agentTool: { readonly name: string; readonly description: string };
  /** 計算列ごとの `calculate` ノード id（式を入れる場所）。`spec.computations` と同じ順。 */
  readonly calculateNodeIds: readonly string[];
}

/** 説明文の言語（既定は日本語）。契約の `goal.language` をそのまま渡す。 */
export interface CompileToolSpecOptions {
  readonly language: 'ja' | 'en';
}

/**
 * `describeGraphShapeViolations` へ渡す、段階的経路だけで使う追加のノード種別。
 *
 * `calculate` は従来の一括 ToolSmith には許可しない（式をグラフのプロンプトに混ぜないため。v42 §5）
 * ので `SAFE_TRANSFORM_TYPES` には入っていない。段階的経路の検査ではこれを足す。
 */
export const COMPILED_EXTRA_TRANSFORM_TYPES: readonly string[] = [CALCULATE_TYPE];

/** 決定的なノード id（v42 §3）。 */
export const TOOL_SPEC_NODE_IDS = {
  source: (index: number) => `src_${index + 1}`,
  branchSelect: (index: number) => `sel_${index + 1}`,
  join: (index: number) => `join_${index + 1}`,
  period: 'period',
  granularityFilter: 'f_granularity',
  categoryFilter: 'f_category',
  rangeFilter: 'f_range',
  calculate: (index: number) => `calc_${index + 1}`,
  sort: 'sort',
  limit: 'limit',
  select: 'select',
  output: 'out',
  arguments: 'args',
} as const;

/** 終端 `agent-output` のバイト上限（既存の Factory 生成 Tool と同じ既定）。 */
const AGENT_OUTPUT_MAX_BYTES = 65_536;

/** 期間ラベルが 1 件も解釈できなかったときの設計時サンプル（全行を通す広い範囲）。 */
const WIDE_PERIOD_START = '1000-01-01';
const WIDE_PERIOD_END = '9999-12-31';

/** 説明文の「返す列」行の接頭辞。`withoutComputation` がこの行だけを書き直す。 */
export const RETURNED_COLUMNS_PREFIX_JA = '返す列: ';
export const RETURNED_COLUMNS_PREFIX_EN = 'Returned columns: ';

/** カテゴリ引数の説明に載せる実在値の数（`in` は 2 件、`eq` は 1 件）。 */
const CATEGORY_SAMPLE_COUNT = 2;

// ── 文脈の組み立て ────────────────────────────────────────────────────────────────

function profileOf(profiles: readonly DataProfile[], dataSourceId: string, plan: FactoryToolPlan): DataProfile {
  const profile = profiles.find((candidate) => candidate.dataSourceId === dataSourceId);
  if (profile === undefined) {
    throw new FactoryValidationError(`compileToolSpec: no data profile for dataSourceId '${dataSourceId}' (tool plan '${plan.key}')`);
  }
  return profile;
}

/** このツールが読むプロファイル（主ソースが先頭、続いて `additionalDataSourceIds` の順）。 */
export function toolSpecProfilesOf(plan: FactoryToolPlan, profiles: readonly DataProfile[]): DataProfile[] {
  return [plan.dataSourceId, ...(plan.additionalDataSourceIds ?? [])].map((id) => profileOf(profiles, id, plan));
}

function sourceContextOf(profile: DataProfile): ToolSpecSourceContext {
  return {
    dataSourceId: profile.dataSourceId,
    name: profile.name,
    columns: profile.columns.map((column) => ({ name: column.name, type: column.type })),
    periodColumns: profile.periodColumns.map((column) => ({
      column: column.column,
      // 出現順は `PERIOD_GRANULARITIES` ではなくプロファイルのキー順（決定的）。
      granularities: Object.keys(column.granularities) as PeriodGranularity[],
    })),
    categoricalColumns: profile.categoricalColumns.map((column) => ({ column: column.column, values: column.values })),
  };
}

/**
 * `DataProfile[]` から `validateToolSpec` / コンパイラが使う最小の文脈を作る。
 *
 * 結合キーの候補は、**このツールが読むソース同士**の `joinCandidates` が挙げた列だけに絞る
 * （Run 全体の候補をそのまま渡すと、このツールが読まないソース間のキーを選べてしまう）。
 */
export function toolSpecContextOf(plan: FactoryToolPlan, profiles: readonly DataProfile[]): ToolSpecContext {
  const used = toolSpecProfilesOf(plan, profiles);
  const ids = new Set(used.map((profile) => profile.dataSourceId));
  const keys: string[] = [];
  for (const candidate of used.flatMap((profile) => profile.joinCandidates)) {
    if (!ids.has(candidate.leftDataSourceId) || !ids.has(candidate.rightDataSourceId)) continue;
    for (const key of candidate.keys) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return {
    sources: used.map(sourceContextOf),
    joinKeyCandidates: keys,
    hasAdditionalSources: (plan.additionalDataSourceIds ?? []).length > 0,
  };
}

/**
 * 結合後・`parse-period` 後・計算後の表の列名（`decide-output` が「返す列」を選ぶ母集合）。
 * 右側のソースの値の列は自分の名前のまま残り、名前が衝突したものだけ `_2` / `_3` が付く
 * （コンパイラが `join` で使う suffix と同じ規則）。
 */
export function columnsAfterJoinAndCompute(spec: ToolSpec, plan: FactoryToolPlan, profiles: readonly DataProfile[]): string[] {
  return toolSpecColumns(spec, toolSpecContextOf(plan, profiles));
}

// ── 説明文 ───────────────────────────────────────────────────────────────────────

/** 期間ラベル列の実測範囲（解釈できた行が無ければ広い既定へ倒す）。 */
function periodRangeOf(profile: DataProfile, column: string): { readonly min: string; readonly max: string } {
  const found = profile.periodColumns.find((candidate) => candidate.column === column);
  return { min: found?.minStart ?? WIDE_PERIOD_START, max: found?.maxStart ?? WIDE_PERIOD_END };
}

function granularitiesOf(profile: DataProfile, column: string): PeriodGranularity[] {
  const found = profile.periodColumns.find((candidate) => candidate.column === column);
  return Object.keys(found?.granularities ?? {}) as PeriodGranularity[];
}

/** カテゴリ列の実在値の先頭から設計時サンプルを採る（`in` は 2 件まで、`eq` は 1 件）。 */
function categorySamplesOf(profile: DataProfile, column: string, multi: boolean): string[] {
  const values = profile.categoricalColumns.find((candidate) => candidate.column === column)?.values ?? [];
  return values.slice(0, multi ? CATEGORY_SAMPLE_COUNT : 1);
}

interface ArgumentNote {
  readonly name: string;
  readonly line: string;
}

function describeArgumentsJa(notes: readonly ArgumentNote[]): string[] {
  if (notes.length === 0) return ['引数: なし（そのまま呼ぶと下の並び順で行を返す）。'];
  return ['引数:', ...notes.map((note) => note.line)];
}

function describeArgumentsEn(notes: readonly ArgumentNote[]): string[] {
  if (notes.length === 0) return ['Arguments: none (call it as is and it returns the rows in the order below).'];
  return ['Arguments:', ...notes.map((note) => note.line)];
}

// ── コンパイル ───────────────────────────────────────────────────────────────────

interface BuildState {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  tail: string;
}

function append(state: BuildState, node: GraphNode): void {
  state.nodes.push(node);
  state.edges.push({ from: state.tail, to: node.id });
  state.tail = node.id;
}

/** ASCII だけの slug（function 名に使う）。1 文字も残らなければ空文字。 */
function asciiSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 決定的な短いハッシュ（FNV-1a 32bit）。日本語だけのキーでも function 名を作れるようにする。 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * エージェントが呼ぶ function 名（`isValidFunctionName` を必ず満たす）。
 * 計画キー → 表示名の順に ASCII 化し、どちらも ASCII を持たなければ決定的ハッシュへ倒す。
 */
export function toolFunctionNameOf(plan: FactoryToolPlan): string {
  const fromKey = asciiSlug(plan.key);
  if (fromKey !== '') return fromKey.slice(0, 64);
  const fromDisplayName = asciiSlug(plan.displayName);
  if (fromDisplayName !== '') return fromDisplayName.slice(0, 64);
  return `tool_${shortHash(`${plan.key}\u0000${plan.displayName}`)}`;
}

/**
 * `ToolSpec` を Tool のグラフ・引数宣言・説明文へ決定的に組み立てる。
 *
 * 前提: `validateToolSpec(spec, toolSpecContextOf(plan, profiles))` が空を返していること
 * （通らない組み合わせはそちらが先に弾く。ここは「正しい spec は必ず正しいグラフになる」だけを担う）。
 */
export function compileToolSpec(
  spec: ToolSpec,
  plan: FactoryToolPlan,
  profiles: readonly DataProfile[],
  options: CompileToolSpecOptions = { language: 'ja' },
): CompiledTool {
  const used = toolSpecProfilesOf(plan, profiles);
  const context = toolSpecContextOf(plan, profiles);
  const primary = used[0];
  const primaryContext = context.sources[0];
  if (primary === undefined || primaryContext === undefined) {
    throw new FactoryValidationError(`compileToolSpec: tool plan '${plan.key}' has no primary data profile`);
  }
  const joining = spec.join !== undefined && used.length > 1;

  const state: BuildState = { nodes: [], edges: [], tail: '' };

  // 1. 各ソース。結合するときだけ枝ごとに select して join を左から連ねる。
  used.forEach((profile, index) => {
    state.nodes.push({
      id: TOOL_SPEC_NODE_IDS.source(index),
      type: profile.format === 'json' ? 'json-source' : 'csv-source',
      config: { dataSourceId: profile.dataSourceId },
    });
  });

  if (!joining) {
    state.tail = TOOL_SPEC_NODE_IDS.source(0);
  } else {
    const join = spec.join!;
    context.sources.forEach((source, index) => {
      const columns = index === 0 ? primaryBranchColumnsOf(spec, source) : additionalBranchColumnsOf(spec, source);
      state.nodes.push({ id: TOOL_SPEC_NODE_IDS.branchSelect(index), type: 'select', config: { columns } });
      state.edges.push({ from: TOOL_SPEC_NODE_IDS.source(index), to: TOOL_SPEC_NODE_IDS.branchSelect(index) });
    });
    let left = TOOL_SPEC_NODE_IDS.branchSelect(0);
    for (let index = 1; index < context.sources.length; index += 1) {
      const id = TOOL_SPEC_NODE_IDS.join(index - 1);
      state.nodes.push({
        id,
        type: 'join',
        config: {
          mode: join.mode,
          // 省略記法（文字列 1 つ）は使わず `{ left, right }` を明示する（読む側の解釈を 1 つにする）。
          keys: join.keys.map((key) => ({ left: key, right: key })),
          rightSuffix: rightSuffixOf(index),
        },
      });
      state.edges.push({ from: left, to: id, toInput: 0 });
      state.edges.push({ from: TOOL_SPEC_NODE_IDS.branchSelect(index), to: id, toInput: 1 });
      left = id;
    }
    state.tail = left;
  }

  // 2. parse-period（結合の後に 1 回だけ）→ 粒度で絞る。
  const period = spec.period;
  const argumentColumns: Schema['columns'][number][] = [];
  const argumentSample: Record<string, string> = {};
  const argumentNotesJa: ArgumentNote[] = [];
  const argumentNotesEn: ArgumentNote[] = [];
  const granularities = period === undefined ? [] : granularitiesOf(primary, period.column);
  const range = period === undefined ? { min: WIDE_PERIOD_START, max: WIDE_PERIOD_END } : periodRangeOf(primary, period.column);

  if (period !== undefined) {
    append(state, {
      id: TOOL_SPEC_NODE_IDS.period,
      type: PARSE_PERIOD_TYPE,
      config: {
        column: period.column,
        startColumn: PERIOD_START_COLUMN,
        granularityColumn: PERIOD_GRANULARITY_COLUMN,
        fiscalYearStartMonth: 4,
      },
    });

    const byArgument = period.granularity === 'argument';
    const fixed = byArgument ? (period.defaultGranularity ?? granularities[0] ?? 'year') : period.granularity;
    append(state, {
      id: TOOL_SPEC_NODE_IDS.granularityFilter,
      type: 'filter',
      config: {
        column: PERIOD_GRANULARITY_COLUMN,
        op: 'eq',
        value: fixed,
        ...(byArgument ? { valueBinding: { source: 'agent-input', field: GRANULARITY_ARGUMENT } } : {}),
      },
    });
    if (byArgument) {
      // 省略できる引数にすると、省略時に条件が無効化されて月次と年次が混ざる。必須にして構造的に防ぐ。
      argumentColumns.push({ name: GRANULARITY_ARGUMENT, type: 'string', nullable: false });
      argumentSample[GRANULARITY_ARGUMENT] = fixed;
      argumentNotesJa.push({
        name: GRANULARITY_ARGUMENT,
        line: `- ${GRANULARITY_ARGUMENT}（必須・文字列）: 期間の粒度。${granularities.join(' / ')} から選ぶ。迷ったら ${fixed}。省略できないのは、月次と年次の行が混ざった数字を返さないため。`,
      });
      argumentNotesEn.push({
        name: GRANULARITY_ARGUMENT,
        line: `- ${GRANULARITY_ARGUMENT} (required, string): the period granularity. One of ${granularities.join(', ')}. When in doubt use ${fixed}. It cannot be omitted, so that monthly and yearly rows are never mixed in one answer.`,
      });
    }
  }

  // 3. カテゴリで絞る（1 ノードにまとめて AND）。
  if (spec.categoryFilters.length > 0) {
    const conditions = spec.categoryFilters.map((filter) => {
      const samples = categorySamplesOf(primary, filter.column, filter.multi);
      return {
        column: filter.column,
        op: filter.multi ? 'in' : 'eq',
        ...(filter.multi ? { values: samples } : { value: samples[0] ?? '' }),
        valueBinding: { source: 'agent-input', field: filter.argument },
        caseInsensitive: true,
      };
    });
    append(state, { id: TOOL_SPEC_NODE_IDS.categoryFilter, type: 'filter', config: { conditions, combine: 'and' } });
    for (const filter of spec.categoryFilters) {
      const samples = categorySamplesOf(primary, filter.column, filter.multi);
      argumentColumns.push({ name: filter.argument, type: 'string', nullable: true });
      argumentSample[filter.argument] = samples.join(',');
      argumentNotesJa.push({
        name: filter.argument,
        line: filter.multi
          ? `- ${filter.argument}（任意・文字列）: 「${filter.column}」で絞る。カンマ区切りで複数まとめて渡せる（例: ${samples.join(',')}）。省略すると全件を返す。`
          : `- ${filter.argument}（任意・文字列）: 「${filter.column}」で絞る（例: ${samples[0] ?? ''}）。省略すると全件を返す。`,
      });
      argumentNotesEn.push({
        name: filter.argument,
        line: filter.multi
          ? `- ${filter.argument} (optional, string): narrows '${filter.column}'. Pass several values at once as a comma-separated list (for example ${samples.join(',')}). Omit it to get every value.`
          : `- ${filter.argument} (optional, string): narrows '${filter.column}' (for example ${samples[0] ?? ''}). Omit it to get every value.`,
      });
    }
  }

  // 4. 期間の範囲（開始日で絞る。下限と上限は別々の引数にする = 範囲が引ける）。
  if (period?.range === true) {
    append(state, {
      id: TOOL_SPEC_NODE_IDS.rangeFilter,
      type: 'filter',
      config: {
        conditions: [
          { column: PERIOD_START_COLUMN, op: 'gte', value: range.min, valueBinding: { source: 'agent-input', field: PERIOD_FROM_ARGUMENT } },
          { column: PERIOD_START_COLUMN, op: 'lte', value: range.max, valueBinding: { source: 'agent-input', field: PERIOD_TO_ARGUMENT } },
        ],
        combine: 'and',
      },
    });
    argumentColumns.push({ name: PERIOD_FROM_ARGUMENT, type: 'date', nullable: true });
    argumentColumns.push({ name: PERIOD_TO_ARGUMENT, type: 'date', nullable: true });
    argumentSample[PERIOD_FROM_ARGUMENT] = range.min;
    argumentSample[PERIOD_TO_ARGUMENT] = range.max;
    argumentNotesJa.push(
      { name: PERIOD_FROM_ARGUMENT, line: `- ${PERIOD_FROM_ARGUMENT}（任意・日付）: 期間の開始日がこの日以降の行だけを返す。ISO 形式 YYYY-MM-DD（例: ${range.min}）。省略すると下限なし。` },
      { name: PERIOD_TO_ARGUMENT, line: `- ${PERIOD_TO_ARGUMENT}（任意・日付）: 期間の開始日がこの日以前の行だけを返す。ISO 形式 YYYY-MM-DD（例: ${range.max}）。省略すると上限なし。` },
    );
    argumentNotesEn.push(
      { name: PERIOD_FROM_ARGUMENT, line: `- ${PERIOD_FROM_ARGUMENT} (optional, date): keeps the rows whose period starts on or after this day. ISO format YYYY-MM-DD (for example ${range.min}). Omit it for no lower bound.` },
      { name: PERIOD_TO_ARGUMENT, line: `- ${PERIOD_TO_ARGUMENT} (optional, date): keeps the rows whose period starts on or before this day. ISO format YYYY-MM-DD (for example ${range.max}). Omit it for no upper bound.` },
    );
  }

  // 5. 計算列（式は空のまま。`write-expression` が `withExpression` で入れる）。
  const calculateNodeIds: string[] = [];
  spec.computations.forEach((computation, index) => {
    const id = TOOL_SPEC_NODE_IDS.calculate(index);
    calculateNodeIds.push(id);
    append(state, {
      id,
      type: CALCULATE_TYPE,
      // 1 行でも評価できない行があってもツールごと落とさない（行の値だけ null にする）。
      config: { outputColumn: computation.outputColumn, expression: '', onError: 'null' },
    });
  });

  // 6. 並べ替え → 件数 → 返す列 → 終端。
  // 期間を開いたなら必ず並べ替える: `describeToolSemanticViolations` は「parse-period があるのに
  // periodStart で並べない」ツールを差し戻す（限りが掛かった結果が file 順になり「最新」が取れない）。
  // `sort: 'none'` も期間があるときは降順へ倒す（limit で残るのが最新の行になる）。
  if (period !== undefined) {
    append(state, {
      id: TOOL_SPEC_NODE_IDS.sort,
      type: 'sort',
      config: { keys: [{ column: PERIOD_START_COLUMN, direction: spec.output.sort === 'oldest-first' ? 'asc' : 'desc', nulls: 'last' }] },
    });
  }
  append(state, { id: TOOL_SPEC_NODE_IDS.limit, type: 'limit', config: { count: spec.output.limit } });

  const selectColumns = selectColumnsOf(spec, context, primaryContext);
  append(state, { id: TOOL_SPEC_NODE_IDS.select, type: 'select', config: { columns: selectColumns } });
  append(state, {
    id: TOOL_SPEC_NODE_IDS.output,
    type: 'agent-output',
    config: { shape: 'rows', format: 'json', maxRows: spec.output.limit, maxBytes: AGENT_OUTPUT_MAX_BYTES, overflow: 'error' },
  });

  // 7. 引数宣言（データ経路の外に置く未接続ノード。引数が 1 つも無ければ置かない）。
  const inputSchema: Schema | undefined = argumentColumns.length === 0 ? undefined : { columns: argumentColumns };
  if (inputSchema !== undefined) {
    state.nodes.push({
      id: TOOL_SPEC_NODE_IDS.arguments,
      type: 'agent-input',
      config: { schema: inputSchema, sample: argumentSample },
    });
  }

  const description = describeCompiledTool({
    plan,
    spec,
    used,
    selectColumns,
    granularities,
    range,
    hasPeriod: period !== undefined,
    notes: options.language === 'en' ? argumentNotesEn : argumentNotesJa,
    language: options.language,
  });

  return {
    graph: { nodes: state.nodes, edges: state.edges },
    ...(inputSchema === undefined ? {} : { inputSchema }),
    agentTool: { name: toolFunctionNameOf(plan), description },
    calculateNodeIds,
  };
}

/**
 * `select` が残す列。`spec.output.columns` が空なら全列。空でなくても、期間ラベル列・値の列・
 * 計算列・絞り込むカテゴリ列・注記列は必ず足す（どれか 1 つでも落ちると、返した行から
 * 「いつの・どの対象の・何の数字か」が言えなくなる）。並びは結合後の自然な列順。
 */
function selectColumnsOf(spec: ToolSpec, context: ToolSpecContext, primary: ToolSpecSourceContext): string[] {
  const all = toolSpecColumns(spec, context);
  const note = noteColumnOf(primary);
  const required = new Set<string>([
    ...(spec.period === undefined ? [] : [spec.period.column]),
    ...joinedValueColumnsOf(spec, context),
    ...spec.computations.map((computation) => computation.outputColumn),
    ...spec.categoryFilters.map((filter) => filter.column),
    ...(note === undefined ? [] : [note]),
  ]);
  const wanted = new Set<string>(spec.output.columns.length === 0 ? all : spec.output.columns);
  for (const column of required) wanted.add(column);
  return all.filter((column) => wanted.has(column));
}

interface DescribeInput {
  readonly plan: FactoryToolPlan;
  readonly spec: ToolSpec;
  readonly used: readonly DataProfile[];
  readonly selectColumns: readonly string[];
  readonly granularities: readonly PeriodGranularity[];
  readonly range: { readonly min: string; readonly max: string };
  readonly hasPeriod: boolean;
  readonly notes: readonly ArgumentNote[];
  readonly language: 'ja' | 'en';
}

/** 説明文を決定的に合成する（目的・データの範囲・各引数の意味と形式と例・返す列・並び）。 */
function describeCompiledTool(input: DescribeInput): string {
  const names = input.used.map((profile) => profile.name).join(' / ');
  const ja = input.language !== 'en';
  const order = input.hasPeriod
    ? (input.spec.output.sort === 'oldest-first'
      ? (ja ? `並び: 期間の古い順に最大 ${input.spec.output.limit} 行。` : `Order: oldest period first, at most ${input.spec.output.limit} rows.`)
      : (ja ? `並び: 期間の新しい順に最大 ${input.spec.output.limit} 行。` : `Order: most recent period first, at most ${input.spec.output.limit} rows.`))
    : (ja ? `並び: データの並び順のまま最大 ${input.spec.output.limit} 行。` : `Order: file order, at most ${input.spec.output.limit} rows.`);

  const dataLine = ja
    ? `対象データ: ${names}${input.hasPeriod ? `（期間 ${input.range.min} 〜 ${input.range.max}、粒度は ${input.granularities.join(' / ')}）` : ''}`
    : `Data: ${names}${input.hasPeriod ? ` (periods from ${input.range.min} to ${input.range.max}; granularities: ${input.granularities.join(', ')})` : ''}`;

  return [
    input.plan.purpose,
    '',
    dataLine,
    ...(ja ? describeArgumentsJa(input.notes) : describeArgumentsEn(input.notes)),
    `${ja ? RETURNED_COLUMNS_PREFIX_JA : RETURNED_COLUMNS_PREFIX_EN}${input.selectColumns.join(', ')}`,
    order,
  ].join('\n');
}

// ── 計算列の後付け・取り下げ ──────────────────────────────────────────────────────

/** `calculateNodeIds[index]` の `calculate` ノードへ式を入れた新しい `CompiledTool` を返す（純関数）。 */
export function withExpression(compiled: CompiledTool, index: number, expression: string): CompiledTool {
  const id = compiled.calculateNodeIds[index];
  if (id === undefined) return compiled;
  return {
    ...compiled,
    graph: {
      nodes: compiled.graph.nodes.map((node) =>
        node.id === id ? { ...node, config: { ...(node.config as Record<string, unknown>), expression } } : node),
      edges: compiled.graph.edges,
    },
  };
}

/**
 * i 番目の計算列を取り下げた新しい `CompiledTool` を返す（純関数）。
 *
 * 式が書けなかった / 検証に落ちた計算列だけを落として、ツール全体は生かすための経路（v42 §5）。
 * `calculate` ノードを外して前後を繋ぎ直し、その列を最後の `select` と説明文の「返す列」から外し、
 * `calculateNodeIds` からも落とす。範囲外の index は何もしない。
 */
export function withoutComputation(compiled: CompiledTool, index: number): CompiledTool {
  const id = compiled.calculateNodeIds[index];
  if (id === undefined) return compiled;
  const node = compiled.graph.nodes.find((candidate) => candidate.id === id);
  const outputColumn = (node?.config as { outputColumn?: unknown } | undefined)?.outputColumn;
  const incoming = compiled.graph.edges.find((edge) => edge.to === id);
  const outgoing = compiled.graph.edges.find((edge) => edge.from === id);

  const edges: GraphEdge[] = [];
  for (const edge of compiled.graph.edges) {
    if (edge.from === id) continue;
    if (edge.to === id) {
      if (incoming === undefined || outgoing === undefined) continue;
      edges.push({ from: incoming.from, to: outgoing.to, ...(outgoing.toInput === undefined ? {} : { toInput: outgoing.toInput }) });
      continue;
    }
    edges.push(edge);
  }

  const nodes = compiled.graph.nodes
    .filter((candidate) => candidate.id !== id)
    .map((candidate) => {
      if (candidate.id !== TOOL_SPEC_NODE_IDS.select || typeof outputColumn !== 'string') return candidate;
      const config = candidate.config as { columns?: readonly string[] };
      return { ...candidate, config: { ...config, columns: (config.columns ?? []).filter((column) => column !== outputColumn) } };
    });

  const selectColumns = (nodes.find((candidate) => candidate.id === TOOL_SPEC_NODE_IDS.select)?.config as { columns?: readonly string[] } | undefined)?.columns;
  return {
    ...compiled,
    graph: { nodes, edges },
    agentTool: {
      ...compiled.agentTool,
      description: withReturnedColumns(compiled.agentTool.description, selectColumns),
    },
    calculateNodeIds: compiled.calculateNodeIds.filter((_, position) => position !== index),
  };
}

/** 説明文の「返す列」行だけを新しい列一覧で書き直す（他の行には触らない）。 */
function withReturnedColumns(description: string, columns: readonly string[] | undefined): string {
  if (columns === undefined) return description;
  return description
    .split('\n')
    .map((line) => {
      for (const prefix of [RETURNED_COLUMNS_PREFIX_JA, RETURNED_COLUMNS_PREFIX_EN]) {
        if (line.startsWith(prefix)) return `${prefix}${columns.join(', ')}`;
      }
      return line;
    })
    .join('\n');
}
