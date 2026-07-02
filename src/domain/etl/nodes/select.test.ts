import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { selectNode } from './select';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: true },
    { name: 'age', type: 'number', nullable: false },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Alice', age: 30 },
    { id: 2, name: 'Bob', age: 25 },
  ],
};

describe('select: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(selectNode.type).toBe('select');
    expect(selectNode.kind).toBe('transform');
    expect(selectNode.inputArity).toBe(1);
  });
});

describe('select: validateConfig', () => {
  it('accepts a columns array', () => {
    expect(selectNode.validateConfig({ columns: ['a', 'b'] }).columns).toEqual(['a', 'b']);
  });

  it('throws ConfigError when columns is missing', () => {
    expect(() => selectNode.validateConfig({})).toThrowError(ConfigError);
  });

  it('throws ConfigError when columns is not an array of strings', () => {
    expect(() => selectNode.validateConfig({ columns: [1, 2] })).toThrowError(ConfigError);
  });
});

describe('select: inferSchema', () => {
  it('all columns present -> confirmed, in requested order', () => {
    const inf = selectNode.inferSchema([schema], { columns: ['age', 'id'] });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['age', 'id']);
    expect(inf.schema.columns[0]).toEqual({ name: 'age', type: 'number', nullable: false });
  });

  it('missing column -> mismatch with error issue including column', () => {
    const inf = selectNode.inferSchema([schema], { columns: ['id', 'nope'] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
    // schema contains only the existing columns.
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id']);
  });

  it('multiple missing columns -> one error each', () => {
    const inf = selectNode.inferSchema([schema], { columns: ['x', 'y'] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(2);
    expect(inf.schema.columns).toEqual([]);
  });

  it('no input schema -> everything missing', () => {
    const inf = selectNode.inferSchema([], { columns: ['id'] });
    expect(inf.state).toBe('mismatch');
  });
});

describe('select: execute', () => {
  it('projects rows to the requested columns in order', () => {
    const out = selectNode.execute([table], { columns: ['name', 'id'] });
    expect(out.schema.columns.map((c) => c.name)).toEqual(['name', 'id']);
    expect(out.rows).toEqual([
      { name: 'Alice', id: 1 },
      { name: 'Bob', id: 2 },
    ]);
  });

  it('throws SchemaError when a requested column is missing', () => {
    expect(() => selectNode.execute([table], { columns: ['id', 'missing'] })).toThrowError(
      SchemaError,
    );
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows);
    selectNode.execute([table], { columns: ['id'] });
    expect(JSON.stringify(table.rows)).toBe(snapshot);
  });

  it('empty columns -> rows become empty objects', () => {
    const out = selectNode.execute([table], { columns: [] });
    expect(out.schema.columns).toEqual([]);
    expect(out.rows).toEqual([{}, {}]);
  });
});
