/**
 * application層: ツール実行が 0 行になった理由を**決定的に**（LLM を使わずに）説明する。
 *
 * ## なぜ要るか
 * 空の `[]` だけを返されたモデルは、どの引数が外れたのかも、そもそもどんな値がデータにあるのかも
 * 知りようがない。実測では `{"region_name":"東京都","time_point":"2015年12月31日"}` で呼ばれた
 * ツールが（データは年次行しか持たないため）0 行を返し、モデルはそこから記憶で人口を捏造した。
 * 「時点 に 2015年12月31日 は無い。実在するのは 2015年, 2016年 …」と**データに基づいて**返せば、
 * モデルは引数を直して呼び直すか、「該当データなし」と答えられる。
 *
 * ## やること
 * トポロジカル順で「入力は行があるのに出力が 0 行」になった最初のノードを探し、それが filter なら
 * 各**有効**条件を入力表へ単独で当てて件数を数える。0 件の条件（AND の組み合わせだけが 0 になる
 * 場合は全条件）には、その列に実在する値の例（要求値に近いものを優先）か、数値・日付なら最小・最大を
 * 添える。判定は domain の `prepareFilterCondition` / `rowMatchesFilterCondition` を使う
 * ＝ 実行が行を残した規則そのもので数えるので、診断と実行が食い違わない。
 *
 * ## 境界
 * - 純関数。副作用も LLM 呼び出しも無い（ツール検証 = Tool Check の結果にも影響しない）。
 * - 値はデータそのものなので、**JSON の値としてのみ**運ぶ（指示文には混ぜない）。
 * - 上限: 値は 8 個 × 80 文字、診断全体で約 1.5KB。超えたら値の数 → 条件の数の順に削る。
 */
import type { Cell, Table } from '../../domain/data/types';
import { findColumn } from '../../domain/data/schema';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import {
  filterNode,
  normalizeFilterConfig,
  prepareFilterCondition,
  rowMatchesFilterCondition,
  type FilterCondition,
  type FilterConfig,
} from '../../domain/etl/nodes/filter';
import { topologicalSort } from '../../domain/etl/topo';
import type { RunNoMatch, RunNoMatchCondition } from '../../domain/run/run';

/** 値の例をいくつまで出すか。 */
export const MAX_AVAILABLE_VALUES = 8;
/** 値の例 1 つあたりの最大文字数（超過分は … で切る）。 */
export const MAX_VALUE_CHARS = 80;
/** 診断全体の最大バイト数（ツール結果としてモデルへ渡るので小さく保つ）。 */
export const MAX_DIAGNOSIS_BYTES = 1_500;

/** 値の例を添える演算子（文字列の一致・包含だけ。大小比較は min/max で示す）。 */
const VALUE_HINT_OPS: ReadonlySet<string> = new Set(['eq', 'neq', 'contains', 'in', 'notIn']);

/** 0 件の条件があるときの差し戻し文。データの値そのものは JSON 側にだけ置く。 */
const NO_MATCH_MESSAGE = 'No rows matched. Do not answer from memory: tell the user no data matched, or call the tool again with one of the available values.';
/** どの条件も単独では行に当たるのに、組み合わせると 0 件になるときの差し戻し文。 */
const COMBINATION_MESSAGE = 'No rows matched. Each condition matches rows on its own, but no row satisfies all of them together. Do not answer from memory: tell the user no data matched, or call the tool again with a different combination.';

export interface EmptyResultDiagnosisInput {
  /** 実行に使ったグラフ（Agent 引数を束縛した後のもの）。 */
  readonly graph: ToolGraph;
  /** nodeId → そのノードが出した**全行**のテーブル。 */
  readonly tables: ReadonlyMap<string, Table>;
}

/**
 * 0 行の理由を組み立てる。説明できない（filter が原因ではない・そもそも入力から空）ときは undefined。
 * 呼び出し側は undefined のとき従来どおりの内容をモデルへ返す。
 */
export function diagnoseEmptyResult(input: EmptyResultDiagnosisInput): RunNoMatch | undefined {
  const culprit = firstEmptyNode(input.graph, input.tables);
  if (culprit === undefined || culprit.node.type !== 'filter') return undefined;

  let prepared: readonly FilterCondition[];
  let combine: 'and' | 'or';
  try {
    const config = filterNode.validateConfig(culprit.node.config) as FilterConfig;
    const normalized = normalizeFilterConfig(config);
    combine = normalized.combine;
    prepared = normalized.conditions.map((condition) => prepareFilterCondition(culprit.input, condition));
  } catch {
    // 実行を通っている config なので通常は起きない。診断のために実行を止めることはしない。
    return undefined;
  }
  if (prepared.length === 0) return undefined;

  const counts = prepared.map((condition) => culprit.input.rows.filter((row) => rowMatchesFilterCondition(row, condition)).length);
  // 単独で 0 件の条件が犯人。1 つも無ければ「組み合わせ」が犯人なので全条件に値の手がかりを添える。
  const zeroSome = counts.some((count) => count === 0);
  const conditions = prepared.map((condition, index) => describeCondition(
    culprit.input,
    condition,
    counts[index] ?? 0,
    zeroSome ? counts[index] === 0 : true,
  ));
  return fit({
    message: zeroSome ? NO_MATCH_MESSAGE : COMBINATION_MESSAGE,
    nodeId: culprit.node.id,
    combine,
    conditions,
  });
}

/** トポロジカル順で「入力に行があるのに出力が 0 行」になった最初のノードと、その（非空の）入力表。 */
function firstEmptyNode(graph: ToolGraph, tables: ReadonlyMap<string, Table>): { readonly node: GraphNode; readonly input: Table } | undefined {
  const order = topologicalSort(graph.nodes.map((node) => node.id), graph.edges.map((edge) => ({ from: edge.from, to: edge.to })));
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const inputsOf = new Map<string, string[]>();
  for (const edge of [...graph.edges].sort((left, right) => (left.toInput ?? 0) - (right.toInput ?? 0))) {
    const list = inputsOf.get(edge.to);
    if (list === undefined) inputsOf.set(edge.to, [edge.from]);
    else list.push(edge.from);
  }
  for (const id of order) {
    const node = byId.get(id);
    const output = tables.get(id);
    if (node === undefined || output === undefined || output.rows.length > 0) continue;
    const source = (inputsOf.get(id) ?? [])
      .map((from) => tables.get(from))
      .find((table) => table !== undefined && table.rows.length > 0);
    if (source !== undefined) return { node, input: source };
  }
  return undefined;
}

/**
 * 条件 1 つの内訳。`hint` が true のときだけ、その列に実在する値（または最小・最大）を添える。
 * 複数値条件（in/notIn）では要求した値の並びと、**そのうち 1 行も当たらなかった値**を添える
 * （「3 県のうち北海道だけが空振りした」と分かれば、モデルは残り 2 県の結果を使って答えられる）。
 */
function describeCondition(input: Table, condition: FilterCondition, matchingRows: number, hint: boolean): RunNoMatchCondition {
  const argument = condition.valueBinding?.source === 'agent-input' ? condition.valueBinding.field : undefined;
  const values = condition.values;
  const base: RunNoMatchCondition = {
    column: condition.column,
    op: condition.op,
    ...(argument === undefined ? {} : { argument }),
    value: jsonValue(condition.value ?? null),
    ...(values === undefined ? {} : { values: values.slice(0, MAX_AVAILABLE_VALUES).map(jsonValue) }),
    matchingRows,
  };
  if (!hint) return base;
  const unmatched = unmatchedValues(input, condition);
  return { ...base, ...(unmatched === undefined ? {} : { unmatchedValues: unmatched }), ...valueHints(input, condition) };
}

/**
 * `in` の要求値のうち、その値**だけ**で当ててみても 1 行も残らなかったもの（上限まで）。
 * `notIn` は「除外した値」なので空振りという概念が無く、undefined を返す。
 */
function unmatchedValues(input: Table, condition: FilterCondition): readonly string[] | undefined {
  if (condition.op !== 'in' || condition.values === undefined) return undefined;
  const missed = condition.values.filter((value) =>
    !input.rows.some((row) => rowMatchesFilterCondition(row, { ...condition, values: [value] })));
  return missed.slice(0, MAX_AVAILABLE_VALUES).map((value) => truncate(String(jsonValue(value))));
}

/** 手がかりの近さを測る基準値（単値は value、複数値は空振りした値 → 無ければ全要求値）。 */
function requestedValues(input: Table, condition: FilterCondition): readonly string[] {
  if (condition.values !== undefined) {
    const missed = unmatchedValues(input, condition);
    const targets = missed !== undefined && missed.length > 0 ? missed : condition.values.map((value) => String(jsonValue(value)));
    return targets.map((value) => String(value));
  }
  return [condition.value === undefined || condition.value === null ? '' : String(jsonValue(condition.value))];
}

/** 列の実在値の手がかり（文字列は値の例 + 異なり数、数値・日付は最小最大 + 異なり数）。 */
function valueHints(input: Table, condition: FilterCondition): Partial<RunNoMatchCondition> {
  const type = findColumn(input.schema, condition.column)?.type;
  const cells = input.rows.map((row) => row[condition.column]).filter((cell): cell is Cell => cell !== undefined && cell !== null);
  if (cells.length === 0) return {};
  if (type === 'number' || type === 'date') {
    const ordered = cells.map(comparable).filter((value) => !Number.isNaN(value));
    if (ordered.length === 0) return {};
    // 25万行を `Math.min(...ordered)` で畳むと引数展開でスタックが溢れるので走査で求める。
    let low = ordered[0] as number;
    let high = low;
    for (const value of ordered) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
    return { min: boundary(low, type), max: boundary(high, type), distinctValues: new Set(ordered).size };
  }
  if (!VALUE_HINT_OPS.has(condition.op)) return {};
  const distinct = [...new Set(cells.map((cell) => String(jsonValue(cell))))];
  return { availableValues: rankValues(distinct, requestedValues(input, condition)), distinctValues: distinct.length };
}

/**
 * 要求値に「近い」値を先に出す: 包含し合う値 → 先頭が一致する値 → 出現順。
 * 複数値条件では空振りした要求値すべてに対して測り、いちばん近い1つの点数を採る
 * （「北海道」が外れたなら北海道に近い値を先に出す）。
 */
function rankValues(values: readonly string[], requested: readonly string[]): readonly string[] {
  const targets = requested.map((value) => value.toLowerCase());
  const scored = values.map((value, index) => {
    const lower = value.toLowerCase();
    const related = targets.some((target) => target !== '' && (lower.includes(target) || target.includes(lower)));
    const prefix = Math.max(0, ...targets.map((target) => commonPrefixLength(lower, target)));
    return { value, index, score: related ? 2 : prefix > 0 ? 1 : 0, prefix };
  });
  scored.sort((left, right) => right.score - left.score || right.prefix - left.prefix || left.index - right.index);
  return scored.slice(0, MAX_AVAILABLE_VALUES).map((entry) => truncate(entry.value));
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function truncate(value: string): string {
  return value.length <= MAX_VALUE_CHARS ? value : `${value.slice(0, MAX_VALUE_CHARS - 1)}…`;
}

/** 順序比較用の数値（number はそのまま / Date は時刻値 / 他は NaN）。filter の比較と同じ寄せ方。 */
function comparable(cell: Cell): number {
  if (typeof cell === 'number') return cell;
  if (cell instanceof Date) return cell.getTime();
  return Number.NaN;
}

/** 最小・最大の表示値（日付は ISO 文字列、数値はそのまま）。 */
function boundary(value: number, type: 'number' | 'date'): string | number {
  return type === 'date' ? new Date(value).toISOString() : value;
}

/** Cell を JSON で運べる値へ（Date は ISO 文字列）。 */
function jsonValue(cell: Cell): string | number | boolean | null {
  return cell instanceof Date ? cell.toISOString() : cell;
}

/** 上限バイト数へ収める。値の例を減らし、それでも大きければ条件を後ろから落とす。 */
function fit(noMatch: RunNoMatch): RunNoMatch {
  for (const limit of [MAX_AVAILABLE_VALUES, 4, 2, 0]) {
    const trimmed = withValueLimit(noMatch, limit);
    if (byteLength(trimmed) <= MAX_DIAGNOSIS_BYTES) return trimmed;
  }
  const bare = withValueLimit(noMatch, 0);
  let conditions = bare.conditions;
  while (conditions.length > 1 && byteLength({ ...bare, conditions }) > MAX_DIAGNOSIS_BYTES) {
    conditions = conditions.slice(0, -1);
  }
  return { ...bare, conditions };
}

function withValueLimit(noMatch: RunNoMatch, limit: number): RunNoMatch {
  return {
    ...noMatch,
    conditions: noMatch.conditions.map((condition) => {
      // 実在値の例・要求値・空振りした値は同じ上限で削る（いずれもデータ由来の可変長）。
      const trimmed = {
        ...condition,
        ...(condition.availableValues === undefined ? {} : { availableValues: condition.availableValues.slice(0, limit) }),
        ...(condition.unmatchedValues === undefined ? {} : { unmatchedValues: condition.unmatchedValues.slice(0, limit) }),
        ...(condition.values === undefined ? {} : { values: condition.values.slice(0, Math.max(limit, 1)) }),
      };
      if (limit > 0) return trimmed;
      const { availableValues: _values, unmatchedValues: _unmatched, ...rest } = trimmed;
      return rest;
    }),
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
}

/**
 * 診断を人が読める文章へ（agent-output の format が json でないときの本文）。
 * 値は行頭の `- ` に続くデータとしてだけ置き、指示文と混ざらないようにする。
 */
export function noMatchText(noMatch: RunNoMatch): string {
  const lines = noMatch.conditions.map((condition) => {
    const argument = condition.argument === undefined ? '' : ` (argument ${condition.argument})`;
    // 複数値条件は要求した並びをそのまま見せる（単値の value は null で意味を持たない）。
    const requested = JSON.stringify(condition.values ?? condition.value);
    const unmatched = condition.unmatchedValues === undefined || condition.unmatchedValues.length === 0
      ? ''
      : `; no rows for: ${condition.unmatchedValues.join(', ')}`;
    const examples = condition.availableValues === undefined || condition.availableValues.length === 0
      ? ''
      : `; values in this column include: ${condition.availableValues.join(', ')}`;
    const range = condition.min === undefined || condition.max === undefined ? '' : `; range: ${String(condition.min)} .. ${String(condition.max)}`;
    const distinct = condition.distinctValues === undefined ? '' : ` (${condition.distinctValues} distinct)`;
    return `- ${condition.column} ${condition.op} ${requested}${argument} matched ${condition.matchingRows} rows${unmatched}${examples}${range}${examples === '' && range === '' ? '' : distinct}`;
  });
  return [noMatch.message, ...lines].join('\n');
}
