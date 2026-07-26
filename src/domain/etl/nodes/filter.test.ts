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

  it('accepts an Agent input binding while retaining a design-time sample value', () => {
    expect(filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'minimumAge' } })).toMatchObject({ valueBinding: { source: 'agent-input', field: 'minimumAge' } });
  });

  it('accepts a config without value (isNull)', () => {
    const cfg = filterNode.validateConfig({ column: 'name', op: 'isNull' });
    expect(cfg).toEqual({ column: 'name', op: 'isNull' });
  });

  it('throws ConfigError on an unknown op', () => {
    expect(() => filterNode.validateConfig({ column: 'age', op: 'between' })).toThrowError(
      ConfigError,
    );
  });

  it('throws ConfigError when column missing', () => {
    expect(() => filterNode.validateConfig({ op: 'eq' })).toThrowError(ConfigError);
  });

  it('keeps the legacy flat shape unchanged (saved Tools must not be rewritten)', () => {
    expect(filterNode.validateConfig({ column: 'name', op: 'contains', value: 'li' }))
      .toEqual({ column: 'name', op: 'contains', value: 'li' });
  });

  it('accepts the multi-condition shape and defaults combine to and', () => {
    expect(filterNode.validateConfig({ conditions: [{ column: 'age', op: 'gte', value: 18 }] }))
      .toEqual({ conditions: [{ column: 'age', op: 'gte', value: 18 }], combine: 'and' });
    expect(filterNode.validateConfig({
      conditions: [{ column: 'name', op: 'eq', value: 'Alice' }, { column: 'name', op: 'eq', value: 'Bob' }],
      combine: 'or',
    })).toMatchObject({ combine: 'or' });
  });

  it('accepts a per-condition Agent input binding', () => {
    expect(filterNode.validateConfig({
      conditions: [{ column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'minimumAge' } }],
      combine: 'and',
    })).toMatchObject({ conditions: [{ valueBinding: { source: 'agent-input', field: 'minimumAge' } }] });
  });

  it('rejects an empty conditions array, an unknown combine and an invalid condition', () => {
    expect(() => filterNode.validateConfig({ conditions: [], combine: 'and' })).toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ conditions: [{ column: 'age', op: 'eq' }], combine: 'xor' })).toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ conditions: [{ op: 'eq' }] })).toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ conditions: 'age' })).toThrowError(ConfigError);
  });

  it('keeps the runtime skip marker for both shapes', () => {
    expect(filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, disabled: true }))
      .toEqual({ column: 'age', op: 'gte', value: 18, disabled: true });
    expect(filterNode.validateConfig({ conditions: [{ column: 'age', op: 'gte', value: 18, disabled: false }] }))
      .toEqual({ conditions: [{ column: 'age', op: 'gte', value: 18, disabled: false }], combine: 'and' });
    expect(() => filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, disabled: 'yes' })).toThrowError(ConfigError);
  });

  it('keeps the Zod detail in the message for both shapes (no union collapse)', () => {
    expect(() => filterNode.validateConfig({ column: 'age', op: 'between' })).toThrowError(/op: Invalid option/);
    expect(() => filterNode.validateConfig({ conditions: [{ column: 'age', op: 'between' }] }))
      .toThrowError(/conditions\.0\.op: Invalid option/);
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

  it('multi-condition: all valid -> confirmed, schema unchanged', () => {
    const inf = filterNode.inferSchema([schema], {
      conditions: [{ column: 'name', op: 'eq', value: 'Alice' }, { column: 'age', op: 'gte', value: 18 }],
      combine: 'or',
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema).toEqual(schema);
  });

  it('multi-condition: collects one issue per bad condition', () => {
    const inf = filterNode.inferSchema([schema], {
      conditions: [{ column: 'nope', op: 'eq', value: 1 }, { column: 'name', op: 'gt', value: 'x' }, { column: 'age', op: 'gte', value: 1 }],
      combine: 'and',
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(2);
    expect(inf.issues[0]?.column).toBe('nope');
    expect(inf.issues[1]?.message).toContain('number|date');
  });

  it('multi-condition without combine behaves like and', () => {
    expect(filterNode.inferSchema([schema], { conditions: [{ column: 'age', op: 'gte', value: 1 }] }).state).toBe('confirmed');
  });

  it('missing input is treated as an empty schema', () => {
    expect(filterNode.inferSchema([], { column: 'age', op: 'eq', value: 1 }).state).toBe('mismatch');
  });

  it('disabled conditions are inspected as if they did not exist', () => {
    // 単独（フラット）で disabled: 列が無くても mismatch にしない。
    expect(filterNode.inferSchema([schema], { column: 'nope', op: 'eq', value: 1, disabled: true }))
      .toEqual({ schema, state: 'confirmed', issues: [] });
    // conditions 形式でも disabled の条件だけ検査対象から外れる。
    const inf = filterNode.inferSchema([schema], {
      conditions: [{ column: 'nope', op: 'eq', value: 1, disabled: true }, { column: 'age', op: 'gte', value: 18 }],
      combine: 'and',
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    // 全条件が disabled でもスキーマは不変のまま confirmed。
    expect(filterNode.inferSchema([schema], {
      conditions: [{ column: 'nope', op: 'gt', value: 1, disabled: true }],
      combine: 'or',
    })).toEqual({ schema, state: 'confirmed', issues: [] });
  });

  it('disabled: false is still inspected (backward compatible with an explicit marker)', () => {
    expect(filterNode.inferSchema([schema], { column: 'nope', op: 'eq', value: 1, disabled: false }).state).toBe('mismatch');
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

  it('combine:or keeps rows matching any condition (Tokyo or Osaka)', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'name', op: 'eq', value: 'Alice' }, { column: 'name', op: 'eq', value: 'Bob' }],
      combine: 'or',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('combine:and requires every condition', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'age', op: 'gte', value: 18 }, { column: 'active', op: 'eq', value: true }],
      combine: 'and',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('conditions without combine default to and', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'age', op: 'gte', value: 18 }, { column: 'name', op: 'notNull' }],
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('a single condition behaves exactly like the legacy flat config', () => {
    const legacy = filterNode.execute([table], { column: 'age', op: 'gte', value: 18 });
    const wrapped = filterNode.execute([table], { conditions: [{ column: 'age', op: 'gte', value: 18 }], combine: 'or' });
    expect(wrapped.rows).toEqual(legacy.rows);
  });

  it('missing column in one condition simply matches nothing (null cell)', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'ghost', op: 'isNull' }, { column: 'age', op: 'gte', value: 40 }],
      combine: 'and',
    });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });

  it('missing input is treated as an empty table', () => {
    expect(filterNode.execute([], { column: 'age', op: 'gte', value: 1 })).toEqual({ schema: { columns: [] }, rows: [] });
  });

  it('a disabled flat condition passes every row through unchanged', () => {
    const out = filterNode.execute([table], { column: 'age', op: 'gte', value: 40, disabled: true });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.schema).toBe(table.schema);
    expect(out.rows).not.toBe(table.rows);
  });

  it('combine:and evaluates only the conditions that are not disabled', () => {
    const out = filterNode.execute([table], {
      conditions: [
        { column: 'name', op: 'eq', value: 'Alice', disabled: true },
        { column: 'age', op: 'gte', value: 18 },
      ],
      combine: 'and',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('combine:or evaluates only the conditions that are not disabled', () => {
    const out = filterNode.execute([table], {
      conditions: [
        { column: 'name', op: 'eq', value: 'Alice' },
        { column: 'name', op: 'eq', value: 'Bob', disabled: true },
      ],
      combine: 'or',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it.each(['and', 'or'] as const)('all conditions disabled -> pass-through (%s)', (combine) => {
    const out = filterNode.execute([table], {
      conditions: [
        { column: 'name', op: 'eq', value: 'Alice', disabled: true },
        { column: 'age', op: 'gte', value: 40, disabled: true },
      ],
      combine,
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.schema).toBe(table.schema);
  });

  it('disabled: false keeps the condition active (backward compatible)', () => {
    const out = filterNode.execute([table], { column: 'age', op: 'gte', value: 40, disabled: false });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });
});
