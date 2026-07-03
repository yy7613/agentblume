import type { Cell, Column, Row, Schema, Table } from '../../domain/data/types';
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

export function toolToModelDefinition(tool: Tool): ModelToolDefinition {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.metadata.publishName)) {
    throw new AgentRunError(`publishName is not a valid function name: ${tool.metadata.publishName}`);
  }
  return {
    name: tool.metadata.publishName,
    description: `${tool.metadata.displayName} (${tool.sideEffect})`,
    parameters: schemaToJsonSchema(tool.inputSchema),
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
