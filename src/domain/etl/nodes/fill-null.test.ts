import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { fillNullNode } from './fill-null';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: true },
    { name: 'age', type: 'number', nullable: true },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Alice', age: 30 },
    { id: 2, name: null, age: null },
    { id: 3, name: 'Carol', age: null },
  ],
};

describe('fill-null: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(fillNullNode.type).toBe('fill-null');
    expect(fillNullNode.kind).toBe('transform');
    expect(fillNullNode.inputArity).toBe(1);
  });
});

describe('fill-null: validateConfig', () => {
  it('accepts a constant rule with a value', () => {
    const config = fillNullNode.validateConfig({
      rules: [{ column: 'name', strategy: 'constant', value: 'N/A' }],
    });
    expect(config.rules).toHaveLength(1);
  });

  it('accepts a drop-row rule without a value', () => {
    const config = fillNullNode.validateConfig({
      rules: [{ column: 'age', strategy: 'drop-row' }],
    });
    expect(config.rules[0]?.strategy).toBe('drop-row');
  });

  it('throws ConfigError when rules is empty', () => {
    expect(() => fillNullNode.validateConfig({ rules: [] })).toThrowError(ConfigError);
  });

  it("throws ConfigError when strategy 'constant' has no value", () => {
    expect(() =>
      fillNullNode.validateConfig({ rules: [{ column: 'name', strategy: 'constant' }] }),
    ).toThrowError(ConfigError);
  });

  it("throws ConfigError when strategy 'constant' has value null", () => {
    expect(() =>
      fillNullNode.validateConfig({
        rules: [{ column: 'name', strategy: 'constant', value: null }],
      }),
    ).toThrowError(ConfigError);
  });

  it('throws ConfigError for an unknown strategy', () => {
    expect(() =>
      fillNullNode.validateConfig({ rules: [{ column: 'name', strategy: 'interpolate' }] }),
    ).toThrowError(ConfigError);
  });
});

describe('fill-null: inferSchema', () => {
  it('constant rule -> column becomes nullable:false, confirmed', () => {
    const inf = fillNullNode.inferSchema([schema], {
      rules: [{ column: 'name', strategy: 'constant', value: 'N/A' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema.columns.find((c) => c.name === 'name')).toEqual({
      name: 'name',
      type: 'string',
      nullable: false,
    });
    // 他列は不変。
    expect(inf.schema.columns.find((c) => c.name === 'age')?.nullable).toBe(true);
  });

  it('drop-row rule -> column becomes nullable:false, type unchanged', () => {
    const inf = fillNullNode.inferSchema([schema], {
      rules: [{ column: 'age', strategy: 'drop-row' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema.columns.find((c) => c.name === 'age')).toEqual({
      name: 'age',
      type: 'number',
      nullable: false,
    });
  });

  it('constant value type differing from column type -> warning + unified type', () => {
    const inf = fillNullNode.inferSchema([schema], {
      rules: [{ column: 'age', strategy: 'constant', value: 'unknown-age' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('warning');
    expect(inf.issues[0]?.column).toBe('age');
    // unifyTypes(number, string) = unknown。
    expect(inf.schema.columns.find((c) => c.name === 'age')?.type).toBe('unknown');
  });

  it('unknown-typed column accepts any constant without warning', () => {
    const unknownSchema: Schema = {
      columns: [{ name: 'v', type: 'unknown', nullable: true }],
    };
    const inf = fillNullNode.inferSchema([unknownSchema], {
      rules: [{ column: 'v', strategy: 'constant', value: 0 }],
    });
    expect(inf.issues).toEqual([]);
    expect(inf.schema.columns[0]?.nullable).toBe(false);
  });

  it('missing column -> error issue with column, mismatch', () => {
    const inf = fillNullNode.inferSchema([schema], {
      rules: [{ column: 'nope', strategy: 'drop-row' }],
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });
});

describe('fill-null: execute', () => {
  it('constant: replaces nulls in the column with the value', () => {
    const out = fillNullNode.execute([table], {
      rules: [{ column: 'name', strategy: 'constant', value: 'N/A' }],
    });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', age: 30 },
      { id: 2, name: 'N/A', age: null },
      { id: 3, name: 'Carol', age: null },
    ]);
    expect(out.schema.columns.find((c) => c.name === 'name')?.nullable).toBe(false);
  });

  it('drop-row: removes rows where the column is null', () => {
    const out = fillNullNode.execute([table], {
      rules: [{ column: 'age', strategy: 'drop-row' }],
    });
    expect(out.rows).toEqual([{ id: 1, name: 'Alice', age: 30 }]);
  });

  it('applies rules in order (fill name, then drop rows with null age)', () => {
    const out = fillNullNode.execute([table], {
      rules: [
        { column: 'name', strategy: 'constant', value: 'N/A' },
        { column: 'age', strategy: 'drop-row' },
      ],
    });
    expect(out.rows).toEqual([{ id: 1, name: 'Alice', age: 30 }]);
  });

  it('non-null cells are left untouched by constant', () => {
    const out = fillNullNode.execute([table], {
      rules: [{ column: 'age', strategy: 'constant', value: 0 }],
    });
    expect(out.rows.map((r) => r['age'])).toEqual([30, 0, 0]);
  });

  it('throws SchemaError when a rule column is missing', () => {
    expect(() =>
      fillNullNode.execute([table], { rules: [{ column: 'missing', strategy: 'drop-row' }] }),
    ).toThrowError(SchemaError);
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows);
    fillNullNode.execute([table], {
      rules: [
        { column: 'name', strategy: 'constant', value: 'N/A' },
        { column: 'age', strategy: 'drop-row' },
      ],
    });
    expect(JSON.stringify(table.rows)).toBe(snapshot);
  });
});
