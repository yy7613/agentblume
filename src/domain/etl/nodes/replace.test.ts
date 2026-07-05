import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { replaceNode } from './replace';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'status', type: 'string', nullable: true },
    { name: 'joined', type: 'date', nullable: false },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, status: 'active', joined: new Date('2020-01-01T00:00:00Z') },
    { id: 2, status: 'inactive', joined: new Date('2021-06-01T00:00:00Z') },
    { id: 3, status: null, joined: new Date('2020-01-01T00:00:00Z') },
  ],
};

describe('replace: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(replaceNode.type).toBe('replace');
    expect(replaceNode.kind).toBe('transform');
    expect(replaceNode.inputArity).toBe(1);
  });
});

describe('replace: validateConfig', () => {
  it('accepts rules with from/to cells (null allowed)', () => {
    const config = replaceNode.validateConfig({
      rules: [{ column: 'status', from: null, to: 'unknown' }],
    });
    expect(config.rules[0]?.from).toBeNull();
  });

  it('throws ConfigError when rules is empty', () => {
    expect(() => replaceNode.validateConfig({ rules: [] })).toThrowError(ConfigError);
  });

  it('throws ConfigError when from is missing', () => {
    expect(() =>
      replaceNode.validateConfig({ rules: [{ column: 'status', to: 'x' }] }),
    ).toThrowError(ConfigError);
  });

  it('throws ConfigError when to is not a valid cell', () => {
    expect(() =>
      replaceNode.validateConfig({ rules: [{ column: 'status', from: 'a', to: { nested: 1 } }] }),
    ).toThrowError(ConfigError);
  });
});

describe('replace: inferSchema', () => {
  it('same-type replacement -> schema unchanged, confirmed, no issues', () => {
    const inf = replaceNode.inferSchema([schema], {
      rules: [{ column: 'status', from: 'active', to: 'enabled' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema.columns).toEqual(schema.columns);
  });

  it("differing 'to' type -> unifyTypes + warning, nullable kept", () => {
    const inf = replaceNode.inferSchema([schema], {
      rules: [{ column: 'status', from: 'inactive', to: 0 }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('warning');
    expect(inf.issues[0]?.column).toBe('status');
    const status = inf.schema.columns.find((c) => c.name === 'status');
    // unifyTypes(string, number) = unknown、nullable は維持。
    expect(status?.type).toBe('unknown');
    expect(status?.nullable).toBe(true);
  });

  it('from:null -> to:x is allowed and keeps nullable as-is', () => {
    const inf = replaceNode.inferSchema([schema], {
      rules: [{ column: 'status', from: null, to: 'unknown' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    // null 置換でも nullable は維持（fill-null の責務と分ける）。
    expect(inf.schema.columns.find((c) => c.name === 'status')?.nullable).toBe(true);
  });

  it('missing column -> error issue with column, mismatch', () => {
    const inf = replaceNode.inferSchema([schema], {
      rules: [{ column: 'nope', from: 'a', to: 'b' }],
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });
});

describe('replace: execute', () => {
  it('replaces strictly equal cells only', () => {
    const out = replaceNode.execute([table], {
      rules: [{ column: 'status', from: 'active', to: 'enabled' }],
    });
    // 'inactive' は 'active' と厳密等価ではないので置換されない。
    expect(out.rows.map((r) => r['status'])).toEqual(['enabled', 'inactive', null]);
  });

  it('replaces null cells when from is null', () => {
    const out = replaceNode.execute([table], {
      rules: [{ column: 'status', from: null, to: 'unknown' }],
    });
    expect(out.rows.map((r) => r['status'])).toEqual(['active', 'inactive', 'unknown']);
  });

  it('compares Date cells by time value', () => {
    const out = replaceNode.execute([table], {
      rules: [
        {
          column: 'joined',
          from: new Date('2020-01-01T00:00:00Z'),
          to: new Date('2020-12-31T00:00:00Z'),
        },
      ],
    });
    expect(out.rows.map((r) => (r['joined'] as Date).toISOString())).toEqual([
      '2020-12-31T00:00:00.000Z',
      '2021-06-01T00:00:00.000Z',
      '2020-12-31T00:00:00.000Z',
    ]);
  });

  it('does not treat a number and its string form as equal', () => {
    const t: Table = {
      schema: { columns: [{ name: 'v', type: 'unknown', nullable: false }] },
      rows: [{ v: 1 }, { v: '1' }],
    };
    const out = replaceNode.execute([t], {
      rules: [{ column: 'v', from: 1, to: 100 }],
    });
    expect(out.rows).toEqual([{ v: 100 }, { v: '1' }]);
  });

  it('applies rules in order (chained replacement)', () => {
    const out = replaceNode.execute([table], {
      rules: [
        { column: 'status', from: 'active', to: 'enabled' },
        { column: 'status', from: 'enabled', to: 'on' },
      ],
    });
    expect(out.rows.map((r) => r['status'])).toEqual(['on', 'inactive', null]);
  });

  it("changes the value type when 'to' has a different type", () => {
    const out = replaceNode.execute([table], {
      rules: [{ column: 'status', from: 'inactive', to: 0 }],
    });
    expect(out.rows.map((r) => r['status'])).toEqual(['active', 0, null]);
    expect(out.schema.columns.find((c) => c.name === 'status')?.type).toBe('unknown');
  });

  it('throws SchemaError when a rule column is missing', () => {
    expect(() =>
      replaceNode.execute([table], { rules: [{ column: 'missing', from: 'a', to: 'b' }] }),
    ).toThrowError(SchemaError);
  });

  it('does not mutate the input rows', () => {
    const snapshot = table.rows.map((r) => ({ ...r }));
    replaceNode.execute([table], {
      rules: [{ column: 'status', from: 'active', to: 'enabled' }],
    });
    expect(table.rows).toEqual(snapshot);
    expect(table.rows[0]?.['status']).toBe('active');
  });
});
