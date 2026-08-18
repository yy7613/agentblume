import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../domain/data/types';
import { FILTER_OPS } from '../../domain/etl/nodes/filter';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { AgentRunError, ToolArgumentsError } from './errors';
import { assertOutputMatchesSchema, schemaToJsonSchema, schemasEqual, toolToModelDefinition, validateToolArguments } from './tool-schema';

const schema: Schema = { columns: [
  { name: 'month', type: 'string', nullable: false },
  { name: 'at', type: 'date', nullable: true },
] };

describe('Tool Calling schema', () => {
  it('SchemaをJSON Schemaへ変換する', () => {
    expect(schemaToJsonSchema(schema)).toEqual({
      type: 'object', additionalProperties: false, required: ['month'],
      properties: {
        month: { type: 'string' },
        at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      },
    });
  });

  it('Tool metadataをfunction definitionへ変換する', () => {
    const tool = createTool({
      metadata: { internalId: 't', workingName: 'w', displayName: 'Sales', publishName: 'sales_summary', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] }, inputSchema: schema,
    });
    expect(toolToModelDefinition(tool)).toMatchObject({ name: 'sales_summary', description: 'Sales (read-only)', parameters: { required: ['month'] } });
  });

  it('Agent向けに設定した名前と説明をfunction definitionへ使う', () => {
    const tool = createTool({
      metadata: { internalId: 't', workingName: 'w', displayName: 'Sales', publishName: 'sales_summary', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] }, inputSchema: schema,
      agentTool: { name: 'find_sales', description: 'Find sales totals for a requested month.' },
    });
    expect(toolToModelDefinition(tool)).toMatchObject({ name: 'find_sales', description: 'Find sales totals for a requested month.' });
  });

  it('不正function名と重複input列を拒否する', () => {
    const badTool = createTool({
      metadata: { internalId: 't', workingName: 'w', displayName: 'Bad', publishName: 'bad name', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] },
    });
    expect(() => toolToModelDefinition(badTool)).toThrow(/function name/);
    expect(() => schemaToJsonSchema({ columns: [
      { name: 'x', type: 'string', nullable: false }, { name: 'x', type: 'number', nullable: false },
    ] })).toThrow(/duplicate/);
  });

  it('argumentsを検証しdateを正規化する', () => {
    const row = validateToolArguments(schema, { month: '2026-07', at: '2026-07-03T00:00:00Z' });
    expect(row['month']).toBe('2026-07');
    expect(row['at']).toBeInstanceOf(Date);
  });

  it.each([
    [{ at: null }, /required/],
    [{ month: 7 }, /expected string/],
    [{ month: '2026-07', extra: true }, /unknown argument/],
  ])('invalid argumentsを拒否する', (args, message) => {
    expect(() => validateToolArguments(schema, args)).toThrow(expect.objectContaining({ message: expect.stringMatching(message) }));
  });

  it('output schema mismatchを拒否する', () => {
    const table = { schema, rows: [{ month: 7, at: null }] } as unknown as Table;
    expect(() => assertOutputMatchesSchema(table, schema)).toThrow(AgentRunError);
    expect(() => assertOutputMatchesSchema(table, undefined)).not.toThrow();
    expect(() => assertOutputMatchesSchema({ schema: { columns: [] }, rows: [] }, schema)).toThrow(/column count/);
  });

  it('schema equalityは列順・型・nullableを含める', () => {
    expect(schemasEqual(schema, structuredClone(schema))).toBe(true);
    expect(schemasEqual(undefined, undefined)).toBe(true);
    expect(schemasEqual(schema, undefined)).toBe(false);
    expect(schemasEqual(schema, { columns: [...schema.columns].reverse() })).toBe(false);
  });

  it('全DataType・nullableをJSON Schemaと実行値へ変換する', () => {
    const every: Schema = { columns: [
      { name: 's', type: 'string', nullable: false },
      { name: 'n', type: 'number', nullable: false },
      { name: 'b', type: 'boolean', nullable: false },
      { name: 'd', type: 'date', nullable: false },
      { name: 'z', type: 'null', nullable: false },
      { name: 'u', type: 'unknown', nullable: false },
      { name: 'optional', type: 'string', nullable: true },
    ] };
    expect(schemaToJsonSchema(every).properties).toMatchObject({
      s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' },
      d: { type: 'string', format: 'date-time' }, z: { type: 'null' }, u: {},
      optional: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    });
    expect(schemaToJsonSchema(undefined)).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    const row = validateToolArguments(every, {
      s: 'x', n: 1, b: true, d: '2026-07-03T00:00:00Z', z: null, u: 'anything',
    });
    expect(row).toMatchObject({ s: 'x', n: 1, b: true, z: null, u: 'anything', optional: null });
    expect(row['d']).toBeInstanceOf(Date);
    expect(() => assertOutputMatchesSchema({ schema: every, rows: [row] }, every)).not.toThrow();
  });
});

/** filter ノード1つ + inputSchema の Tool を組み立てる（opBinding の enum 公開テスト用）。 */
function filterTool(inputSchema: Schema, filterConfig: unknown) {
  return createTool({
    metadata: { internalId: 't', workingName: 'w', displayName: 'Filter', publishName: 'filter_rows', version: SemVer.parse('1.0.0'), owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
    sideEffect: 'read-only',
    graph: { nodes: [{ id: 'f', type: 'filter', config: filterConfig }], edges: [] },
    inputSchema,
  });
}

describe('filter opBinding の JSON Schema 公開', () => {
  it('opバインドされたstring引数にenumとdescriptionを付け、他の引数は従来どおり', () => {
    const inputSchema: Schema = { columns: [
      { name: 'month', type: 'string', nullable: false },
      { name: 'priceOp', type: 'string', nullable: false },
    ] };
    const tool = filterTool(inputSchema, {
      column: 'price', op: 'gte', value: 100,
      opBinding: { source: 'agent-input', field: 'priceOp', allowed: ['gt', 'gte', 'lt', 'lte'] },
    });
    const { properties } = toolToModelDefinition(tool).parameters;
    expect(properties['priceOp']).toEqual({
      type: 'string',
      enum: ['gt', 'gte', 'lt', 'lte'],
      description: "Row filter operator applied to column 'price'.",
    });
    // opバインドの無い引数は触らない。
    expect(properties['month']).toEqual({ type: 'string' });
  });

  it('nullable引数はanyOf内のstringへenumを付け、既定演算子の省略時挙動を説明する', () => {
    const inputSchema: Schema = { columns: [{ name: 'priceOp', type: 'string', nullable: true }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gte', value: 100, opBinding: { source: 'agent-input', field: 'priceOp', allowed: ['gt', 'gte'] } },
    ], combine: 'and' });
    expect(toolToModelDefinition(tool).parameters.properties['priceOp']).toEqual({
      anyOf: [{ type: 'string', enum: ['gt', 'gte'] }, { type: 'null' }],
      description: "Row filter operator applied to column 'price'. Omit it to use the default operator 'gte'.",
    });
  });

  it('allowed省略時は全演算子がenumに載る', () => {
    const inputSchema: Schema = { columns: [{ name: 'op', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, {
      column: 'price', op: 'eq', value: 1,
      opBinding: { source: 'agent-input', field: 'op' },
    });
    const property = toolToModelDefinition(tool).parameters.properties['op'];
    expect(property?.enum).toEqual([...FILTER_OPS]);
    expect(property?.enum).toHaveLength(9);
  });

  it('同一fieldを複数条件がバインドしたらenumは積集合・descriptionは全列を列挙する', () => {
    const inputSchema: Schema = { columns: [{ name: 'op', type: 'string', nullable: false }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gte', value: 1, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'gte', 'lt'] } },
      { column: 'stock', op: 'gte', value: 2, opBinding: { source: 'agent-input', field: 'op', allowed: ['gte', 'lt', 'lte'] } },
    ], combine: 'and' });
    expect(toolToModelDefinition(tool).parameters.properties['op']).toEqual({
      type: 'string',
      enum: ['gte', 'lt'],
      description: "Row filter operator applied to columns 'price', 'stock'.",
    });
  });

  it('既定演算子が条件間で一致しない場合はOmitの説明を付けない', () => {
    const inputSchema: Schema = { columns: [{ name: 'op', type: 'string', nullable: true }] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
      { column: 'stock', op: 'lt', value: 1, opBinding: { source: 'agent-input', field: 'op', allowed: ['gt', 'lt'] } },
    ], combine: 'and' });
    expect(toolToModelDefinition(tool).parameters.properties['op']).toEqual({
      anyOf: [{ type: 'string', enum: ['gt', 'lt'] }, { type: 'null' }],
      description: "Row filter operator applied to columns 'price', 'stock'.",
    });
  });

  it('stringベースでない引数や積集合が空の引数は変更しない（不整合な旧Toolでもクラッシュしない）', () => {
    const inputSchema: Schema = { columns: [
      { name: 'wrongType', type: 'number', nullable: false },
      { name: 'emptyOp', type: 'string', nullable: false },
    ] };
    const tool = filterTool(inputSchema, { conditions: [
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'wrongType' } },
      { column: 'price', op: 'gt', value: 1, opBinding: { source: 'agent-input', field: 'emptyOp', allowed: ['gt'] } },
      { column: 'stock', op: 'lt', value: 1, opBinding: { source: 'agent-input', field: 'emptyOp', allowed: ['lt'] } },
    ], combine: 'and' });
    const { properties } = toolToModelDefinition(tool).parameters;
    expect(properties['wrongType']).toEqual({ type: 'number' });
    expect(properties['emptyOp']).toEqual({ type: 'string' });
  });
});
