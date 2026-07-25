import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import { limitNode } from './limit';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: true },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 3, name: null },
    { id: 4, name: 'Dave' },
  ],
};

describe('limit: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(limitNode.type).toBe('limit');
    expect(limitNode.kind).toBe('transform');
    expect(limitNode.inputArity).toBe(1);
  });
});

describe('limit: validateConfig', () => {
  it('accepts a count with and without an offset', () => {
    expect(limitNode.validateConfig({ count: 10 })).toEqual({ count: 10 });
    expect(limitNode.validateConfig({ count: 10, offset: 5 })).toEqual({ count: 10, offset: 5 });
  });

  it('accepts the boundary values (count 1..10000 / offset 0)', () => {
    expect(limitNode.validateConfig({ count: 1, offset: 0 })).toEqual({ count: 1, offset: 0 });
    expect(limitNode.validateConfig({ count: 10000 })).toEqual({ count: 10000 });
  });

  it('rejects out-of-range, fractional and missing counts', () => {
    expect(() => limitNode.validateConfig({ count: 0 })).toThrowError(ConfigError);
    expect(() => limitNode.validateConfig({ count: 10001 })).toThrowError(ConfigError);
    expect(() => limitNode.validateConfig({ count: 1.5 })).toThrowError(ConfigError);
    expect(() => limitNode.validateConfig({})).toThrowError(/^limit: invalid config:/);
  });

  it('rejects a negative or fractional offset', () => {
    expect(() => limitNode.validateConfig({ count: 5, offset: -1 })).toThrowError(ConfigError);
    expect(() => limitNode.validateConfig({ count: 5, offset: 0.5 })).toThrowError(ConfigError);
  });
});

describe('limit: inferSchema', () => {
  it('keeps the input schema and confirms it', () => {
    const inference = limitNode.inferSchema([schema], { count: 2 });
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema).toBe(schema);
  });

  it('treats a missing input as an empty schema', () => {
    expect(limitNode.inferSchema([], { count: 2 }).schema).toEqual({ columns: [] });
  });
});

describe('limit: execute', () => {
  it('keeps the first count rows', () => {
    expect(limitNode.execute([table], { count: 2 }).rows.map((row) => row['id'])).toEqual([1, 2]);
  });

  it('skips offset rows first (top-N after sort)', () => {
    expect(limitNode.execute([table], { count: 2, offset: 1 }).rows.map((row) => row['id'])).toEqual([2, 3]);
  });

  it('returns the remaining rows when count exceeds them', () => {
    expect(limitNode.execute([table], { count: 100, offset: 3 }).rows.map((row) => row['id'])).toEqual([4]);
  });

  it('returns no rows when the offset is past the end', () => {
    expect(limitNode.execute([table], { count: 5, offset: 10 }).rows).toEqual([]);
  });

  it('keeps the schema identical (reference preserved)', () => {
    expect(limitNode.execute([table], { count: 1 }).schema).toBe(table.schema);
  });

  it('handles an empty input table and a missing input', () => {
    expect(limitNode.execute([{ schema, rows: [] }], { count: 3 }).rows).toEqual([]);
    const out = limitNode.execute([], { count: 3 });
    expect(out.rows).toEqual([]);
    expect(out.schema).toEqual({ columns: [] });
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows);
    limitNode.execute([table], { count: 2, offset: 1 });
    expect(JSON.stringify(table.rows)).toBe(snapshot);
  });
});
