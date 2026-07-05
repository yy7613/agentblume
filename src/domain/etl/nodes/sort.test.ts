import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { sortNode } from './sort';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'age', type: 'number', nullable: true },
    { name: 'joined', type: 'date', nullable: false },
    { name: 'active', type: 'boolean', nullable: false },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Carol', age: 25, joined: new Date('2021-03-01'), active: true },
    { id: 2, name: 'Alice', age: null, joined: new Date('2020-01-01'), active: false },
    { id: 3, name: 'Bob', age: 30, joined: new Date('2022-06-15'), active: true },
    { id: 4, name: 'Alice', age: 20, joined: new Date('2019-12-31'), active: false },
  ],
};

describe('sort: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(sortNode.type).toBe('sort');
    expect(sortNode.kind).toBe('transform');
    expect(sortNode.inputArity).toBe(1);
  });
});

describe('sort: validateConfig', () => {
  it('accepts keys with defaults omitted', () => {
    const config = sortNode.validateConfig({ keys: [{ column: 'a' }] });
    expect(config.keys[0]?.direction).toBeUndefined();
    expect(config.keys[0]?.nulls).toBeUndefined();
  });

  it('throws ConfigError when keys is empty', () => {
    expect(() => sortNode.validateConfig({ keys: [] })).toThrowError(ConfigError);
  });

  it('throws ConfigError for an unknown direction', () => {
    expect(() =>
      sortNode.validateConfig({ keys: [{ column: 'a', direction: 'up' }] }),
    ).toThrowError(ConfigError);
  });

  it('throws ConfigError for an unknown nulls placement', () => {
    expect(() =>
      sortNode.validateConfig({ keys: [{ column: 'a', nulls: 'middle' }] }),
    ).toThrowError(ConfigError);
  });
});

describe('sort: inferSchema', () => {
  it('existing columns -> schema unchanged, confirmed', () => {
    const inf = sortNode.inferSchema([schema], { keys: [{ column: 'name' }, { column: 'age' }] });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema).toBe(schema);
  });

  it('missing column -> error issue with column, mismatch', () => {
    const inf = sortNode.inferSchema([schema], { keys: [{ column: 'nope' }] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('no input schema -> everything missing', () => {
    const inf = sortNode.inferSchema([], { keys: [{ column: 'id' }] });
    expect(inf.state).toBe('mismatch');
  });
});

describe('sort: execute', () => {
  it('sorts strings ascending by default', () => {
    const out = sortNode.execute([table], { keys: [{ column: 'name' }] });
    expect(out.rows.map((r) => r['name'])).toEqual(['Alice', 'Alice', 'Bob', 'Carol']);
  });

  it('is stable: equal keys keep the original relative order', () => {
    const out = sortNode.execute([table], { keys: [{ column: 'name' }] });
    // Alice は id:2（元順で先）→ id:4 の順を保つ。
    expect(out.rows.map((r) => r['id'])).toEqual([2, 4, 3, 1]);
  });

  it('sorts numbers descending', () => {
    const out = sortNode.execute([table], {
      keys: [{ column: 'age', direction: 'desc' }],
    });
    // null は既定 'last' で末尾（desc でも絶対位置）。
    expect(out.rows.map((r) => r['age'])).toEqual([30, 25, 20, null]);
  });

  it('nulls:first places nulls at the head regardless of direction', () => {
    const asc = sortNode.execute([table], {
      keys: [{ column: 'age', direction: 'asc', nulls: 'first' }],
    });
    expect(asc.rows.map((r) => r['age'])).toEqual([null, 20, 25, 30]);

    const desc = sortNode.execute([table], {
      keys: [{ column: 'age', direction: 'desc', nulls: 'first' }],
    });
    expect(desc.rows.map((r) => r['age'])).toEqual([null, 30, 25, 20]);
  });

  it('sorts dates by time value', () => {
    const out = sortNode.execute([table], { keys: [{ column: 'joined' }] });
    expect(out.rows.map((r) => r['id'])).toEqual([4, 2, 1, 3]);
  });

  it('sorts booleans with false before true', () => {
    const out = sortNode.execute([table], {
      keys: [{ column: 'active' }, { column: 'id' }],
    });
    expect(out.rows.map((r) => r['id'])).toEqual([2, 4, 1, 3]);
  });

  it('applies multiple keys in order (name asc, then age desc)', () => {
    const out = sortNode.execute([table], {
      keys: [
        { column: 'name' },
        { column: 'age', direction: 'desc' },
      ],
    });
    // Alice 同士は age desc（null は last）→ id:4 (20) が id:2 (null) より先。
    expect(out.rows.map((r) => r['id'])).toEqual([4, 2, 3, 1]);
  });

  it('compares mixed-type cells by their string form', () => {
    const mixed: Table = {
      schema: { columns: [{ name: 'v', type: 'unknown', nullable: false }] },
      rows: [{ v: 'b' }, { v: 10 }, { v: 'a' }],
    };
    const out = sortNode.execute([mixed], { keys: [{ column: 'v' }] });
    // String 化比較: '10' < 'a' < 'b'。
    expect(out.rows.map((r) => r['v'])).toEqual([10, 'a', 'b']);
  });

  it('throws SchemaError when a sort column is missing', () => {
    expect(() => sortNode.execute([table], { keys: [{ column: 'missing' }] })).toThrowError(
      SchemaError,
    );
  });

  it('does not mutate the input rows array or its order', () => {
    const before = table.rows.map((r) => r['id']);
    sortNode.execute([table], { keys: [{ column: 'name' }] });
    expect(table.rows.map((r) => r['id'])).toEqual(before);
  });
});
