import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import { filterNode } from './filter';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: true },
    { name: 'age', type: 'number', nullable: false },
    { name: 'joined', type: 'date', nullable: false },
    { name: 'active', type: 'boolean', nullable: false },
  ],
};

const d = (s: string): Date => new Date(s);

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Alice', age: 30, joined: d('2020-01-01T00:00:00Z'), active: true },
    { id: 2, name: 'Bob', age: 17, joined: d('2021-06-01T00:00:00Z'), active: false },
    { id: 3, name: null, age: 40, joined: d('2019-03-15T00:00:00Z'), active: true },
  ],
};

describe('filter: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(filterNode.type).toBe('filter');
    expect(filterNode.kind).toBe('transform');
    expect(filterNode.inputArity).toBe(1);
  });
});

describe('filter: validateConfig', () => {
  it('accepts a valid config with value', () => {
    const cfg = filterNode.validateConfig({ column: 'age', op: 'gte', value: 18 });
    expect(cfg).toEqual({ column: 'age', op: 'gte', value: 18 });
  });

  it('accepts a config without value (isNull)', () => {
    const cfg = filterNode.validateConfig({ column: 'name', op: 'isNull' });
    expect(cfg.value).toBeUndefined();
  });

  it('throws ConfigError on an unknown op', () => {
    expect(() => filterNode.validateConfig({ column: 'age', op: 'between' })).toThrowError(
      ConfigError,
    );
  });

  it('throws ConfigError when column missing', () => {
    expect(() => filterNode.validateConfig({ op: 'eq' })).toThrowError(ConfigError);
  });
});

describe('filter: inferSchema', () => {
  it('valid op on existing column -> confirmed, schema unchanged', () => {
    const inf = filterNode.inferSchema([schema], { column: 'age', op: 'gte', value: 18 });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema).toEqual(schema);
  });

  it('missing column -> mismatch with error', () => {
    const inf = filterNode.inferSchema([schema], { column: 'nope', op: 'eq', value: 1 });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('order op on non-number/date column -> mismatch (type error)', () => {
    const inf = filterNode.inferSchema([schema], { column: 'name', op: 'gt', value: 'x' });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.message).toContain('number|date');
  });

  it('order op on date column -> confirmed', () => {
    const inf = filterNode.inferSchema([schema], {
      column: 'joined',
      op: 'lt',
      value: d('2020-06-01T00:00:00Z'),
    });
    expect(inf.state).toBe('confirmed');
  });

  it('order op on boolean column -> mismatch', () => {
    const inf = filterNode.inferSchema([schema], { column: 'active', op: 'gte', value: true });
    expect(inf.state).toBe('mismatch');
  });

  it('contains on string column (non-order op) -> confirmed', () => {
    const inf = filterNode.inferSchema([schema], { column: 'name', op: 'contains', value: 'li' });
    expect(inf.state).toBe('confirmed');
  });
});

describe('filter: execute', () => {
  it('gte on number keeps matching rows', () => {
    const out = filterNode.execute([table], { column: 'age', op: 'gte', value: 18 });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
    expect(out.schema).toBe(table.schema);
  });

  it('gt / lt / lte on number', () => {
    expect(
      filterNode.execute([table], { column: 'age', op: 'gt', value: 30 }).rows.map((r) => r.id),
    ).toEqual([3]);
    expect(
      filterNode.execute([table], { column: 'age', op: 'lt', value: 30 }).rows.map((r) => r.id),
    ).toEqual([2]);
    expect(
      filterNode.execute([table], { column: 'age', op: 'lte', value: 30 }).rows.map((r) => r.id),
    ).toEqual([1, 2]);
  });

  it('eq / neq exact equality', () => {
    expect(
      filterNode.execute([table], { column: 'id', op: 'eq', value: 2 }).rows.map((r) => r.id),
    ).toEqual([2]);
    expect(
      filterNode.execute([table], { column: 'id', op: 'neq', value: 2 }).rows.map((r) => r.id),
    ).toEqual([1, 3]);
  });

  it('eq on Date compares by time value', () => {
    const out = filterNode.execute([table], {
      column: 'joined',
      op: 'eq',
      value: d('2020-01-01T00:00:00Z'),
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('lt/gt on Date compares chronologically', () => {
    const out = filterNode.execute([table], {
      column: 'joined',
      op: 'lt',
      value: d('2020-06-01T00:00:00Z'),
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('contains stringifies both operands', () => {
    const out = filterNode.execute([table], { column: 'name', op: 'contains', value: 'li' });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('contains against null cell -> String(null) has no match unless value in "null"', () => {
    // row id:3 has name null -> String(null) === 'null'
    const out = filterNode.execute([table], { column: 'name', op: 'contains', value: 'ul' });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });

  it('isNull keeps rows where cell is null', () => {
    const out = filterNode.execute([table], { column: 'name', op: 'isNull' });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });

  it('notNull keeps rows where cell is not null', () => {
    const out = filterNode.execute([table], { column: 'name', op: 'notNull' });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('order comparison with non-comparable value yields no rows', () => {
    // value undefined -> null -> NaN comparable -> excluded.
    const out = filterNode.execute([table], { column: 'age', op: 'gt' });
    expect(out.rows).toEqual([]);
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows.map((r) => ({ ...r, joined: undefined })));
    filterNode.execute([table], { column: 'age', op: 'gte', value: 18 });
    expect(JSON.stringify(table.rows.map((r) => ({ ...r, joined: undefined })))).toBe(snapshot);
  });
});
