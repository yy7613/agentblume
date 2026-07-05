import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { joinNode } from './join';

const leftSchema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'deptId', type: 'string', nullable: true },
  ],
};

const rightSchema: Schema = {
  columns: [
    { name: 'code', type: 'string', nullable: false },
    { name: 'deptName', type: 'string', nullable: false },
  ],
};

const leftTable: Table = {
  schema: leftSchema,
  rows: [
    { id: 1, name: 'Alice', deptId: 'eng' },
    { id: 2, name: 'Bob', deptId: null },
    { id: 3, name: 'Carol', deptId: 'hr' },
    { id: 4, name: 'Dave', deptId: 'sales' },
  ],
};

const rightTable: Table = {
  schema: rightSchema,
  rows: [
    { code: 'eng', deptName: 'Engineering' },
    { code: 'hr', deptName: 'HR' },
    { code: 'fin', deptName: 'Finance' },
  ],
};

const keys = [{ left: 'deptId', right: 'code' }];

describe('join: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(joinNode.type).toBe('join');
    expect(joinNode.kind).toBe('transform');
    expect(joinNode.inputArity).toBe(2);
  });
});

describe('join: validateConfig', () => {
  it('accepts a valid config and keeps rightSuffix optional', () => {
    const config = joinNode.validateConfig({ mode: 'inner', keys });
    expect(config.mode).toBe('inner');
    expect(config.keys).toEqual(keys);
    expect(config.rightSuffix).toBeUndefined();
  });

  it('accepts an explicit rightSuffix', () => {
    const config = joinNode.validateConfig({ mode: 'left', keys, rightSuffix: '_r' });
    expect(config.rightSuffix).toBe('_r');
  });

  it('throws ConfigError for an unknown mode', () => {
    expect(() => joinNode.validateConfig({ mode: 'cross', keys })).toThrowError(ConfigError);
  });

  it('throws ConfigError when keys is empty', () => {
    expect(() => joinNode.validateConfig({ mode: 'inner', keys: [] })).toThrowError(ConfigError);
  });

  it('throws ConfigError when a key pair is malformed', () => {
    expect(() =>
      joinNode.validateConfig({ mode: 'inner', keys: [{ left: 'a' }] }),
    ).toThrowError(ConfigError);
  });
});

describe('join: inferSchema', () => {
  it('normal case -> left columns + right non-key columns, confirmed', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'inner', keys });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    // 右のキー列 code は出力から除かれる。
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'deptId', 'deptName']);
  });

  it('inner join keeps original nullable on both sides', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'inner', keys });
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(false);
    expect(byName.get('deptName')?.nullable).toBe(false);
  });

  it('left join makes right-derived columns nullable', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'left', keys });
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(false);
    expect(byName.get('deptName')?.nullable).toBe(true);
  });

  it('right join makes left-derived columns nullable', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'right', keys });
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(true);
    expect(byName.get('name')?.nullable).toBe(true);
    expect(byName.get('deptName')?.nullable).toBe(false);
  });

  it('full join makes both sides nullable', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'full', keys });
    for (const c of inf.schema.columns) {
      expect(c.nullable).toBe(true);
    }
  });

  it('missing left key column -> error issue with column, mismatch', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], {
      mode: 'inner',
      keys: [{ left: 'nope', right: 'code' }],
    });
    expect(inf.state).toBe('mismatch');
    const errors = inf.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('nope');
  });

  it('missing right key column -> error issue with column, mismatch', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], {
      mode: 'inner',
      keys: [{ left: 'deptId', right: 'nope' }],
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('key type mismatch -> error + mismatch', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], {
      mode: 'inner',
      keys: [{ left: 'id', right: 'code' }], // number vs string
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('key type mismatch with unknown side -> warning only, confirmed', () => {
    const unknownRight: Schema = {
      columns: [{ name: 'code', type: 'unknown', nullable: true }],
    };
    const inf = joinNode.inferSchema([leftSchema, unknownRight], {
      mode: 'inner',
      keys: [{ left: 'deptId', right: 'code' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('warning');
  });

  it('colliding right column gets the default suffix _right', () => {
    const rightWithName: Schema = {
      columns: [
        { name: 'code', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    };
    const inf = joinNode.inferSchema([leftSchema, rightWithName], { mode: 'inner', keys });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'deptId', 'name_right']);
  });

  it('collision remaining after suffix -> error + mismatch', () => {
    const leftWithSuffixed: Schema = {
      columns: [
        { name: 'name', type: 'string', nullable: false },
        { name: 'name_right', type: 'string', nullable: false },
        { name: 'deptId', type: 'string', nullable: true },
      ],
    };
    const rightWithName: Schema = {
      columns: [
        { name: 'code', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    };
    const inf = joinNode.inferSchema([leftWithSuffixed, rightWithName], { mode: 'inner', keys });
    expect(inf.state).toBe('mismatch');
    const errors = inf.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('name');
  });

  it('missing input schemas -> everything missing, mismatch', () => {
    const inf = joinNode.inferSchema([], { mode: 'inner', keys });
    expect(inf.state).toBe('mismatch');
  });
});

describe('join: execute', () => {
  it('inner join keeps only matched pairs (null keys never match)', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'inner', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
    ]);
  });

  it('left join keeps unmatched left rows with null-filled right columns', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'left', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 2, name: 'Bob', deptId: null, deptName: null },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
      { id: 4, name: 'Dave', deptId: 'sales', deptName: null },
    ]);
  });

  it('right join appends unmatched right rows with null-filled left columns', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'right', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
      { id: null, name: null, deptId: null, deptName: 'Finance' },
    ]);
  });

  it('full join outputs matched, unmatched-left, then unmatched-right rows', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'full', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 2, name: 'Bob', deptId: null, deptName: null },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
      { id: 4, name: 'Dave', deptId: 'sales', deptName: null },
      { id: null, name: null, deptId: null, deptName: 'Finance' },
    ]);
  });

  it('multiple matches produce the cartesian product in right row order', () => {
    const right: Table = {
      schema: rightSchema,
      rows: [
        { code: 'eng', deptName: 'Engineering-1' },
        { code: 'eng', deptName: 'Engineering-2' },
      ],
    };
    const left: Table = {
      schema: leftSchema,
      rows: [{ id: 1, name: 'Alice', deptId: 'eng' }],
    };
    const out = joinNode.execute([left, right], { mode: 'inner', keys });
    expect(out.rows.map((r) => r['deptName'])).toEqual(['Engineering-1', 'Engineering-2']);
  });

  it('null keys stay unmatched even when both sides are null', () => {
    const left: Table = {
      schema: leftSchema,
      rows: [{ id: 1, name: 'Alice', deptId: null }],
    };
    const right: Table = {
      schema: rightSchema,
      rows: [{ code: null, deptName: 'Nowhere' }],
    };
    // inner: null 同士でもマッチしない → 0 行。
    expect(joinNode.execute([left, right], { mode: 'inner', keys }).rows).toEqual([]);
    // full: 両方が無マッチ行として残る。
    const full = joinNode.execute([left, right], { mode: 'full', keys });
    expect(full.rows).toEqual([
      { id: 1, name: 'Alice', deptId: null, deptName: null },
      { id: null, name: null, deptId: null, deptName: 'Nowhere' },
    ]);
  });

  it('supports composite keys and Date key equality by time value', () => {
    const left: Table = {
      schema: {
        columns: [
          { name: 'day', type: 'date', nullable: false },
          { name: 'code', type: 'string', nullable: false },
        ],
      },
      rows: [
        { day: new Date('2026-01-01T00:00:00Z'), code: 'a' },
        { day: new Date('2026-01-02T00:00:00Z'), code: 'a' },
      ],
    };
    const right: Table = {
      schema: {
        columns: [
          { name: 'day', type: 'date', nullable: false },
          { name: 'code', type: 'string', nullable: false },
          { name: 'value', type: 'number', nullable: false },
        ],
      },
      rows: [{ day: new Date('2026-01-01T00:00:00Z'), code: 'a', value: 10 }],
    };
    const out = joinNode.execute([left, right], {
      mode: 'inner',
      keys: [
        { left: 'day', right: 'day' },
        { left: 'code', right: 'code' },
      ],
    });
    expect(out.rows).toEqual([{ day: new Date('2026-01-01T00:00:00Z'), code: 'a', value: 10 }]);
  });

  it('applies rightSuffix to colliding right columns in rows', () => {
    const right: Table = {
      schema: {
        columns: [
          { name: 'code', type: 'string', nullable: false },
          { name: 'name', type: 'string', nullable: false },
        ],
      },
      rows: [{ code: 'eng', deptName: 'x', name: 'Engineering' }],
    };
    const out = joinNode.execute([leftTable, right], { mode: 'inner', keys });
    expect(out.rows[0]).toEqual({ id: 1, name: 'Alice', deptId: 'eng', name_right: 'Engineering' });
  });

  it('throws SchemaError when a key column is missing', () => {
    expect(() =>
      joinNode.execute([leftTable, rightTable], {
        mode: 'inner',
        keys: [{ left: 'missing', right: 'code' }],
      }),
    ).toThrowError(SchemaError);
  });

  it('throws SchemaError when suffix cannot resolve a collision', () => {
    const left: Table = {
      schema: {
        columns: [
          { name: 'name', type: 'string', nullable: false },
          { name: 'name_right', type: 'string', nullable: false },
          { name: 'deptId', type: 'string', nullable: true },
        ],
      },
      rows: [],
    };
    const right: Table = {
      schema: {
        columns: [
          { name: 'code', type: 'string', nullable: false },
          { name: 'name', type: 'string', nullable: false },
        ],
      },
      rows: [],
    };
    expect(() => joinNode.execute([left, right], { mode: 'inner', keys })).toThrowError(SchemaError);
  });

  it('does not mutate the input tables', () => {
    const leftSnapshot = JSON.stringify(leftTable.rows);
    const rightSnapshot = JSON.stringify(rightTable.rows);
    joinNode.execute([leftTable, rightTable], { mode: 'full', keys });
    expect(JSON.stringify(leftTable.rows)).toBe(leftSnapshot);
    expect(JSON.stringify(rightTable.rows)).toBe(rightSnapshot);
  });
});
