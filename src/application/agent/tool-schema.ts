import type { Cell, Column, Row, Schema, Table } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { FILTER_OPS, operatorBindingsOf } from '../../domain/etl/nodes/filter';
import type { FilterOp, OperatorBindingSite } from '../../domain/etl/nodes/filter';
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

/** 1つの Agent 引数（field）へ集約した opBinding 情報。 */
interface OperatorArgumentInfo {
  /** Agent が選べる演算子（全条件の許可リストの積集合。FILTER_OPS の順序を保つ）。 */
  readonly allowed: readonly FilterOp[];
  /** この引数が演算子を差し替える列名（重複排除済み）。 */
  readonly columns: readonly string[];
  /** 既定演算子。全条件の設計時 op が一致する場合のみ定まる。 */
  readonly defaultOp?: FilterOp;
}

/**
 * グラフ中の filter ノードから opBinding を集め、Agent 引数名（field）ごとに集約する。
 * 同一 field を複数条件がバインドする場合、allowed は積集合・columns は列名の和（重複排除）・
 * defaultOp は全条件で一致するときのみ採用する。
 */
function operatorArgumentsOf(graph: ToolGraph): Map<string, OperatorArgumentInfo> {
  const sitesByField = new Map<string, OperatorBindingSite[]>();
  for (const node of graph.nodes) {
    if (node.type !== 'filter') continue;
    for (const site of operatorBindingsOf(node.config)) {
      const sites = sitesByField.get(site.field);
      if (sites === undefined) sitesByField.set(site.field, [site]);
      else sites.push(site);
    }
  }
  const result = new Map<string, OperatorArgumentInfo>();
  for (const [field, sites] of sitesByField) {
    const allowed = FILTER_OPS.filter((op) => sites.every((site) => site.allowed.includes(op)));
    const columns = [...new Set(sites.map((site) => site.column))];
    const defaultOp = sites[0]?.defaultOp;
    const uniform = defaultOp !== undefined && sites.every((site) => site.defaultOp === defaultOp);
    result.set(field, { allowed, columns, ...(uniform ? { defaultOp } : {}) });
  }
  return result;
}

/** `{ type: 'string' }` そのもの（format/enum/anyOf の無い素の string プロパティ）か。 */
function isPlainString(prop: JsonSchemaProperty | undefined): boolean {
  return prop !== undefined && prop.type === 'string'
    && prop.format === undefined && prop.enum === undefined && prop.anyOf === undefined;
}

/** op バインドされた引数の LLM 向け説明文（英語）。nullable で既定演算子が定まる場合は省略時の挙動も伝える。 */
function operatorDescription(info: OperatorArgumentInfo, nullable: boolean): string {
  const columns = info.columns.map((column) => `'${column}'`).join(', ');
  const base = `Row filter operator applied to ${info.columns.length > 1 ? 'columns' : 'column'} ${columns}.`;
  return nullable && info.defaultOp !== undefined
    ? `${base} Omit it to use the default operator '${info.defaultOp}'.`
    : base;
}

/**
 * op バインドされた引数プロパティへ許可演算子の enum と説明を付与した JSON Schema を返す。
 * - 非 nullable（`{ type:'string' }`）→ enum を直接付ける。
 * - nullable（`{ anyOf: [string, null] }`）→ anyOf 内の string 側へ enum を付ける。
 * - プロパティが string ベースでない・積集合が空（いずれも保存時に拒否される不整合な旧 Tool）は
 *   触らずそのまま返す（LLM 公開でクラッシュさせない）。
 */
function withOperatorEnums(schema: JsonSchemaObject, graph: ToolGraph): JsonSchemaObject {
  const operatorArguments = operatorArgumentsOf(graph);
  if (operatorArguments.size === 0) return schema;
  const properties: Record<string, JsonSchemaProperty> = { ...schema.properties };
  for (const [field, info] of operatorArguments) {
    if (info.allowed.length === 0) continue;
    const prop = properties[field];
    if (prop === undefined) continue;
    if (isPlainString(prop)) {
      properties[field] = { type: 'string', enum: info.allowed, description: operatorDescription(info, false) };
    } else if (prop.anyOf !== undefined && prop.anyOf.length === 2
      && isPlainString(prop.anyOf[0]) && prop.anyOf[1]?.type === 'null') {
      properties[field] = {
        anyOf: [{ type: 'string', enum: info.allowed }, { type: 'null' }],
        description: operatorDescription(info, true),
      };
    }
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
    parameters: withOperatorEnums(schemaToJsonSchema(tool.inputSchema), tool.graph),
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
