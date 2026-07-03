import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../domain/data/types';
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
