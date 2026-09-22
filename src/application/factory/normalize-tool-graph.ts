/**
 * application層: ToolSmith の提案グラフを**機械的な書き間違いだけ**決定的に直す正規化
 * （ADR-0047 第4ラウンド / docs/16-agent-factory.md §4 Stage 2）。
 *
 * ローカル12Bモデルの実測では、計画は正しいのに ToolSmith が修復試行を「書き方の癖」で
 * 使い切った: `join` の2本のエッジに `toInput` を片方しか書かない（3回中2回同じ失敗）、
 * `in` 条件に設計時の `values` を置かない、filter の config を `operator` / `field` /
 * `conditions` の別名で書く、など。どれも**意味は一意に決まる**ので、モデルへ差し戻す前に
 * ここで直す。
 *
 * 守る線引き:
 * - **意味は正規化しない**。ノードを足さない・消さない、列名を変えない、値を発明しない。
 *   直すのは「同じ意味の別表記」と「一意に決まる欠落」だけ。
 * - 直した内容は必ず `changes` として返し、呼び出し側がイベント（`tool_generated` の message）
 *   へ残す。黙って直すと、モデルの癖が直っていないことに誰も気づけない。
 * - 認識できない崩れ方は触らない。そのまま修復ループへ流し、差し戻し文面で直させる。
 */
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import { FILTER_OPS, MAX_FILTER_VALUES, MULTI_VALUE_OPS, VALUELESS_OPS, parseFilterValueList } from '../../domain/etl/nodes/filter';
import { PARSE_PERIOD_TYPE } from '../../domain/etl/nodes/parse-period';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { PropagationResult } from '../etl/engine';
import type { DataProfile } from './profile-data-sources';
import { repairDataSourceIds } from './roles/planner-role';

/** `join` ノードの型名（正規化の対象を名指しするために持つ）。 */
const JOIN_TYPE = 'join';
const FILTER_TYPE = 'filter';

/** 正規化の入力（主ソースが `join` の左（`toInput: 0`）になる、という既定を決めるために使う）。 */
export interface NormalizeToolGraphContext {
  /** 計画の主データソース。`join` のポートを推測するとき、この枝を左に置く。 */
  readonly primaryDataSourceId: string;
  /** 主ソース + 結合する追加ソースのプロファイル（`in` の設計時サンプル値の出どころ）。 */
  readonly profiles: readonly DataProfile[];
  /**
   * このToolが読むデータソースid（主ソース → 追加ソースの順）。source ノードの `dataSourceId` が
   * 抜けているときの割り当てと、写し間違いの補正に使う。未指定なら `profiles` の並びから導く。
   */
  readonly dataSourceIds?: readonly string[];
  /**
   * 正規のノード種別（ToolSmith が使ってよい語彙）。綴りのゆれ（`parse_period` / `agentInput`）を
   * ここへ正規化する。**許可語彙の外へは決して直さない**（直した先で構造検査に落ちるため）。
   */
  readonly knownNodeTypes?: readonly string[];
}

export interface NormalizeToolGraphResult {
  readonly graph: ToolGraph;
  /** 直した内容の人間向け説明（何も直していなければ空）。 */
  readonly changes: readonly string[];
}

/**
 * filter config の「別名で書かれたキー」→ 正規のキー。
 * 実測で観測された書き癖に限る（推測で広げると、別の意味のキーを潰しかねない）。
 */
const FILTER_KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['operator', 'op'],
  ['field', 'column'],
  ['columnName', 'column'],
  ['column_name', 'column'],
]);

/** 1条件だけを包んだ「別名のラッパーキー」。中身が条件の配列/オブジェクトなら `conditions` として読む。 */
const CONDITIONS_WRAPPER_KEYS: readonly string[] = ['condition', 'filters', 'where', 'criteria'];

/** 演算子の別表記 → 正規の演算子。大文字・記号・英単語のゆれを吸収する。 */
const OP_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['equals', 'eq'], ['equal', 'eq'], ['=', 'eq'], ['==', 'eq'], ['===', 'eq'],
  ['notequals', 'neq'], ['notequal', 'neq'], ['!=', 'neq'], ['!==', 'neq'], ['<>', 'neq'],
  ['>=', 'gte'], ['<=', 'lte'], ['>', 'gt'], ['<', 'lt'],
  ['greaterthan', 'gt'], ['lessthan', 'lt'], ['greaterthanorequal', 'gte'], ['lessthanorequal', 'lte'],
  ['includes', 'contains'], ['include', 'contains'], ['like', 'contains'],
  ['notin', 'notIn'], ['not_in', 'notIn'],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 演算子の表記を正規化する（既に正規の演算子ならそのまま）。 */
function canonicalOp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if ((FILTER_OPS as readonly string[]).includes(raw)) return raw;
  const key = raw.trim().toLowerCase().replace(/[\s_-]/g, '');
  const mapped = OP_SYNONYMS.get(raw.trim()) ?? OP_SYNONYMS.get(key);
  if (mapped !== undefined) return mapped;
  // 大文字だけの違い（`IN` → `in`、`GTE` → `gte`）。
  const lowered = FILTER_OPS.find((op) => op.toLowerCase() === key);
  return lowered;
}

/** 1つの条件オブジェクトの「別名キー」「演算子の別表記」を直す。 */
function normalizeCondition(raw: unknown, changes: string[], nodeId: string): unknown {
  if (!isRecord(raw)) return raw;
  let condition = raw;
  for (const [alias, canonical] of FILTER_KEY_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(condition, alias) || Object.prototype.hasOwnProperty.call(condition, canonical)) continue;
    const { [alias]: moved, ...rest } = condition;
    condition = { ...rest, [canonical]: moved };
    changes.push(`filter '${nodeId}': renamed condition key '${alias}' to '${canonical}'`);
  }
  const op = canonicalOp(condition['op']);
  if (op !== undefined && op !== condition['op']) {
    changes.push(`filter '${nodeId}': rewrote operator ${JSON.stringify(condition['op'])} as '${op}'`);
    condition = { ...condition, op };
  }
  // 束縛の `source` は 'agent-input' しか無い。`agent_input` / `input` / `arguments` のような綴りは意味が一意なので直す
  // （実測: 設計アシスタントの 12B が別の綴りを書き、差し戻し 1 回を使っていた）。`field` を持つ束縛だけを対象にする。
  for (const key of ['valueBinding', 'opBinding'] as const) {
    const binding = condition[key];
    if (!isRecord(binding) || typeof binding['field'] !== 'string' || binding['source'] === 'agent-input') continue;
    changes.push(`filter '${nodeId}': rewrote ${key}.source ${JSON.stringify(binding['source'])} as 'agent-input' (the only binding source)`);
    condition = { ...condition, [key]: { ...binding, source: 'agent-input' } };
  }
  return condition;
}

/**
 * `in` / `notIn` 条件に設計時の `values` を用意する。
 *
 * 1. `values` が空で `value` に文字列/配列があれば、それを実行時と同じ区切り
 *    （`parseFilterValueList`）で分解して `values` へ移す。
 * 2. それでも空で、引数にバインドされている条件なら、Stage 0 プロファイルの実在値を
 *    **最大2件**だけ種として置く（プレビューが「空の values」で落ちるのを防ぐためのサンプルであり、
 *    実行時は引数で上書きされる）。実在値が分からなければ**何も置かない**（値を発明しない）。
 */
function normalizeMultiValueCondition(raw: unknown, changes: string[], nodeId: string, profiles: readonly DataProfile[]): unknown {
  if (!isRecord(raw)) return raw;
  const op = raw['op'];
  if (typeof op !== 'string' || !MULTI_VALUE_OPS.has(op as never)) return raw;
  const existing = Array.isArray(raw['values']) ? raw['values'] : [];
  if (existing.length > 0) return raw;

  const fromValue = raw['value'];
  if (typeof fromValue === 'string' && fromValue.trim() !== '') {
    const values = parseFilterValueList(fromValue).slice(0, MAX_FILTER_VALUES);
    if (values.length > 0) {
      changes.push(`filter '${nodeId}': moved the '${op}' condition value ${JSON.stringify(fromValue)} into a 'values' list`);
      return { ...raw, values };
    }
  }
  if (Array.isArray(fromValue) && fromValue.length > 0) {
    changes.push(`filter '${nodeId}': moved the '${op}' condition 'value' array into 'values'`);
    return { ...raw, values: fromValue.slice(0, MAX_FILTER_VALUES) };
  }

  // 引数バインドされた条件だけ、設計時サンプルを種として補う（静的な条件に値を作らない）。
  const binding = raw['valueBinding'];
  if (!isRecord(binding) || binding['source'] !== 'agent-input') return raw;
  const column = typeof raw['column'] === 'string' ? raw['column'] : '';
  const seeds = sampleValuesFor(column, profiles).slice(0, 2);
  if (seeds.length === 0) return raw;
  changes.push(`filter '${nodeId}': seeded the bound '${op}' condition on '${column}' with real sample values ${JSON.stringify(seeds)} (replaced by the agent's argument at run time)`);
  return { ...raw, values: seeds };
}

/**
 * 引数にバインドされた**単一値**の条件（eq / neq / contains / 大小比較）に、設計時の `value` を用意する。
 *
 * 実測（設計アシスタント・12B）: 「地域を引数で絞れるように」に対し `{ op: "eq", value: "", valueBinding: … }`
 * を置いた。実行時は引数で上書きされるので動くが、設計時プレビューは `value` をサンプルとして使うため
 * 画面のプレビューが 0 行になり、人には壊れて見える。`value` が空のときだけ、実在値の先頭 1 件を種として置く
 * （値は発明しない。実在値が分からなければ何も置かない）。`in` / `notIn` は `normalizeMultiValueCondition` が扱う。
 */
function normalizeBoundScalarCondition(raw: unknown, changes: string[], nodeId: string, profiles: readonly DataProfile[], periodStartColumns: ReadonlySet<string>): unknown {
  if (!isRecord(raw)) return raw;
  const op = raw['op'];
  if (typeof op !== 'string' || MULTI_VALUE_OPS.has(op as never) || VALUELESS_OPS.has(op as never)) return raw;
  const binding = raw['valueBinding'];
  if (!isRecord(binding) || binding['source'] !== 'agent-input') return raw;
  const current = raw['value'];
  const empty = current === undefined || current === null || (typeof current === 'string' && current.trim() === '');
  if (!empty) return raw;
  const column = typeof raw['column'] === 'string' ? raw['column'] : '';
  // `parse-period` が足す開始日の列は元データに無いので、プロファイルの期間の範囲（最小 / 最大）を種にする
  // （テンプレートの `$profile: periodMin/periodMax` と同じ値。gte / gt には最小、lte / lt には最大 = 全期間が残る見本）。
  if (periodStartColumns.has(column)) {
    const range = periodRangeOf(profiles);
    const seed = op === 'gte' || op === 'gt' ? range?.min : op === 'lte' || op === 'lt' ? range?.max : undefined;
    if (seed === undefined) return raw;
    changes.push(`filter '${nodeId}': seeded the bound '${op}' condition on '${column}' with the ${op === 'gte' || op === 'gt' ? 'earliest' : 'latest'} period start ${seed} from the data profile (replaced by the agent's argument at run time; the design-time preview was empty without it)`);
    return { ...raw, value: seed };
  }
  const seed = sampleValuesFor(column, profiles)[0];
  if (seed === undefined) return raw;
  changes.push(`filter '${nodeId}': seeded the bound '${op}' condition on '${column}' with the real sample value ${JSON.stringify(seed)} (replaced by the agent's argument at run time; the design-time preview was empty without it)`);
  return { ...raw, value: seed };
}

/** プロファイル全体の期間の範囲（開始日の最小と最大。どのプロファイルにも無ければ undefined）。 */
function periodRangeOf(profiles: readonly DataProfile[]): { readonly min: string; readonly max: string } | undefined {
  const starts = profiles.flatMap((profile) => profile.periodColumns ?? []).flatMap((column) => (column.minStart !== undefined && column.maxStart !== undefined ? [column] : []));
  if (starts.length === 0) return undefined;
  return {
    min: starts.map((column) => column.minStart!).sort()[0]!,
    max: starts.map((column) => column.maxStart!).sort().at(-1)!,
  };
}

/**
 * ある列の実在値を Stage 0 プロファイルから拾う（列挙済みの `categoricalColumns` を優先し、
 * 無ければサンプル行から）。見つからなければ空配列（値は決して作らない）。
 */
export function sampleValuesFor(column: string, profiles: readonly DataProfile[]): string[] {
  if (column === '') return [];
  for (const profile of profiles) {
    const categorical = (profile.categoricalColumns ?? []).find((candidate) => candidate.column === column);
    if (categorical !== undefined && categorical.values.length > 0) return [...categorical.values];
  }
  const found: string[] = [];
  for (const profile of profiles) {
    for (const row of profile.sampleRows ?? []) {
      const value = row[column];
      if (value === null || value === undefined || value === '') continue;
      const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
      if (!found.includes(text)) found.push(text);
    }
    if (found.length > 0) return found;
  }
  return found;
}

/** filter ノード1つの config を正規化する（フラット1条件 / `conditions` 配列 / 別名ラッパーの3形）。 */
function normalizeFilterNode(node: GraphNode, changes: string[], profiles: readonly DataProfile[], periodStartColumns: ReadonlySet<string>): GraphNode {
  if (!isRecord(node.config)) return node;
  let config: Record<string, unknown> = node.config;

  // 別名のラッパーキー（`condition` / `filters` / `where` / `criteria`）を `conditions` として読む。
  if (!Object.prototype.hasOwnProperty.call(config, 'conditions') && config['column'] === undefined) {
    for (const wrapper of CONDITIONS_WRAPPER_KEYS) {
      const wrapped = config[wrapper];
      if (wrapped === undefined) continue;
      const conditions = Array.isArray(wrapped) ? wrapped : [wrapped];
      if (!conditions.every((item) => isRecord(item))) continue;
      const { [wrapper]: _removed, ...rest } = config;
      config = { ...rest, conditions };
      changes.push(`filter '${node.id}': read the '${wrapper}' key as 'conditions'`);
      break;
    }
  }

  const apply = (raw: unknown): unknown =>
    normalizeBoundScalarCondition(normalizeMultiValueCondition(normalizeCondition(raw, changes, node.id), changes, node.id, profiles), changes, node.id, profiles, periodStartColumns);

  const conditions = config['conditions'];
  const normalized = Array.isArray(conditions)
    ? { ...config, conditions: conditions.map(apply) }
    : apply(config);

  return normalized === node.config ? node : { ...node, config: normalized };
}

/**
 * `join` の2本のエッジへ `toInput` 0/1 を決定的に割り当てる。
 *
 * - 片方だけ欠けている → 残っているポートの反対を入れる。
 * - 両方欠けている → **計画の主データソースから伸びる枝**を左（0）に、もう一方を右（1）に。
 *   どちらの枝も主ソースへ辿り着かない場合はエッジの並び順で 0/1 を振る。
 * - 同じポートを2本が持っている → 2本目を空いているポートへ直す。
 */
function normalizeJoinPorts(graph: ToolGraph, context: NormalizeToolGraphContext, changes: string[]): ToolGraph {
  const joins = graph.nodes.filter((node) => node.type === JOIN_TYPE);
  if (joins.length === 0) return graph;
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  let edges = graph.edges;

  for (const join of joins) {
    const indices = edges.map((edge, index) => ({ edge, index })).filter((entry) => entry.edge.to === join.id);
    if (indices.length !== 2) continue; // 2本でない形は構造検査の仕事。

    const ports = indices.map((entry) => (entry.edge.toInput === 0 || entry.edge.toInput === 1 ? entry.edge.toInput : undefined));
    if (ports[0] !== undefined && ports[1] !== undefined && ports[0] !== ports[1]) continue; // 既に正しい。

    let assigned: [number, number];
    if (ports[0] !== undefined && ports[1] === undefined) assigned = [ports[0], ports[0] === 0 ? 1 : 0];
    else if (ports[0] === undefined && ports[1] !== undefined) assigned = [ports[1] === 0 ? 1 : 0, ports[1]];
    else if (ports[0] !== undefined && ports[1] !== undefined) assigned = [ports[0], ports[0] === 0 ? 1 : 0]; // 同じポートの重複。
    else {
      // 両方欠落: 主データソースの枝を左に置く。
      const fromPrimary = indices.map((entry) => branchReadsPrimary(entry.edge.from, byId, edges, context.primaryDataSourceId));
      assigned = fromPrimary[1] === true && fromPrimary[0] !== true ? [1, 0] : [0, 1];
    }

    const next = [...edges];
    indices.forEach((entry, position) => {
      const port = assigned[position]!;
      if (entry.edge.toInput === port) return;
      next[entry.index] = { ...entry.edge, toInput: port };
      changes.push(`join '${join.id}': set "toInput": ${port} on the edge from '${entry.edge.from}' (it was ${JSON.stringify(entry.edge.toInput ?? null)})`);
    });
    edges = next;
  }
  return edges === graph.edges ? graph : { nodes: graph.nodes, edges };
}

/** あるノードから上流へ辿り、計画の主データソースを読む source に行き着くか。 */
function branchReadsPrimary(
  nodeId: string,
  byId: ReadonlyMap<string, GraphNode>,
  edges: ToolGraph['edges'],
  primaryDataSourceId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = nodeId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = byId.get(current);
    if (node === undefined) return false;
    const dataSourceId = isRecord(node.config) ? node.config['dataSourceId'] : undefined;
    if (dataSourceId === primaryDataSourceId) return true;
    const incoming: string | undefined = edges.find((edge) => edge.to === current)?.from;
    current = incoming;
  }
  return false;
}

/** source ノードの型（`dataSourceId` を持つ読み取り元）。 */
const SOURCE_TYPES: readonly string[] = ['csv-source', 'json-source'];
const AGENT_INPUT_TYPE = 'agent-input';

/**
 * ノード種別の綴りを正規の語彙へ寄せる（`parse_period` / `parsePeriod` / `Parse-Period` → `parse-period`）。
 * 小文字化し、`_`・空白・camelCase の切れ目をすべて `-` と見なして**完全一致**した場合だけ直す。
 * 2つ以上の語彙に一致する場合（現実には起きないが）は、どちらか分からないので触らない。
 */
export function canonicalNodeType(written: string, knownTypes: readonly string[]): string | undefined {
  const fold = (value: string): string => value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  const wanted = fold(written);
  const matches = [...new Set(knownTypes.filter((type) => fold(type) === wanted))];
  const only = matches[0];
  return matches.length === 1 && only !== written ? only : undefined;
}

/** ノード種別の綴りゆれを直す。 */
function normalizeNodeTypes(graph: ToolGraph, knownTypes: readonly string[], changes: string[]): ToolGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (typeof node.type !== 'string' || knownTypes.includes(node.type)) return node;
    const canonical = canonicalNodeType(node.type, knownTypes);
    if (canonical === undefined) return node;
    changed = true;
    changes.push(`node '${node.id}': rewrote the node type '${node.type}' as '${canonical}'`);
    return { ...node, type: canonical };
  });
  return changed ? { nodes, edges: graph.edges } : graph;
}

/**
 * source ノードの `dataSourceId` の欠落を、計画の並び（主ソース → 追加ソース）で埋める。
 *
 * - source ノードの数が計画のソース数と一致し、**未割り当ての数と残りの計画idの数が合う**ときだけ埋める
 *   （どのノードがどのソースか一意に決まる場合に限る）。
 * - 既に書かれている id が計画に無い場合は、`repairDataSourceIds`（Planner と同じ編集距離の規則）で
 *   写し間違いを直せるなら直し、直せなければ触らずに構造検査へ委ねる（別の表を勝手に読ませない）。
 */
function normalizeSourceIds(graph: ToolGraph, dataSourceIds: readonly string[], changes: string[]): ToolGraph {
  const sources = graph.nodes.filter((node) => SOURCE_TYPES.includes(node.type));
  if (sources.length === 0 || dataSourceIds.length === 0) return graph;

  const idOf = (node: GraphNode): unknown => (isRecord(node.config) ? node.config['dataSourceId'] : undefined);
  const known = new Set(dataSourceIds);
  const repaired = new Map<string, string>();
  for (const node of sources) {
    const written = idOf(node);
    if (typeof written !== 'string' || written === '' || known.has(written)) continue;
    const fixed = repairDataSourceTypo(written, dataSourceIds);
    if (fixed !== written) repaired.set(node.id, fixed);
  }

  // 埋める対象は「id がそもそも書かれていない」ノードだけ。**書かれているが計画外**の id は
  // （写し間違いとして直せない限り）上書きしない: 別の表を黙って読ませないための線引き。
  const missing = sources.filter((node) => {
    if (repaired.has(node.id)) return false;
    const written = idOf(node);
    return typeof written !== 'string' || written === '';
  });
  const assigned = new Set<string>();
  let hasUnknownId = false;
  for (const node of sources) {
    const written = repaired.get(node.id) ?? idOf(node);
    if (typeof written !== 'string' || written === '') continue;
    if (known.has(written)) assigned.add(written);
    else hasUnknownId = true;
  }
  const remaining = dataSourceIds.filter((id) => !assigned.has(id));
  // 一意に決まるときだけ埋める（ソース数が計画と一致し、未記入の数と残りの計画idの数が合うとき）。
  // 計画外の id を持つノードが1つでもあれば、どれがどれか決まらないので埋めない。
  const fillable = !hasUnknownId && sources.length === dataSourceIds.length && missing.length === remaining.length ? missing : [];

  if (repaired.size === 0 && fillable.length === 0) return graph;
  const fills = new Map(fillable.map((node, index) => [node.id, remaining[index]!] as const));
  const nodes = graph.nodes.map((node) => {
    const next = repaired.get(node.id) ?? fills.get(node.id);
    if (next === undefined) return node;
    const written = idOf(node);
    changes.push(repaired.has(node.id)
      ? `source '${node.id}': corrected the data source id ${JSON.stringify(written)} to "${next}"`
      : `source '${node.id}': filled in the missing data source id "${next}" from the tool plan`);
    return { ...node, config: { ...(isRecord(node.config) ? node.config : {}), dataSourceId: next } };
  });
  return { nodes, edges: graph.edges };
}

/**
 * データソースidの写し間違いを Planner と同じ規則で直す。
 * `repairDataSourceIds` は計画を受ける関数なので、1件だけの計画を組んで通す
 * （編集距離の規則・しきい値・曖昧なら直さない判断を1箇所に保つための呼び出し）。
 */
function repairDataSourceTypo(written: string, dataSourceIds: readonly string[]): string {
  const probe = {
    agentBrief: { displayName: 'probe', role: 'probe' },
    tools: [{ key: 'probe', displayName: 'probe', purpose: 'probe', dataSourceId: written, sideEffect: 'read-only' }],
    skills: [], personas: [], scenarios: [],
  } as unknown as FactoryPlan;
  return repairDataSourceIds(probe, dataSourceIds).tools[0]?.dataSourceId ?? written;
}

/** `agent-input` の config の形を直す（`schema` の中に入れてしまった `sample` を外へ出す・欠落は `{}`）。 */
function normalizeAgentInputShape(graph: ToolGraph, changes: string[]): ToolGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (node.type !== AGENT_INPUT_TYPE || !isRecord(node.config)) return node;
    const config = node.config;
    const schema = config['schema'];
    if (!isRecord(schema)) return node;
    let nextConfig = config;
    if (isRecord(schema['sample']) && !isRecord(config['sample'])) {
      const { sample, ...restSchema } = schema;
      nextConfig = { ...config, schema: restSchema, sample };
      changes.push(`agent-input '${node.id}': moved 'sample' out of 'schema' (it belongs next to it)`);
    }
    if (!isRecord(nextConfig['sample'])) {
      nextConfig = { ...nextConfig, sample: {} };
      changes.push(`agent-input '${node.id}': added the missing 'sample' object (every argument is optional, so an empty sample is valid)`);
    }
    if (nextConfig === config) return node;
    changed = true;
    return { ...node, config: nextConfig };
  });
  return changed ? { nodes, edges: graph.edges } : graph;
}

/** filter 条件から読み取った、引数1つ分の宣言材料。 */
interface BoundArgument {
  readonly field: string;
  /** バインド先の列名（複数あれば最初のもの）。 */
  readonly column: string;
  /** `in` / `notIn` にバインドされているか（必ず string 引数になる）。 */
  readonly multiValue: boolean;
  /** 演算子バインド（`opBinding`）か（必ず string 引数になる）。 */
  readonly operator: boolean;
  /** 設計時の代表値（`value` / `values`）。 */
  readonly sample?: string | number | boolean;
}

/** グラフの filter ノードから、引数へバインドされている条件を集める。 */
function boundArgumentsOf(graph: ToolGraph): BoundArgument[] {
  const found = new Map<string, BoundArgument>();
  for (const node of graph.nodes) {
    if (node.type !== FILTER_TYPE || !isRecord(node.config)) continue;
    const raw = node.config['conditions'];
    const conditions: unknown[] = Array.isArray(raw) ? raw : [node.config];
    for (const condition of conditions) {
      if (!isRecord(condition)) continue;
      const column = typeof condition['column'] === 'string' ? condition['column'] : '';
      const op = typeof condition['op'] === 'string' ? condition['op'] : 'eq';
      for (const [key, operator] of [['valueBinding', false], ['opBinding', true]] as const) {
        const binding = condition[key];
        if (!isRecord(binding) || binding['source'] !== 'agent-input') continue;
        const field = typeof binding['field'] === 'string' ? binding['field'] : '';
        if (field === '' || found.has(field)) continue;
        found.set(field, {
          field,
          column,
          multiValue: !operator && MULTI_VALUE_OPS.has(op as never),
          operator,
          ...(operator ? {} : sampleOf(condition)),
        });
      }
    }
  }
  return [...found.values()];
}

/** 条件の設計時の値を引数サンプルへ写す（`values` の並びはカンマ連結＝実行時の受け取り方と同じ）。 */
function sampleOf(condition: Record<string, unknown>): { sample?: string | number | boolean } {
  const values = condition['values'];
  if (Array.isArray(values) && values.length > 0) {
    return { sample: values.map((value) => String(value)).join(',') };
  }
  const value = condition['value'];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { sample: value };
  if (Array.isArray(value) && value.length > 0) return { sample: value.map((item) => String(item)).join(',') };
  return {};
}

/**
 * `valueBinding` / `opBinding` があるのに `agent-input` ノードが無い提案へ、その宣言を**合成**する。
 *
 * 実測では、条件だけバインドして宣言ノードを置かない提案が `SaveTool: Agent input bindings require an
 * inputSchema` で落ちた。バインドから引数名・型・サンプルが一意に決まるので、差し戻さずに組み立てる。
 * 型はバインド先の列型から決めるが、この時点ではまだスキーマ伝播していないため、プロファイルの列で
 * 分かる範囲だけを使い、分からなければ `string`（伝播後に `normalizeArgumentTypes` が直す）。
 */
function synthesizeAgentInput(graph: ToolGraph, profiles: readonly DataProfile[], changes: string[]): ToolGraph {
  if (graph.nodes.some((node) => node.type === AGENT_INPUT_TYPE)) return graph;
  const bound = boundArgumentsOf(graph);
  if (bound.length === 0) return graph;

  const columnTypes = new Map<string, string>();
  for (const profile of profiles) {
    for (const column of profile.columns) if (!columnTypes.has(column.name)) columnTypes.set(column.name, column.type);
  }
  const columns = bound.map((argument) => ({
    name: argument.field,
    type: argument.multiValue || argument.operator ? 'string' : declaredTypeFor(columnTypes.get(argument.column)),
    nullable: true,
  }));
  const sample: Record<string, unknown> = {};
  for (const argument of bound) {
    if (argument.sample !== undefined) sample[argument.field] = argument.sample;
  }
  const id = uniqueNodeId('args', new Set(graph.nodes.map((node) => node.id)));
  changes.push(`added the missing '${AGENT_INPUT_TYPE}' node '${id}' declaring ${columns.map((column) => `'${column.name}'`).join(', ')} from the filter bindings (every argument optional)`);
  return {
    nodes: [...graph.nodes, { id, type: AGENT_INPUT_TYPE, config: { schema: { columns }, sample } }],
    edges: graph.edges,
  };
}

/** 引数として宣言できる型へ寄せる（宣言できない型は `string` に倒す）。 */
function declaredTypeFor(columnType: string | undefined): string {
  return columnType === 'date' || columnType === 'number' || columnType === 'boolean' ? columnType : 'string';
}

/** 既存のノードidと衝突しないidを作る。 */
function uniqueNodeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * ToolSmith の提案グラフを正規化する（純粋関数・同じ入力に同じ出力・二度掛けても変わらない）。
 * 直せなかった崩れ方はそのまま残し、修復ループの差し戻し文面に委ねる。
 */
export function normalizeProposedGraph(graph: ToolGraph, context: NormalizeToolGraphContext): NormalizeToolGraphResult {
  const changes: string[] = [];
  const knownTypes = context.knownNodeTypes ?? DEFAULT_KNOWN_NODE_TYPES;
  const dataSourceIds = context.dataSourceIds ?? context.profiles.map((profile) => profile.dataSourceId);

  // 1) ノード種別の綴り → 2) source の id → 3) filter の中身 → 4) agent-input の形 → 5) 宣言の合成 → 6) join のポート。
  // 綴りを先に直さないと、以降の「型で選ぶ」処理が対象を取りこぼす。
  let next = normalizeNodeTypes(graph, knownTypes, changes);
  next = normalizeSourceIds(next, dataSourceIds, changes);
  // グラフ内の parse-period が足す開始日の列名（既定 periodStart）。束縛した日付条件の種に使う。
  const periodStartColumns = new Set<string>(next.nodes.filter((node) => node.type === PARSE_PERIOD_TYPE).map((node) => (isRecord(node.config) && typeof node.config['startColumn'] === 'string' ? node.config['startColumn'] : 'periodStart')));
  const nodes = next.nodes.map((node) => (node.type === FILTER_TYPE ? normalizeFilterNode(node, changes, context.profiles, periodStartColumns) : node));
  if (nodes.some((node, index) => node !== next.nodes[index])) next = { nodes, edges: next.edges };
  next = normalizeAgentInputShape(next, changes);
  next = synthesizeAgentInput(next, context.profiles, changes);
  next = fillAgentOutputDefaults(next, changes);
  return { graph: normalizeJoinPorts(next, context, changes), changes };
}

/** `agent-output` の必須項目の既定（`tool-output-dispatcher` の DEFAULT_OUTPUT と同じ値）。 */
const AGENT_OUTPUT_DEFAULTS: Readonly<Record<string, string | number>> = { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65_536, overflow: 'error' };

/**
 * `agent-output` の書き忘れた必須項目を既定で埋める。
 *
 * 実測（設計アシスタント・12B）: `{ "shape": "rows", "format": "json" }` だけを書いて `maxRows` / `maxBytes` /
 * `overflow` を落とし、毎回 1 回目が検証で落ちて差し戻しになっていた。値の意味は変えない（書いた項目はそのまま）。
 * 既定は保存時の既定と同じにし、埋めた項目は changes に残す。
 */
function fillAgentOutputDefaults(graph: ToolGraph, changes: string[]): ToolGraph {
  let touched = false;
  const nodes = graph.nodes.map((node) => {
    if (node.type !== 'agent-output') return node;
    const config = isRecord(node.config) ? node.config : {};
    const missing = Object.keys(AGENT_OUTPUT_DEFAULTS).filter((key) => config[key] === undefined || config[key] === null);
    if (missing.length === 0) return node;
    touched = true;
    changes.push(`agent-output '${node.id}': filled the missing ${missing.join(', ')} with the defaults (${missing.map((key) => `${key}=${JSON.stringify(AGENT_OUTPUT_DEFAULTS[key])}`).join(', ')})`);
    return { ...node, config: { ...config, ...Object.fromEntries(missing.map((key) => [key, AGENT_OUTPUT_DEFAULTS[key]])) } };
  });
  return touched ? { nodes, edges: graph.edges } : graph;
}

/**
 * 綴りを寄せる先の既定語彙（ToolSmith が使ってよいノード種別）。
 * 許可語彙の外（`union` など）へは寄せない: 直した先で構造検査に落ちるだけで、修復が1周無駄になる。
 */
const DEFAULT_KNOWN_NODE_TYPES: readonly string[] = [
  'csv-source', 'json-source', AGENT_INPUT_TYPE, 'agent-output',
  'select', 'filter', 'sort', 'distinct', 'limit', 'parse-period', 'rename', JOIN_TYPE, 'summary-statistics',
];

/**
 * スキーマ伝播の結果を使って、引数の宣言型をバインド先の列型へ合わせる（ADR-0047 第5ラウンド）。
 *
 * 実測では `period_from` / `period_to` を `type: "string"` で宣言しながら `periodStart`（date 列）の
 * gte/lte へバインドしていた。意味検査はこれを「date で宣言し直せ」と差し戻していたが、直し方が
 * 一意に決まるので差し戻さずに直す。`periodStart` は `parse-period` が足す列なので、プロファイルでは
 * 分からず、伝播後でなければ判定できない。
 *
 * 安全側の線引き: **1つの引数が同じ型の列だけにバインドされている場合のみ**書き換える。
 * `in` / `notIn` にバインドされた引数（カンマ区切りの文字列）と `opBinding` の引数は常に string のまま。
 */
export function normalizeArgumentTypes(graph: ToolGraph, propagation: PropagationResult, changes: string[]): ToolGraph {
  const declaration = graph.nodes.find((node) => node.type === AGENT_INPUT_TYPE);
  if (declaration === undefined || !isRecord(declaration.config)) return graph;
  const schema = declaration.config['schema'];
  if (!isRecord(schema) || !Array.isArray(schema['columns'])) return graph;

  // 引数 → バインド先の列型の集合（`in`/opBinding は型を決めさせない目印として 'string' に固定）。
  const boundTypes = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.type !== FILTER_TYPE || !isRecord(node.config)) continue;
    const nodeSchema = propagation.nodes[node.id]?.schema;
    const raw = node.config['conditions'];
    const conditions: unknown[] = Array.isArray(raw) ? raw : [node.config];
    for (const condition of conditions) {
      if (!isRecord(condition)) continue;
      const op = typeof condition['op'] === 'string' ? condition['op'] : 'eq';
      const column = typeof condition['column'] === 'string' ? condition['column'] : '';
      for (const [key, operator] of [['valueBinding', false], ['opBinding', true]] as const) {
        const binding = condition[key];
        if (!isRecord(binding) || binding['source'] !== 'agent-input') continue;
        const field = typeof binding['field'] === 'string' ? binding['field'] : '';
        if (field === '') continue;
        const types = boundTypes.get(field) ?? new Set<string>();
        types.add(operator || MULTI_VALUE_OPS.has(op as never)
          ? 'string'
          : declaredTypeFor(nodeSchema?.columns.find((candidate) => candidate.name === column)?.type));
        boundTypes.set(field, types);
      }
    }
  }

  let changed = false;
  const columns = (schema['columns'] as unknown[]).map((raw) => {
    if (!isRecord(raw) || typeof raw['name'] !== 'string') return raw;
    const types = boundTypes.get(raw['name']);
    // 型が1つに決まるときだけ直す（複数の型の列へバインドしている引数は意味検査に委ねる）。
    const only = types !== undefined && types.size === 1 ? [...types][0] : undefined;
    if (only === undefined || only === raw['type']) return raw;
    changed = true;
    changes.push(`agent-input: declared argument '${raw['name']}' as "type": "${only}" (it filters a ${only} column; it was ${JSON.stringify(raw['type'] ?? null)})`);
    return { ...raw, type: only };
  });
  if (!changed) return graph;
  return {
    nodes: graph.nodes.map((node) => node.id === declaration.id
      ? { ...node, config: { ...(declaration.config as Record<string, unknown>), schema: { ...schema, columns } } }
      : node),
    edges: graph.edges,
  };
}

/**
 * `join` の左右を入れ替えたグラフを返す（入れ替える `join` が無ければ undefined）。
 *
 * ポートを**こちらが推測した**ときだけ使う: 推測が逆で、結合キーが左右に見つからず
 * スキーマ伝播が落ちる場合に、入れ替えた版なら通るかを1回だけ試すための候補。
 * モデルが 0/1 を明示していた場合は意味（`left` 結合の向き・列順）に関わるため入れ替えない。
 */
export function withSwappedJoinPorts(graph: ToolGraph): ToolGraph | undefined {
  const joinIds = new Set(graph.nodes.filter((node) => node.type === JOIN_TYPE).map((node) => node.id));
  if (joinIds.size === 0) return undefined;
  let changed = false;
  const edges = graph.edges.map((edge) => {
    if (!joinIds.has(edge.to) || (edge.toInput !== 0 && edge.toInput !== 1)) return edge;
    changed = true;
    return { ...edge, toInput: edge.toInput === 0 ? 1 : 0 };
  });
  return changed ? { nodes: graph.nodes, edges } : undefined;
}

/** 伝播結果にキー列の欠落（`join: ... key column not found`）が含まれるか。入れ替えを試す価値の判定に使う。 */
export function hasJoinKeyResolutionError(propagation: PropagationResult): boolean {
  return Object.values(propagation.nodes).some((node) =>
    node.issues.some((issue) => issue.severity === 'error' && /^join: (left|right) key column not found/.test(issue.message)));
}
