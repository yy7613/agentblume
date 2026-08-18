import type { Cell, Column, Row, Schema, Table } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { operatorArgumentSummaries } from '../../domain/etl/nodes/filter';
import type { OperatorArgumentSummary } from '../../domain/etl/nodes/filter';
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
 * Tool を LLM へ公開する function definition へ変換する。
 * filter の opBinding が参照する引数プロパティには、許可演算子の enum と英語の説明文を付与する
 * （Agent は enum の中から演算子を選んで引数として渡す）。
 */
export function toolToModelDefinition(tool: Tool): ModelToolDefinition {
  const name = tool.agentTool?.name ?? tool.metadata.publishName;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new AgentRunError(`tool name is not a valid function name: ${name}`);
  }
  return {
    name,
    description: tool.agentTool?.description ?? `${tool.metadata.displayName} (${tool.sideEffect})`,
    parameters: withOperatorEnums(schemaToJsonSchema(tool.inputSchema), tool.graph, tool.inputSchema),
  };
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
  throw new ToolArgumentsError(`invalid argument '${column.name}': expected ${column.type}`);
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
  if (table.schema.columns.length !== schema.columns.length) {
    throw new AgentRunError(`tool output schema column count mismatch: expected ${schema.columns.length}, received ${table.schema.columns.length}`);
  }
  for (const expected of schema.columns) {
    const actual = table.schema.columns.find((column) => column.name === expected.name);
    if (actual === undefined || actual.type !== expected.type || (actual.nullable && !expected.nullable)) {
      throw new AgentRunError(`tool output schema mismatch at '${expected.name}'`);
    }
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
