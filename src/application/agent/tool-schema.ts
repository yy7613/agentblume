import { schemaIncompatibility } from '../../domain/data/schema';
import type { Cell, Column, Row, Schema, Table } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { listValueArgumentSummaries, operatorArgumentSummaries } from '../../domain/etl/nodes/filter';
import type { ListValueArgumentSummary, OperatorArgumentSummary } from '../../domain/etl/nodes/filter';
import { isFunctionName } from '../../domain/shared/function-name';
import type { Tool } from '../../domain/tool/tool';
import { AgentRunError, ToolArgumentsError } from './errors';
import type { JsonObject, JsonSchemaObject, JsonSchemaProperty, JsonValue, ModelToolDefinition } from '../model/model-provider';

function propertyFor(column: Column): JsonSchemaProperty {
  let base: JsonSchemaProperty;
  switch (column.type) {
    case 'date': base = { type: 'string', format: 'date-time' }; break;
    case 'null': base = { type: 'null' }; break;
    case 'unknown': base = {}; break;
    default: base = { type: column.type }; break;
  }
  return column.nullable && column.type !== 'null'
    ? { anyOf: [base, { type: 'null' }] }
    : base;
}

export function schemaToJsonSchema(schema: Schema | undefined): JsonSchemaObject {
  const columns = schema?.columns ?? [];
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(properties, column.name)) {
      throw new AgentRunError(`duplicate input schema column: ${column.name}`);
    }
    properties[column.name] = propertyFor(column);
  }
  const required = columns.filter((column) => !column.nullable).map((column) => column.name);
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** op バインドされた引数の LLM 向け説明文（英語）。nullable で既定演算子が定まる場合は省略時の挙動も伝える。 */
function operatorDescription(summary: OperatorArgumentSummary, nullable: boolean): string {
  const columns = summary.columns.map((column) => `'${column}'`).join(', ');
  const base = `Row filter operator applied to ${summary.columns.length > 1 ? 'columns' : 'column'} ${columns}.`;
  return nullable && summary.defaultOp !== undefined
    ? `${base} Omit it to use the default operator '${summary.defaultOp}'.`
    : base;
}

/**
 * op バインドされた引数プロパティを、許可演算子の enum と説明を持つ JSON Schema へ置き換える。
 * ドメインの `operatorArgumentSummaries`（保存検証と同じ集約）を起点に、inputSchema の Column
 * （型・nullable）から形を直接構築して代入する — `schemaToJsonSchema` の出力形状には依存しない
 * （形状スニッフィングだと propertyFor の出力変更で enum が静かに消える）。
 * - 非 nullable の string 列 → `{ type:'string', enum, description }`。
 * - nullable の string 列 → `{ anyOf: [{ type:'string', enum }, { type:'null' }], description }`。
 * - inputSchema に列が無い・string 型でない・積集合が空（いずれも保存時に拒否される不整合な
 *   旧 Tool）はスキップして触らない（LLM 公開でクラッシュさせない）。
 */
function withOperatorEnums(schema: JsonSchemaObject, graph: ToolGraph, inputSchema: Schema | undefined): JsonSchemaObject {
  const configs = graph.nodes
    .filter((node) => node.type === 'filter')
    .map((node) => node.config);
  const summaries = operatorArgumentSummaries(configs);
  if (summaries.length === 0) return schema;
  const properties: Record<string, JsonSchemaProperty> = { ...schema.properties };
  for (const summary of summaries) {
    if (summary.allowed.length === 0) continue;
    const column = inputSchema?.columns.find((candidate) => candidate.name === summary.field);
    if (column === undefined || column.type !== 'string') continue;
    const description = operatorDescription(summary, column.nullable);
    properties[summary.field] = column.nullable
      ? { anyOf: [{ type: 'string', enum: summary.allowed }, { type: 'null' }], description }
      : { type: 'string', enum: summary.allowed, description };
  }
  return { ...schema, properties };
}

/**
 * 値の並びを受け取る引数（`in`/`notIn` の valueBinding 先）の LLM 向け説明文（英語）。
 * 「カンマ区切りで一度に複数渡せる」ことを**例つきで**言い切る — 実測では、単値しか渡せないと
 * 思ったモデルが県ごとにツールを呼び、1 実行あたりのツール呼び出し上限に当たっていた。
 */
function listValueDescription(summary: ListValueArgumentSummary, nullable: boolean): string {
  const columns = summary.columns.map((column) => `'${column}'`).join(', ');
  const example = summary.samples.length === 0 ? '' : ` For example: "${summary.samples.join(',')}".`;
  const target = summary.columns.length === 0 ? 'the filtered column' : `${summary.columns.length > 1 ? 'columns' : 'column'} ${columns}`;
  const base = `Comma-separated list of values to match in ${target}. Pass every value you need in one call (for example "A,B,C") instead of calling the tool once per value.${example}`;
  return nullable ? `${base} Omit it to skip this filter.` : base;
}

/**
 * 値の並びを受け取る引数プロパティへ説明文を足す（型は string のまま。enum は付けない）。
 * inputSchema に列が無い・string 型でない（いずれも保存時に拒否される不整合な旧 Tool）は触らない。
 */
function withListValueDescriptions(schema: JsonSchemaObject, graph: ToolGraph, inputSchema: Schema | undefined): JsonSchemaObject {
  const summaries = listValueArgumentSummaries(graph.nodes.filter((node) => node.type === 'filter').map((node) => node.config));
  if (summaries.length === 0) return schema;
  const properties: Record<string, JsonSchemaProperty> = { ...schema.properties };
  for (const summary of summaries) {
    const column = inputSchema?.columns.find((candidate) => candidate.name === summary.field);
    if (column === undefined || column.type !== 'string') continue;
    const description = listValueDescription(summary, column.nullable);
    properties[summary.field] = column.nullable
      ? { anyOf: [{ type: 'string' }, { type: 'null' }], description }
      : { type: 'string', description };
  }
  return { ...schema, properties };
}

/**
 * function 名として公開できる文字列か。`toolToModelDefinition` が実行時に投げる判定そのもので、
 * 保存時の拒否（SaveTool）・プリフライト診断も同じ関数を使い、規則を1か所に置く。
 * 規則の実体は `domain/shared/function-name.ts` の `isFunctionName`（v50 R6）。
 */
export function isValidFunctionName(name: string): boolean {
  return isFunctionName(name);
}

/**
 * Tool を LLM へ公開する function definition へ変換する。
 * filter の opBinding が参照する引数プロパティには、許可演算子の enum と英語の説明文を付与する
 * （Agent は enum の中から演算子を選んで引数として渡す）。`in`/`notIn` の valueBinding が参照する
 * 引数には「カンマ区切りで複数の値を一度に渡せる」説明文を付与する。
 */
export function toolToModelDefinition(tool: Tool): ModelToolDefinition {
  const name = tool.agentTool?.name ?? tool.metadata.publishName;
  if (!isValidFunctionName(name)) {
    throw new AgentRunError(`tool name is not a valid function name: ${name}`);
  }
  return {
    name,
    description: tool.agentTool?.description ?? `${tool.metadata.displayName} (${tool.sideEffect})`,
    parameters: withListValueDescriptions(withOperatorEnums(schemaToJsonSchema(tool.inputSchema), tool.graph, tool.inputSchema), tool.graph, tool.inputSchema),
  };
}

/**
 * 差し戻しメッセージ用に、受け取った値を JSON（切り詰め）+ 型名で描写する。
 * 「期待した型」だけでは小さいモデルが同じ間違いを繰り返しやすい——
 * `["x"] (array)` のように**自分が何を送ったか**を見せると修復が1回で決まりやすい。
 * 引数はトレース（tool-call イベント）に既に全文が残るものなので、ここで見せても露出は増えない。
 */
function describeReceived(value: JsonValue): string {
  if (value === null) return 'null';
  const kind = Array.isArray(value) ? 'array' : typeof value;
  const json = JSON.stringify(value);
  const shown = json.length > 120 ? `${json.slice(0, 117)}…` : json;
  return `${shown} (${kind})`;
}

function normalizeValue(value: JsonValue | undefined, column: Column): Cell {
  if (value === null || value === undefined) {
    if (column.type === 'null' && value === null) return null;
    if (column.nullable) return null;
    throw new ToolArgumentsError(`required argument missing: ${column.name}`);
  }
  switch (column.type) {
    case 'string':
      if (typeof value === 'string') return value;
      break;
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      break;
    case 'date':
      if (typeof value === 'string') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date;
      }
      break;
    case 'null':
      if (value === null) return null;
      break;
    case 'unknown':
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      break;
  }
  throw new ToolArgumentsError(`invalid argument '${column.name}': expected ${column.type}, received ${describeReceived(value)}`);
}

export function validateToolArguments(schema: Schema | undefined, args: JsonObject): Row {
  const columns = schema?.columns ?? [];
  const names = new Set(columns.map((column) => column.name));
  const extra = Object.keys(args).filter((name) => !names.has(name));
  if (extra.length > 0) throw new ToolArgumentsError(`unknown argument(s): ${extra.join(', ')}`);
  const row: Record<string, Cell> = {};
  for (const column of columns) row[column.name] = normalizeValue(args[column.name], column);
  return row;
}

function valueMatches(value: Cell | undefined, column: Column): boolean {
  if (value === null || value === undefined) return column.nullable || column.type === 'null';
  if (column.type === 'unknown') return true;
  if (column.type === 'date') return value instanceof Date && !Number.isNaN(value.getTime());
  return typeof value === column.type;
}

export function assertOutputMatchesSchema(table: Table, schema: Schema | undefined): void {
  if (schema === undefined) return;
  const incompatibility = schemaIncompatibility(table.schema, schema);
  if (incompatibility !== undefined) {
    throw new AgentRunError(`tool output schema ${incompatibility}`);
  }
  for (const row of table.rows) {
    for (const column of schema.columns) {
      if (!valueMatches(row[column.name], column)) {
        throw new AgentRunError(`tool output mismatch at '${column.name}': expected ${column.type}`);
      }
    }
  }
}

export function schemasEqual(left: Schema | undefined, right: Schema | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.columns.length !== right.columns.length) return false;
  return left.columns.every((column, index) => {
    const other = right.columns[index];
    return other !== undefined && column.name === other.name && column.type === other.type && column.nullable === other.nullable;
  });
}

/**
 * inputSchema と agent-input ノードの不整合を、実行時 `graphWithArguments` と同じ規則・同じ英文で
 * 返す（整合していれば undefined）。保存時の拒否（SaveTool）とプリフライト診断が共有し、
 * 「保存できた Tool は実行時にこの理由では落ちない」を1つの判定で保証する。
 * - inputSchema に列があるのに agent-input ノードが無い → 引数を受け取る場所が無い。
 * - agent-input ノードの schema が inputSchema と一致しない → 引数の形が食い違う。
 * 2条件は排他（前者はノード0件、後者はノード1件以上が前提）なので、検査順は結果に影響しない。
 * 未保存の入力（SaveToolInput）でも使えるよう、Tool 全体ではなく graph と inputSchema だけを受ける。
 */
export function agentInputInconsistency(tool: { readonly graph: ToolGraph; readonly inputSchema?: Schema | undefined }): string | undefined {
  const inputNodes = tool.graph.nodes.filter((node) => node.type === 'agent-input');
  if ((tool.inputSchema?.columns.length ?? 0) > 0 && inputNodes.length === 0) {
    return 'tool declares inputSchema but has no agent-input node';
  }
  for (const node of inputNodes) {
    const config = node.config as { schema?: Schema } | null;
    if (!schemasEqual(tool.inputSchema, config?.schema)) {
      return `tool inputSchema does not match agent-input node '${node.id}'`;
    }
  }
  return undefined;
}
