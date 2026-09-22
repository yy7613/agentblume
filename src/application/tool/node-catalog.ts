/**
 * 応用層: 設計アシスタントがモデルへ見せるノードカタログ（v47 実装契約 §5 / ADR-0051）。
 *
 * パレットにある種別すべて（業務テンプレート専用ノードは除く）について、
 * **config の契約と使いどころ**を英語 1〜3 行で持つ。文面は ToolSmith（`roles/tool-smith-role.ts`）で
 * 12B 級に効いた言い回しを流用し、そこに無い種別を足した。
 *
 * ここは**ノードの契約の写し**なので、ノードの `configSchema` が変わったらここも直す。
 * 写しが古くなるのを防ぐために、`node-catalog.test.ts` がレジストリと突き合わせる
 * （載っている種別がすべて登録済み・登録済みの汎用ノードがすべて載っている）。
 *
 * 語彙の列挙は domain の正準リストから組む（`FILTER_OPS` など）。ここに手書きの一覧を置くと、
 * 演算子を足したときにプロンプトだけが古いまま残る。
 */
import { AGENT_OUTPUT_FORMATS, AGENT_OUTPUT_SHAPES } from '../../domain/etl/nodes/agent-output';
import { AI_JUDGE_MAX_ITEMS, AI_JUDGE_YES_NO_VALUES } from '../../domain/etl/nodes/ai-judge';
import { CHART_TYPES } from '../../domain/etl/nodes/chart-output';
import { FILTER_OPS, ORDER_OPS, VALUELESS_OPS } from '../../domain/etl/nodes/filter';
import { GROUP_BY_OPS } from '../../domain/etl/nodes/group-by';
import { PERIOD_GRANULARITIES } from '../../domain/etl/nodes/parse-period';
import { SUMMARY_METRICS } from '../../domain/etl/nodes/summary-statistics';
import { WORKSPACE_ARTIFACT_KINDS } from '../../domain/etl/nodes/workspace-output';

/** カタログ 1 件。`contract` は英語 1〜3 行（改行を含んでよい）。 */
export interface NodeCatalogEntry {
  readonly type: string;
  readonly contract: string;
}

/** 引用符つきの語彙列（「この中から選ぶ」を列挙するとき）。 */
function vocabulary(values: Iterable<string>): string {
  return [...values].map((value) => `'${value}'`).join(', ');
}

/** 択一の語彙（JSON の 1 つの項目に入る値。列挙と見分けが付くよう `|` で並べる）。 */
function choices(values: Iterable<string>): string {
  return [...values].map((value) => `'${value}'`).join(' | ');
}

const FILTER_OP_VOCABULARY = vocabulary(FILTER_OPS);
const ORDER_OP_VOCABULARY = vocabulary(ORDER_OPS);
const VALUELESS_OP_VOCABULARY = vocabulary(VALUELESS_OPS);
const GRANULARITY_VOCABULARY = vocabulary(PERIOD_GRANULARITIES);

/**
 * パレットの全種別（業務専用ノードを除く 29 種）の config 契約。
 * 並びは種別名の昇順で固定する（プロンプトが版ごとに揺れると差分が読めない）。
 */
export const DESIGN_NODE_CATALOG: readonly NodeCatalogEntry[] = [
  {
    type: 'agent-input',
    contract: 'Declares the tool call ARGUMENTS as one node that stays UNCONNECTED (no edge starts or ends at it); there is at most one per graph, with all arguments as separate schema columns. { "schema": { "columns": [{ "name": "<argument>", "type": "string" | "number" | "boolean" | "date", "nullable": true }] }, "sample": { "<argument>": <a representative value of that type> } }.\nAn argument is consumed by a filter condition through "valueBinding" / "opBinding"; a nullable argument may be omitted at run time (the condition is then skipped) and needs no "sample" entry. A date argument must be declared "type": "date" so the agent can pass an ISO date such as "2008-01-01".',
  },
  {
    type: 'agent-output',
    contract: `The single terminal node of the graph: it formats the bounded result the agent receives. { "shape": ${choices(AGENT_OUTPUT_SHAPES)}, "format": ${choices(AGENT_OUTPUT_FORMATS)}, "maxRows": 1..10000, "maxBytes": 1024..1048576, "overflow": 'error' | 'store-and-reference' }; "columns" (a subset to return) and "valueColumn" are optional, but "valueColumn" is REQUIRED when "shape" is 'single-value'.\nExceeding maxRows / maxBytes fails the tool call, so the chain before it must bound the result (sort + limit, or an aggregate).`,
  },
  {
    type: 'ai-judge',
    contract: `Lets a local LLM judge every row against a written criterion, then flags the rows or keeps only the matching ones. Slow and non-deterministic, so use it only when no filter / calculate can express the question. { "question": "<the criterion, as a question>", "categories": [{ "name": "<label>", "description": "<when it applies>" }], "columns": ["<column the judge reads>"], "outputColumn": "aiVerdict", "reasonColumn": "aiReason" | null, "action": 'flag' | 'keep' | 'exclude', "matchValues": ["<verdict>"], "maxItems": 1..${AI_JUDGE_MAX_ITEMS} }.\nAn empty "categories" means a yes/no judgement (${vocabulary(AI_JUDGE_YES_NO_VALUES)}); otherwise the verdict is one of the category names or 'unclear'. "matchValues" lists the verdicts that 'keep' / 'exclude' act on. An empty "columns" shows the judge every column.`,
  },
  {
    type: 'calculate',
    contract: 'Computes ONE new numeric column from a formula over the input columns. { "outputColumn": "<new column>", "expression": "<formula>", "onError": \'null\' | \'fail\', "precision": <decimal places> }; onError and precision are optional (default: null, no rounding). An existing column of the same name is replaced.\nExpression grammar: + - * / ^, parentheses, plain decimal literals, and functions such as abs / round / min / max. A COLUMN REFERENCE MUST BE WRITTEN IN SQUARE BRACKETS: "[unit price] * [quantity]". A bare name is read as a constant or a function, not a column. Comparisons, conditionals, strings and dates are NOT part of the language.',
  },
  {
    type: 'cast',
    contract: 'Converts column data types in place. { "casts": [{ "column": "<column>", "to": \'string\' | \'number\' | \'boolean\' | \'date\' }] }.\nValues that cannot be converted become null. Use it when a number arrived as text; for Japanese period labels such as "2024年度" use parse-period instead.',
  },
  {
    type: 'chart-output',
    contract: `Stores a typed chart in the session workspace and passes the rows through unchanged. { "configVersion": 1, "name": "<artifact name>", "chartType": ${choices(CHART_TYPES)}, "mapping": { … }, "title": "<optional>", "maxPoints": 1..5000, "downsample": 'none' | 'lttb', "writeMode": 'create' | 'replace', "onConflict": 'fail' | 'new-revision', "previewRows": 0..100 }.\nThe required "mapping" keys depend on "chartType": histogram / box-plot need "valueColumn" (number); scatter needs "xColumn" (number or date) and "yColumn" (number); time-series needs "timeColumn" (date) and "valueColumn" (number); outlier-overlay adds "outlierColumn" (boolean); correlation-heatmap needs "xColumn", "yColumn" and "coefficientColumn".`,
  },
  {
    type: 'correlation-analysis',
    contract: 'Calculates the correlation of every pair of the listed numeric columns, one row per pair. { "configVersion": 1, "columns": ["<numeric column>", …] (2 to 30), "method": \'pearson\' | \'spearman\', "missing": \'pairwise\' | \'listwise\', "minPairs": 2 or more, "includeDiagonal": false }.\nThe output replaces the table with the columns columnX, columnY, coefficient, absoluteCoefficient, pairCount and method, so put it near the end of the chain.',
  },
  {
    type: 'csv-source',
    contract: 'Reads a registered CSV data source. { "dataSourceId": "<id from the data source list>" }. Use an id exactly as listed; never invent one, and never paste CSV text into the graph.\nIt has no input; it is where a branch of the graph starts. Registering a new file is not possible from this conversation — say so instead of guessing an id.',
  },
  {
    type: 'current-datetime',
    contract: 'Produces ONE row with the time of the run: now (date), date ("YYYY-MM-DD"), yearMonth ("YYYY-MM"), time ("HH:mm:ss") and weekday ("Sun".."Sat"). { "timezone": "Asia/Tokyo" } is optional (default: the server timezone).\nIt has no input. Join it, or read it with a calculate, when the tool must reason about "today" instead of a fixed date.',
  },
  {
    type: 'database-source',
    contract: 'Reads an allowlisted table or view of a registered database data source. { "dataSourceId": "<id from the data source list>", "table": "<schema.table>", "limit": <rows to read> }.\nIt has no input. Only tables the backend allows can be read, so keep the table exactly as the data source describes it.',
  },
  {
    type: 'distinct',
    contract: 'Drops duplicate rows. { "columns": ["<column>", …] } compares only those columns; omitting "columns" compares the whole row.\nIt keeps the first row of each duplicate group, so sort before it when "the first" has to mean something particular.',
  },
  {
    type: 'fill-null',
    contract: 'Fills empty cells or drops the rows that have them. { "rules": [{ "column": "<column>", "strategy": \'constant\' | \'drop-row\', "value": <the constant, for \'constant\'> }] } needs at least one rule.\nRules apply in order, so a later rule sees the result of the earlier ones.',
  },
  {
    type: 'filter',
    contract: `Keeps only the rows matching a condition. One condition is written flat: { "column": "<column>", "op": <operator>, "value": <constant>, "valueBinding"?, "opBinding"?, "caseInsensitive"?, "disabled"? }. Several are written as { "conditions": [ <same fields> ], "combine": 'and' | 'or' }.\nOperators: ${FILTER_OP_VOCABULARY}. ${ORDER_OP_VOCABULARY} require a number or date column; ${VALUELESS_OP_VOCABULARY} take no value; 'in' / 'notIn' read "values" (a NON-EMPTY array), never "value"; "caseInsensitive": true affects 'eq' / 'neq' / 'contains' on strings only.\nTo let the agent supply the value, add "valueBinding": { "source": "agent-input", "field": "<argument>" } and KEEP a design-time "value" / "values" of the same type (the preview runs with it; the argument replaces it at run time). "opBinding": { "source": "agent-input", "field": "<argument>", "allowed": [<operators>] } lets the agent choose the comparison instead; the design-time "op" must be listed in "allowed". "column" names a data column, "field" names a declared argument — never mix them up.`,
  },
  {
    type: 'graph-output',
    contract: 'Stores the rows as a property graph in the session workspace and passes them through unchanged. { "name": "<artifact name>", "writeMode": \'create\' | \'replace\', "onConflict": \'fail\' | \'new-revision\', "previewRows": 0..100, "graph": { "sourceColumn": "<column>", "targetColumn": "<a different column>", "edgeLabelColumn": "<optional>" } }.\nFor the output of correlation-analysis use { "mode": "correlation-network", "columnX", "columnY", "coefficient", "pairCount", "minimumAbsoluteCoefficient"?, "minimumPairCount"? } instead.',
  },
  {
    type: 'group-by',
    contract: `Aggregates rows per group; the output has ONE row per group and only the listed columns. { "groupBy": ["<column>", …] (at least one), "aggregates": [{ "op": ${choices(GROUP_BY_OPS)}, "column": "<input column>", "as": "<output column>" }] (at least one) }.\n"column" is required for every op except 'count' (the row count of the group); 'sum' / 'mean' need a number column, 'min' / 'max' a number, date or string column. Everything the answer needs must be produced here: columns that are neither grouped nor aggregated disappear.`,
  },
  {
    type: 'join',
    contract: 'Joins TWO inputs on key columns — the only node with two inputs, so its two incoming edges MUST carry "toInput": 0 (left) and "toInput": 1 (right). { "mode": \'inner\' | \'left\' | \'right\' | \'full\', "keys": [{ "left": "<column in the left input>", "right": "<column in the right input>" }] (a plain string means the same name on both sides), "rightSuffix": "_right", "coerceKeys": \'none\' | \'string\' }.\nOutput = every left column + the right columns that are not keys; a right column whose name already exists on the left gets "rightSuffix" appended. Join on ALL the columns the two sides share (for example BOTH the period and the region code): joining on one of them multiplies rows. Rename or select the value columns BEFORE the join so they still say which source they came from.',
  },
  {
    type: 'json-source',
    contract: 'Reads a registered JSON data source. { "dataSourceId": "<id from the data source list>" }. Use an id exactly as listed; never invent one, and never paste JSON rows into the graph.\nIt has no input; it is where a branch of the graph starts.',
  },
  {
    type: 'limit',
    contract: 'Keeps the first rows. { "count": 1..10000, "offset": <0 or more, optional> }.\nsort + limit is how a tool returns "the top N", and how the chain stays inside the agent-output maxRows when the agent passes no arguments.',
  },
  {
    type: 'outlier-filter',
    contract: 'Flags or drops outliers of numeric columns. { "configVersion": 1, "columns": ["<numeric column>", …] (1 to 20), "groupBy": ["<column>", …], "method": \'iqr\' | \'z-score\' | \'mad\', "threshold": <positive number, 1.5 for iqr, ~3 for z-score>, "action": \'flag\' | \'exclude\', "nulls": \'keep\' | \'exclude\', "flagColumns": { "isOutlier": "isOutlier", "score": "outlierScore", "reason": "outlierReason" } }.\n\'flag\' adds those three columns (their names must not already exist); \'exclude\' drops the outlying rows and adds nothing. Bounds are computed per group.',
  },
  {
    type: 'parse-period',
    contract: `Reads a Japanese or ISO period label ('1975年10月', '2024年1-3月期', '2024年', '2024年度', '2024-05') and ADDS two columns: "periodStart" (date, the first day of that period) and "periodGranularity" (string, one of ${GRANULARITY_VOCABULARY}). { "column": "<period label column>", "startColumn": "periodStart", "granularityColumn": "periodGranularity", "fiscalYearStartMonth": 4 }. It never removes or rewrites the original label column, and the two new names must not collide with existing columns.\nA period label is a STRING, so ranges and time order cannot be expressed on it directly: parse it, filter "periodGranularity" to ONE granularity when the column mixes them, then compare "periodStart". Keep the original label column in the output — the agent quotes the label the data uses.`,
  },
  {
    type: 'rename',
    contract: 'Renames columns. { "renames": [{ "from": "<column>", "to": "<new name>" }] }.\nUse it before a join so that the value columns of each side keep saying which source they came from.',
  },
  {
    type: 'replace',
    contract: 'Replaces exact cell values. { "rules": [{ "column": "<column>", "from": <old value>, "to": <new value> }] } needs at least one rule.\nThe match is exact (not a substring and not a pattern), and the column type does not change.',
  },
  {
    type: 'select',
    contract: 'Keeps only the listed columns, in that order. { "columns": ["<column>", …] }.\nOnly worth adding when the source has many irrelevant columns, and it must keep every column the answer needs — including the period label and any note column that qualifies the number.',
  },
  {
    type: 'sort',
    contract: 'Sorts rows by one or more keys. { "keys": [{ "column": "<column>", "direction": \'asc\' | \'desc\', "nulls": \'first\' | \'last\' }] } needs at least one key; direction and nulls are optional (default \'asc\' / \'last\').\nSort on the parsed "periodStart", not on the period label, when the order has to be chronological.',
  },
  {
    type: 'summary-statistics',
    contract: `Replaces the table with descriptive statistics of the listed numeric columns, one row per column per group. { "configVersion": 1, "columns": ["<numeric column>", …] (at least one), "groupBy": ["<column>", …], "metrics": [${vocabulary(SUMMARY_METRICS)}], "variance": 'sample' | 'population' }.\nThe output columns are the group columns plus "column", "rowCount" and the chosen metrics, so it bounds the result by itself. Use it when the purpose asks for statistics rather than rows.`,
  },
  {
    type: 'time-series-analysis',
    contract: 'Buckets a DATE column and aggregates the value columns per bucket. { "configVersion": 1, "timeColumn": "<date column>", "valueColumns": ["<numeric column>", …] (1 to 10), "groupBy": ["<column>", …], "timezone": "UTC", "interval": \'minute\' | \'hour\' | \'day\' | \'week\' | \'month\', "aggregate": \'count\' | \'sum\' | \'mean\' | \'min\' | \'max\', "fill": \'none\' | \'zero\' | \'forward\', "window": { "operation": \'moving-mean\' | \'moving-sum\', "size": 2..1000 }, "comparison": { "lag": 1..1000, "output": [\'delta\' | \'percent-change\'] } }; "window" and "comparison" are optional.\nThe output replaces the table with the group columns plus bucketStart, series, value and sampleCount (and movingValue / delta / percentChange when asked for). "timeColumn" must already be a date, so run parse-period (or cast) first and point it at "periodStart".',
  },
  {
    type: 'union',
    contract: 'Appends the rows of TWO inputs by column name — the second node with two inputs, so its incoming edges carry "toInput": 0 and 1. { "strict": false } (true rejects inputs whose column sets differ; false fills the missing columns with null).\nUse it to stack rows of the same shape; to put values of two sources side by side on shared keys, use join instead.',
  },
  {
    type: 'web-search-source',
    contract: 'Replays results that were explicitly fetched and cached from a configured search provider. { "provider": "<configured provider>", "query": "<search text>", "maxResults": <count>, "cacheKey": "<cache entry>" }.\nIt has no input and performs no search by itself: without a cache entry it yields zero rows. Do not add it to answer a question about the data at hand.',
  },
  {
    type: 'workspace-output',
    contract: `Stores the rows as a session artifact and returns its reference. { "name": "<artifact name>", "artifactKind": ${choices(WORKSPACE_ARTIFACT_KINDS)}, "writeMode": 'create' | 'replace', "onConflict": 'fail' | 'new-revision', "previewRows": 0..100 }.\nIt is a sink, like agent-output: use it when the result should be kept for later steps of the session rather than read by the agent right away.`,
  },
];

/** カタログに載っている種別（テストとプロンプトが共有する）。 */
export const DESIGN_NODE_TYPES: readonly string[] = DESIGN_NODE_CATALOG.map((entry) => entry.type);

/**
 * データソース id を持つ source 種別。カタログの文面と、ユースケースが
 * 「グラフが参照しているデータソース」を拾う判定で共有する。
 */
export const DATA_SOURCE_NODE_TYPES: readonly string[] = ['csv-source', 'json-source', 'database-source'];

/** system プロンプトへ載せるカタログ本文（種別ごとに 1 ブロック）。 */
export function nodeCatalogText(): string {
  return DESIGN_NODE_CATALOG.map((entry) => `- ${entry.type}: ${entry.contract}`).join('\n');
}
