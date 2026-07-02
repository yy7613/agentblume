import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { renameNode } from './rename';

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

describe('rename: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(renameNode.type).toBe('rename');
    expect(renameNode.kind).toBe('transform');
    expect(renameNode.inputArity).toBe(1);
  });
});

describe('rename: validateConfig', () => {
  it('accepts a renames array', () => {
    const cfg = renameNode.validateConfig({ renames: [{ from: 'a', to: 'b' }] });
    expect(cfg.renames).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('throws ConfigError when renames is missing', () => {
    expect(() => renameNode.validateConfig({})).toThrowError(ConfigError);
  });

  it('throws ConfigError when a rename entry lacks to', () => {
    expect(() => renameNode.validateConfig({ renames: [{ from: 'a' }] })).toThrowError(ConfigError);
  });
});

describe('rename: inferSchema', () => {
  it('valid renames -> confirmed, names replaced in order', () => {
    const inf = renameNode.inferSchema([schema], {
      renames: [{ from: 'name', to: 'displayName' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'displayName', 'age']);
    // type / nullable preserved.
    expect(inf.schema.columns[1]).toEqual({
      name: 'displayName',
      type: 'string',
      nullable: true,
    });
  });

  it('missing from column -> mismatch with error', () => {
    const inf = renameNode.inferSchema([schema], { renames: [{ from: 'nope', to: 'x' }] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('rename causing a duplicate name -> mismatch', () => {
    const inf = renameNode.inferSchema([schema], { renames: [{ from: 'name', to: 'id' }] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.message).toContain('duplicate');
  });

  it('two renames onto the same target -> duplicate mismatch', () => {
    const inf = renameNode.inferSchema([schema], {
      renames: [
        { from: 'id', to: 'x' },
        { from: 'age', to: 'x' },
      ],
    });
    expect(inf.state).toBe('mismatch');
  });

  it('swapping two names is valid (no duplicate)', () => {
    const inf = renameNode.inferSchema([schema], {
      renames: [
        { from: 'id', to: 'age' },
        { from: 'age', to: 'id' },
      ],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['age', 'name', 'id']);
  });
});

describe('rename: execute', () => {
  it('renames row keys, preserving values and order', () => {
    const out = renameNode.execute([table], { renames: [{ from: 'name', to: 'displayName' }] });
    expect(out.schema.columns.map((c) => c.name)).toEqual(['id', 'displayName', 'age']);
    expect(out.rows).toEqual([
      { id: 1, displayName: 'Alice', age: 30 },
      { id: 2, displayName: 'Bob', age: 25 },
    ]);
  });

  it('throws SchemaError when a from column is missing', () => {
    expect(() => renameNode.execute([table], { renames: [{ from: 'nope', to: 'x' }] })).toThrowError(
      SchemaError,
    );
  });

  it('throws SchemaError when the rename creates a duplicate', () => {
    expect(() => renameNode.execute([table], { renames: [{ from: 'name', to: 'id' }] })).toThrowError(
      SchemaError,
    );
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows);
    renameNode.execute([table], { renames: [{ from: 'name', to: 'displayName' }] });
    expect(JSON.stringify(table.rows)).toBe(snapshot);
  });
});
