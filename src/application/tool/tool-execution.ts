/**
 * application層: 保存済み Tool を実引数で実行可能なグラフへ解決する共有ロジック。
 *
 * Agent 実行（run-agent-preview）とツール検証（tool-check）が**同じ関数**で引数を束縛する。
 * 別実装を持つと「検証では通るのに Agent から呼ぶと落ちる」食い違いが生まれるため、
 * ここへ1本化して両者から import する（振る舞いは run-agent-preview にあった元実装と同一）。
 */
import type { Cell, Row, Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { isFilterOp, MAX_FILTER_VALUES, MULTI_VALUE_OPS, operatorArgumentSummaries, parseFilterValueList, VALUELESS_OPS, type OperatorArgumentSummary } from '../../domain/etl/nodes/filter';
import type { Tool } from '../../domain/tool/tool';
import { AgentRunError, ToolArgumentsError } from '../agent/errors';
import { agentInputInconsistency } from '../agent/tool-schema';

/**
 * row から Agent 引数を読む。渡されていれば Cell（nullable 宣言の省略は validateToolArguments が
 * null へ正規化済み）、inputSchema に宣言の無い field なら undefined。宣言済み必須引数の欠損は
 * validateToolArguments が先に弾くため、ここで undefined になるのは未宣言の field だけ。
 * 演算子側（conditionWithOperatorArgument）と値側（conditionWithArgument）で判定を共有する。
 */
function agentArgumentOf(row: Row, field: string): Cell | undefined {
  return Object.prototype.hasOwnProperty.call(row, field) ? row[field] ?? null : undefined;
}

/**
 * 条件がアクティブな opBinding（source:'agent-input' かつ field が非空文字列）を持つならその field。
 * 形の壊れた opBinding は「持たない」ものとして扱う（opBinding を読まなかった旧ランタイムでは
 * 不活性だったデータなので、エラーにすると以前は動いていたツールが止まる）。
 */
function operatorBindingFieldOf(condition: unknown): string | undefined {
  const binding = (condition as { opBinding?: { source?: unknown; field?: unknown } } | null)?.opBinding;
  return binding?.source === 'agent-input' && typeof binding.field === 'string' && binding.field !== ''
    ? binding.field
    : undefined;
}

/**
 * filter の1条件について `opBinding: { source:'agent-input', field }` を実行時の演算子へ解決する。
 * アクティブな opBinding が無ければ同一参照をそのまま返す（差し替えの有無を呼び出し側が判定できる）。
 *
 * 引数が row に存在しない（= inputSchema 未宣言）場合は、設計時の `op` のまま条件を生かす
 * 不活性フォールバックとする。valueBinding は値が無いと条件が成立しないため未宣言 field を
 * エラーとする一方、op には設計時の既定があるため、opBinding を読まなかった旧ランタイムと同じ
 * 「設計時 op で実行」へ静かに落とせる（未宣言 field を含む旧データで Run を止めない）。
 *
 * `optionalFields`（inputSchema で nullable な引数名）に含まれる引数が省略された／null のときも
 * 設計時の `op` を既定演算子としてそのまま使う（条件は生かす。valueBinding の disabled 注入と違い、
 * 「演算子を任せない」だけで絞り込み自体は行う）。
 *
 * 演算子の検証は条件単体の allowed ではなく、同じ field をバインドする全条件（全 filter ノード横断）の
 * 許可リストの積集合 `operatorSummaries`（domain の operatorArgumentSummaries で消毒・集約済み）に
 * 対して行う。積集合内の演算子は全条件が受理するため per-condition の検証は不要で、Tool 公開スキーマの
 * enum・エラーの修復ヒントと必ず一致する。FilterOp でない・積集合に無い引数は ToolArgumentsError に
 * して、モデルの引数修復ループ（差し戻して呼び直させる）へ乗せる。積集合が空（SaveTool の検証を
 * 経ていない壊れた定義）は引数の直しようがないため AgentRunError で実行を止める。
 */
function conditionWithOperatorArgument(nodeId: string, condition: unknown, row: Row, optionalFields: ReadonlySet<string>, operatorSummaries: ReadonlyMap<string, OperatorArgumentSummary>): unknown {
  const field = operatorBindingFieldOf(condition);
  if (field === undefined) return condition;
  const argument = agentArgumentOf(row, field);
  if (argument === undefined) return condition;
  if (optionalFields.has(field) && argument === null) return condition;
  const allowed = operatorSummaries.get(field)?.allowed;
  if (allowed === undefined || allowed.length === 0) {
    throw new AgentRunError(`filter node '${nodeId}' operator binding for argument '${field}' has no operator that every condition allows`);
  }
  if (!isFilterOp(argument) || !allowed.includes(argument)) {
    throw new ToolArgumentsError(`invalid operator '${String(argument)}' for argument '${field}': expected one of ${allowed.join(', ')}`);
  }
  return argument === (condition as { op?: unknown }).op ? condition : { ...(condition as Record<string, unknown>), op: argument };
}

/**
 * filter の1条件について agent-input バインディングを実引数へ解決する。opBinding（演算子）を
 * valueBinding（値）より先に解決し、どちらの差し替えも起きなければ同一参照をそのまま返す
 * （差し替えの有無を呼び出し側が判定できる）。
 *
 * 条件がアクティブな opBinding を持ち、実効演算子（opBinding 解決後の op）が isNull/notNull の
 * とき、その条件は value を評価しないため valueBinding の解決（value 差し替え・disabled 注入・
 * 欠損エラー）を丸ごとスキップする。value 側の nullable 引数が省略されていても条件は disabled に
 * せず isNull/notNull として評価する。opBinding を持たない条件（設計時 op=isNull/notNull 固定に
 * valueBinding が残っている形）ではこのスキップを適用せず、disabled 注入・欠損エラーが従来どおり
 * 働く（演算子のAI引数化以前に保存されたツールの「nullable 引数省略 → 条件スキップ」を変えない）。
 *
 * `optionalFields`（inputSchema で nullable な引数名）に含まれる引数が省略された／null のときは
 * value を触らず `disabled: true` を注入し、その条件を実行時にスキップさせる（「全リージョン」の
 * ように絞り込み自体が不要なケース）。nullable でない引数は従来どおり欠損をエラーにする。
 *
 * 演算子が `in` / `notIn` の条件は `value` ではなく **`values`（値の並び）** を差し替える。
 * 引数は1つの文字列に区切り文字で値を並べたもの（`"東京都, 大阪府,北海道"`）で、ここで分解して
 * `values` にする。分解結果が空なら「省略された」と同じくその条件を外し、100 件を超えたら
 * モデルの引数修復ループへ戻す `ToolArgumentsError` にする。
 */
function conditionWithArgument(nodeId: string, condition: unknown, row: Row, optionalFields: ReadonlySet<string>, operatorSummaries: ReadonlyMap<string, OperatorArgumentSummary>): unknown {
  const resolved = conditionWithOperatorArgument(nodeId, condition, row, optionalFields, operatorSummaries);
  if (operatorBindingFieldOf(condition) !== undefined) {
    const op = (resolved as { op?: unknown } | null)?.op;
    if (isFilterOp(op) && VALUELESS_OPS.has(op)) return resolved;
  }
  const binding = (resolved as { valueBinding?: { source?: unknown; field?: unknown } } | null)?.valueBinding;
  if (binding?.source !== 'agent-input') return resolved;
  const field = typeof binding.field === 'string' ? binding.field : '';
  const argument = agentArgumentOf(row, field);
  if (optionalFields.has(field) && (argument === undefined || argument === null)) {
    return { ...(resolved as Record<string, unknown>), disabled: true };
  }
  if (argument === undefined) {
    throw new AgentRunError(`filter node '${nodeId}' references an unavailable Agent input`);
  }
  const op = (resolved as { op?: unknown } | null)?.op;
  if (isFilterOp(op) && MULTI_VALUE_OPS.has(op)) {
    const values = valueListOf(argument);
    // 分解した結果が空（`""` や区切り文字だけ）なら「渡されなかった」と同じ＝この条件を行わない。
    // in なら全滅・notIn なら素通しと意味が静かに変わるため、絞り込みごと外す方が意図に近い。
    if (values.length === 0) return { ...(resolved as Record<string, unknown>), disabled: true };
    if (values.length > MAX_FILTER_VALUES) {
      throw new ToolArgumentsError(`argument '${field}' has too many values (${values.length}); pass at most ${MAX_FILTER_VALUES} values separated by commas`);
    }
    return { ...(resolved as Record<string, unknown>), values };
  }
  return { ...(resolved as Record<string, unknown>), value: argument };
}

/**
 * `in` / `notIn` の引数を値の並びへ分解する。文字列は区切り（`,` `、` `，` `;` 改行）で分け、
 * 前後の空白を落とし、空要素を捨て、重複を除く（domain の `parseFilterValueList`）。
 * 文字列以外（number 型引数などを束縛した古い定義）は 1 要素の並びとして扱う。
 * 要素の型を列へ寄せる（日付の ISO 解釈・数値化）のは domain の `prepareFilterCondition` の仕事で、
 * 読めない要素はそこで「どの要素が読めなかったか」を名指ししたエラーになる。
 */
function valueListOf(argument: Cell): readonly Cell[] {
  if (typeof argument === 'string') return parseFilterValueList(argument);
  return argument === null ? [] : [argument];
}

/**
 * filter config の agent-input バインディングを実行時引数で解決する。旧形式（フラットな1条件）と
 * 新形式（`{ conditions, combine }`）の両方を扱い、元の形式を保ったまま op / value だけを差し替える。
 */
function filterConfigWithArguments(nodeId: string, config: unknown, row: Row, optionalFields: ReadonlySet<string>, operatorSummaries: ReadonlyMap<string, OperatorArgumentSummary>): unknown {
  const conditions = (config as { conditions?: unknown } | null)?.conditions;
  if (!Array.isArray(conditions)) return conditionWithArgument(nodeId, config, row, optionalFields, operatorSummaries);
  const bound = conditions.map((condition) => conditionWithArgument(nodeId, condition, row, optionalFields, operatorSummaries));
  if (bound.every((condition, index) => condition === conditions[index])) return config;
  return { ...(config as Record<string, unknown>), conditions: bound };
}

/**
 * Tool のグラフへ Agent 引数（validateToolArguments 済みの row）を束縛した実行用グラフを返す。
 * agent-input ノードの sample を row で置き換え、filter の agent-input バインディングを解決する。
 */
export function graphWithArguments(tool: Tool, row: Row): ToolGraph {
  // nullable 宣言された引数だけが「省略 → 条件スキップ」の対象になる。
  const optionalFields = new Set((tool.inputSchema?.columns ?? []).filter((column) => column.nullable).map((column) => column.name));
  // 演算子引数は field 単位で全 filter ノードの許可リストを積集合へ集約してから検証する。
  // 条件単体の allowed で検証すると、同じ field を異なる allowed でバインドする条件があるとき
  // 公開スキーマの enum（積集合）と矛盾する修復ヒントを返し、Run が失敗し続けるため。
  const operatorSummaries = new Map(
    operatorArgumentSummaries(tool.graph.nodes.filter((node) => node.type === 'filter').map((node) => node.config))
      .map((summary) => [summary.field, summary] as const),
  );
  // 引数宣言と agent-input ノードの整合は、保存時（SaveTool）・診断（DiagnoseTool）と同じ判定関数で
  // 検査する。実行時にだけ通る別実装を残すと「診断は ok なのに実行で落ちる」食い違いが再発する。
  const inconsistency = agentInputInconsistency(tool);
  if (inconsistency !== undefined) throw new AgentRunError(inconsistency);
  const nodes = tool.graph.nodes.map((node) => {
    if (node.type === 'agent-input') {
      const config = node.config as { schema?: Schema };
      return { ...node, config: { ...config, sample: row } };
    }
    if (node.type !== 'filter') return node;
    const config = filterConfigWithArguments(node.id, node.config, row, optionalFields, operatorSummaries);
    return config === node.config ? node : { ...node, config };
  });
  return { nodes, edges: tool.graph.edges };
}
