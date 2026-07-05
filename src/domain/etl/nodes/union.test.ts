import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { unionNode } from './union';

const schemaA: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: false },
  ],
};

const schemaB: Schema = {
  columns: [
    { name: 'name', type: 'string', nullable: false },
    { name: 'score', type: 'number', nullable: false },
  ],
};

const tableA: Table = {
  schema: schemaA,
  rows: [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
  ],
};

const tableB: Table = {
  schema: schemaB,
  rows: [{ name: 'Carol', score: 80 }],
};

describe('union: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(unionNode.type).toBe('union');
    expect(unionNode.kind).toBe('transform');
    expect(unionNode.inputArity).toBe(2);
  });
});

describe('union: validateConfig', () => {
  it('accepts empty config (strict defaults to false)', () => {
    expect(unionNode.validateConfig({}).strict).toBeUndefined();
  });

  it('accepts strict:true', () => {
    expect(unionNode.validateConfig({ strict: true }).strict).toBe(true);
  });

  it('throws ConfigError when strict is not a boolean', () => {
    expect(() => unionNode.validateConfig({ strict: 'yes' })).toThrowError(ConfigError);
  });
});

describe('union: inferSchema', () => {
  it('non-strict: left column order, right-only columns appended in first-appearance order', () => {
    const inf = unionNode.inferSchema([schemaA, schemaB], {});
    expect(inf.state).toBe('confirmed');
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'score']);
  });

  it('non-strict: one-sided columns become nullable, common columns keep nullability', () => {
    const inf = unionNode.inferSchema([schemaA, schemaB], {});
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(true);
    expect(byName.get('score')?.nullable).toBe(true);
    expect(byName.get('name')?.nullable).toBe(false);
  });

  it('common column with differing types -> unifyTypes(unknown) + warning', () => {
    const other: Schema = {
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    };
    const inf = unionNode.inferSchema([schemaA, other], {});
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('warning');
    expect(inf.issues[0]?.column).toBe('id');
    expect(inf.schema.columns.find((c) => c.name === 'id')?.type).toBe('unknown');
  });

  it('strict: identical column sets (order may differ) -> confirmed, left order', () => {
    const reordered: Schema = {
      columns: [
        { name: 'name', type: 'string', nullable: true },
        { name: 'id', type: 'number', nullable: false },
      ],
    };
    const inf = unionNode.inferSchema([schemaA, reordered], { strict: true });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name']);
    // nullable は両者の OR。
    expect(inf.schema.columns.find((c) => c.name === 'name')?.nullable).toBe(true);
  });

  it('strict: differing column sets -> error per column + mismatch', () => {
    const inf = unionNode.inferSchema([schemaA, schemaB], { strict: true });
    expect(inf.state).toBe('mismatch');
    const errors = inf.issues.filter((i) => i.severity === 'error');
    // id は input0 のみ、score は input1 のみ。
    expect(errors.map((i) => i.column).sort()).toEqual(['id', 'score']);
    // 列は左（input0）に合わせる。
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name']);
  });

  it('missing input schemas -> confirmed with empty columns', () => {
    const inf = unionNode.inferSchema([], {});
    expect(inf.schema.columns).toEqual([]);
  });
});

describe('union: execute', () => {
  it('outputs input0 rows then input1 rows, null-filling missing columns', () => {
    const out = unionNode.execute([tableA, tableB], {});
    expect(out.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'score']);
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', score: null },
      { id: 2, name: 'Bob', score: null },
      { id: null, name: 'Carol', score: 80 },
    ]);
  });

  it('does not deduplicate rows', () => {
    const dup: Table = { schema: schemaA, rows: [{ id: 1, name: 'Alice' }] };
    const out = unionNode.execute([dup, dup], {});
    expect(out.rows).toHaveLength(2);
  });

  it('strict: throws SchemaError when column sets differ', () => {
    expect(() => unionNode.execute([tableA, tableB], { strict: true })).toThrowError(SchemaError);
  });

  it('strict: identical column sets pass and keep left order', () => {
    const reordered: Table = {
      schema: {
        columns: [
          { name: 'name', type: 'string', nullable: false },
          { name: 'id', type: 'number', nullable: false },
        ],
      },
      rows: [{ name: 'Carol', id: 3 }],
    };
    const out = unionNode.execute([tableA, reordered], { strict: true });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' },
    ]);
  });

  it('does not mutate the input tables', () => {
    const aSnapshot = JSON.stringify(tableA.rows);
    const bSnapshot = JSON.stringify(tableB.rows);
    unionNode.execute([tableA, tableB], {});
    expect(JSON.stringify(tableA.rows)).toBe(aSnapshot);
    expect(JSON.stringify(tableB.rows)).toBe(bSnapshot);
  });
});
