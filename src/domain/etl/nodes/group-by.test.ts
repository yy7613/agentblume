import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { GROUP_BY_OPS, groupByNode } from './group-by';

const schema: Schema = {
  columns: [
    { name: 'region', type: 'string', nullable: false },
    { name: 'status', type: 'string', nullable: true },
    { name: 'amount', type: 'number', nullable: true },
    { name: 'joined', type: 'date', nullable: true },
    { name: 'active', type: 'boolean', nullable: false },
  ],
};

const d = (value: string): Date => new Date(value);

const table: Table = {
  schema,
  rows: [
    { region: 'Tokyo', status: 'open', amount: 100, joined: d('2020-01-01T00:00:00Z'), active: true },
    { region: 'Osaka', status: 'open', amount: 20, joined: d('2021-06-01T00:00:00Z'), active: false },
    { region: 'Tokyo', status: 'open', amount: null, joined: null, active: true },
    { region: 'Tokyo', status: null, amount: 40, joined: d('2019-03-15T00:00:00Z'), active: true },
  ],
};

describe('group-by: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(groupByNode.type).toBe('group-by');
    expect(groupByNode.kind).toBe('analyze');
    expect(groupByNode.inputArity).toBe(1);
  });

  it('exposes the supported aggregate operations', () => {
    expect(GROUP_BY_OPS).toEqual(['count', 'count-distinct', 'sum', 'mean', 'min', 'max', 'first']);
  });
});

describe('group-by: validateConfig', () => {
  it('accepts group columns with aggregates', () => {
    expect(groupByNode.validateConfig({ groupBy: ['region'], aggregates: [{ op: 'count', as: 'rows' }] }))
      .toEqual({ groupBy: ['region'], aggregates: [{ op: 'count', as: 'rows' }] });
  });

  it('accepts every op with a column', () => {
    const aggregates = GROUP_BY_OPS.map((op) => ({ op, column: 'amount', as: op }));
    expect(groupByNode.validateConfig({ groupBy: ['region'], aggregates }).aggregates).toHaveLength(GROUP_BY_OPS.length);
  });

  it('rejects an empty groupBy', () => {
    expect(() => groupByNode.validateConfig({ groupBy: [], aggregates: [{ op: 'count', as: 'rows' }] }))
      .toThrowError(ConfigError);
  });

  it('rejects empty aggregates', () => {
    expect(() => groupByNode.validateConfig({ groupBy: ['region'], aggregates: [] })).toThrowError(ConfigError);
  });

  it('rejects an unknown op, blank column and blank as', () => {
    expect(() => groupByNode.validateConfig({ groupBy: ['region'], aggregates: [{ op: 'median', as: 'x' }] })).toThrowError(ConfigError);
    expect(() => groupByNode.validateConfig({ groupBy: ['region'], aggregates: [{ op: 'sum', column: '', as: 'x' }] })).toThrowError(ConfigError);
    expect(() => groupByNode.validateConfig({ groupBy: ['region'], aggregates: [{ op: 'count', as: '' }] })).toThrowError(ConfigError);
    expect(() => groupByNode.validateConfig({ groupBy: [''], aggregates: [{ op: 'count', as: 'x' }] })).toThrowError(ConfigError);
  });

  it('reports the node name in the message', () => {
    expect(() => groupByNode.validateConfig({})).toThrowError(/^group-by: invalid config:/);
  });
});

describe('group-by: inferSchema', () => {
  it('produces one column per group key and per aggregate (wide output)', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['region'],
      aggregates: [
        { op: 'count', as: 'rows' },
        { op: 'count-distinct', column: 'status', as: 'statuses' },
        { op: 'sum', column: 'amount', as: 'total' },
        { op: 'mean', column: 'amount', as: 'average' },
        { op: 'min', column: 'joined', as: 'firstJoined' },
        { op: 'max', column: 'region', as: 'lastRegion' },
        { op: 'first', column: 'active', as: 'firstActive' },
      ],
    });
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema.columns).toEqual([
      { name: 'region', type: 'string', nullable: false },
      { name: 'rows', type: 'number', nullable: false },
      { name: 'statuses', type: 'number', nullable: false },
      { name: 'total', type: 'number', nullable: false },
      { name: 'average', type: 'number', nullable: true },
      { name: 'firstJoined', type: 'date', nullable: true },
      { name: 'lastRegion', type: 'string', nullable: true },
      { name: 'firstActive', type: 'boolean', nullable: true },
    ]);
  });

  it('keeps the input type and nullability of group columns and dedupes repeats', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['region', 'status', 'region'],
      aggregates: [{ op: 'count', as: 'rows' }],
    });
    expect(inference.schema.columns).toEqual([
      { name: 'region', type: 'string', nullable: false },
      { name: 'status', type: 'string', nullable: true },
      { name: 'rows', type: 'number', nullable: false },
    ]);
  });

  it('reports missing group and aggregate columns in one issue', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['nope'],
      aggregates: [{ op: 'sum', column: 'missing', as: 'total' }],
    });
    expect(inference.state).toBe('mismatch');
    expect(inference.schema).toEqual(schema);
    expect(inference.issues[0]).toEqual({ severity: 'error', message: 'group-by: column(s) not found: nope, missing' });
  });

  it('requires a number column for sum and mean', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['region'],
      aggregates: [{ op: 'sum', column: 'status', as: 'total' }, { op: 'mean', column: 'status', as: 'average' }],
    });
    expect(inference.state).toBe('mismatch');
    // 同じ列は1度だけ列挙する（既存の `column(s) must be number` 形式）。
    expect(inference.issues[0]?.message).toBe('group-by: column(s) must be number: status');
  });

  it('allows number/date/string for min and max but rejects boolean', () => {
    for (const column of ['amount', 'joined', 'region']) {
      expect(groupByNode.inferSchema([schema], { groupBy: ['region'], aggregates: [{ op: 'min', column, as: 'm' }] }).state)
        .toBe('confirmed');
    }
    const inference = groupByNode.inferSchema([schema], { groupBy: ['region'], aggregates: [{ op: 'max', column: 'active', as: 'm' }] });
    expect(inference.state).toBe('mismatch');
    expect(inference.issues[0]).toEqual({
      severity: 'error',
      message: "group-by: column 'active' must be number or date or string",
      column: 'active',
    });
  });

  it('accepts any type for count-distinct and first', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['region'],
      aggregates: [{ op: 'count-distinct', column: 'active', as: 'flags' }, { op: 'first', column: 'active', as: 'flag' }],
    });
    expect(inference.state).toBe('confirmed');
  });

  it('reports a duplicate aggregate name', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['region'],
      aggregates: [{ op: 'count', as: 'rows' }, { op: 'sum', column: 'amount', as: 'rows' }],
    });
    expect(inference.state).toBe('mismatch');
    expect(inference.issues[0]).toEqual({ severity: 'error', message: 'group-by: duplicate aggregate name: rows', column: 'rows' });
  });

  it('reports an aggregate name that collides with a group column', () => {
    const inference = groupByNode.inferSchema([schema], {
      groupBy: ['region'],
      aggregates: [{ op: 'count', as: 'region' }],
    });
    expect(inference.state).toBe('mismatch');
    expect(inference.issues[0]).toEqual({
      severity: 'error',
      message: "group-by: input column 'region' conflicts with generated column",
      column: 'region',
    });
  });

  it('requires a column for every op except count', () => {
    for (const op of GROUP_BY_OPS.filter((candidate) => candidate !== 'count')) {
      const inference = groupByNode.inferSchema([schema], { groupBy: ['region'], aggregates: [{ op, as: 'value' }] });
      expect(inference.state).toBe('mismatch');
      expect(inference.issues[0]).toEqual({
        severity: 'error',
        message: `group-by: aggregate 'value' requires a column for op '${op}'`,
        column: 'value',
      });
    }
  });

  it('ignores a column given to count but still checks that it exists', () => {
    expect(groupByNode.inferSchema([schema], { groupBy: ['region'], aggregates: [{ op: 'count', column: 'amount', as: 'rows' }] }).state)
      .toBe('confirmed');
    expect(groupByNode.inferSchema([schema], { groupBy: ['region'], aggregates: [{ op: 'count', column: 'nope', as: 'rows' }] }).issues[0]?.message)
      .toBe('group-by: column(s) not found: nope');
  });

  it('treats a missing input as an empty schema', () => {
    const inference = groupByNode.inferSchema([], { groupBy: ['region'], aggregates: [{ op: 'count', as: 'rows' }] });
    expect(inference.state).toBe('mismatch');
    expect(inference.schema).toEqual({ columns: [] });
  });
});

describe('group-by: execute', () => {
  it('emits one row per group in first-seen order', () => {
    const out = groupByNode.execute([table], { groupBy: ['region'], aggregates: [{ op: 'count', as: 'rows' }] });
    expect(out.rows).toEqual([{ region: 'Tokyo', rows: 3 }, { region: 'Osaka', rows: 1 }]);
    expect(out.schema.columns.map((column) => column.name)).toEqual(['region', 'rows']);
  });

  it('groups by several columns and treats null as its own group value', () => {
    const out = groupByNode.execute([table], { groupBy: ['region', 'status'], aggregates: [{ op: 'count', as: 'rows' }] });
    expect(out.rows).toEqual([
      { region: 'Tokyo', status: 'open', rows: 2 },
      { region: 'Osaka', status: 'open', rows: 1 },
      { region: 'Tokyo', status: null, rows: 1 },
    ]);
  });

  it('sums and averages while skipping nulls', () => {
    const out = groupByNode.execute([table], {
      groupBy: ['region'],
      aggregates: [{ op: 'sum', column: 'amount', as: 'total' }, { op: 'mean', column: 'amount', as: 'average' }],
    });
    expect(out.rows[0]).toEqual({ region: 'Tokyo', total: 140, average: 70 });
    expect(out.rows[1]).toEqual({ region: 'Osaka', total: 20, average: 20 });
  });

  it('returns 0 for a sum and null for a mean when every value is null', () => {
    const nulls: Table = { schema, rows: [{ region: 'Tokyo', amount: null }, { region: 'Tokyo', amount: null }] };
    const out = groupByNode.execute([nulls], {
      groupBy: ['region'],
      aggregates: [{ op: 'sum', column: 'amount', as: 'total' }, { op: 'mean', column: 'amount', as: 'average' }],
    });
    expect(out.rows).toEqual([{ region: 'Tokyo', total: 0, average: null }]);
  });

  it('counts distinct non-null values and distinguishes types', () => {
    const mixed: Table = {
      schema,
      rows: [
        { region: 'Tokyo', status: 'open' },
        { region: 'Tokyo', status: 'open' },
        { region: 'Tokyo', status: null },
        { region: 'Tokyo', status: 'done' },
      ],
    };
    const out = groupByNode.execute([mixed], { groupBy: ['region'], aggregates: [{ op: 'count-distinct', column: 'status', as: 'statuses' }] });
    expect(out.rows).toEqual([{ region: 'Tokyo', statuses: 2 }]);

    const typed: Table = { schema, rows: [{ region: 'Tokyo', status: '1' }, { region: 'Tokyo', status: 1 }] };
    expect(groupByNode.execute([typed], { groupBy: ['region'], aggregates: [{ op: 'count-distinct', column: 'status', as: 'statuses' }] }).rows[0]?.['statuses'])
      .toBe(2);

    const dates: Table = {
      schema,
      rows: [{ region: 'Tokyo', joined: d('2020-01-01T00:00:00Z') }, { region: 'Tokyo', joined: d('2020-01-01T00:00:00Z') }],
    };
    expect(groupByNode.execute([dates], { groupBy: ['region'], aggregates: [{ op: 'count-distinct', column: 'joined', as: 'days' }] }).rows[0]?.['days'])
      .toBe(1);
  });

  it('takes min/max over numbers, dates and strings and skips nulls', () => {
    const out = groupByNode.execute([table], {
      groupBy: ['region'],
      aggregates: [
        { op: 'min', column: 'amount', as: 'least' },
        { op: 'max', column: 'amount', as: 'most' },
        { op: 'min', column: 'joined', as: 'firstJoined' },
        { op: 'max', column: 'status', as: 'lastStatus' },
      ],
    });
    expect(out.rows[0]).toEqual({
      region: 'Tokyo', least: 40, most: 100, firstJoined: d('2019-03-15T00:00:00Z'), lastStatus: 'open',
    });
  });

  it('updates min/max when a later row is smaller or larger', () => {
    const rising: Table = { schema, rows: [{ region: 'Tokyo', amount: 5 }, { region: 'Tokyo', amount: 9 }, { region: 'Tokyo', amount: 1 }] };
    const out = groupByNode.execute([rising], {
      groupBy: ['region'],
      aggregates: [{ op: 'min', column: 'amount', as: 'least' }, { op: 'max', column: 'amount', as: 'most' }],
    });
    expect(out.rows).toEqual([{ region: 'Tokyo', least: 1, most: 9 }]);
  });

  it('returns null for min/max when every value in the group is null', () => {
    const nulls: Table = { schema, rows: [{ region: 'Tokyo', amount: null }] };
    const out = groupByNode.execute([nulls], { groupBy: ['region'], aggregates: [{ op: 'min', column: 'amount', as: 'least' }] });
    expect(out.rows).toEqual([{ region: 'Tokyo', least: null }]);
  });

  it('compares mixed-type cells as text for min/max', () => {
    const mixed: Table = { schema, rows: [{ region: 'Tokyo', amount: 5 }, { region: 'Tokyo', amount: '30' }] };
    const out = groupByNode.execute([mixed], {
      groupBy: ['region'],
      aggregates: [{ op: 'min', column: 'amount', as: 'least' }, { op: 'max', column: 'amount', as: 'most' }],
    });
    // '30' < '5' の文字列比較になる。
    expect(out.rows[0]).toEqual({ region: 'Tokyo', least: '30', most: 5 });
  });

  it('takes the first row value for first, including null', () => {
    const out = groupByNode.execute([table], {
      groupBy: ['status'],
      aggregates: [{ op: 'first', column: 'amount', as: 'firstAmount' }],
    });
    expect(out.rows).toEqual([{ status: 'open', firstAmount: 100 }, { status: null, firstAmount: 40 }]);

    const leadingNull: Table = { schema, rows: [{ region: 'Tokyo', amount: null }, { region: 'Tokyo', amount: 7 }] };
    expect(groupByNode.execute([leadingNull], { groupBy: ['region'], aggregates: [{ op: 'first', column: 'amount', as: 'firstAmount' }] }).rows[0])
      .toEqual({ region: 'Tokyo', firstAmount: null });
  });

  it('treats a missing key in a row as null', () => {
    const sparse: Table = { schema, rows: [{ region: 'Tokyo' }, { region: 'Tokyo', amount: 3 }] };
    const out = groupByNode.execute([sparse], {
      groupBy: ['region'],
      aggregates: [{ op: 'count-distinct', column: 'amount', as: 'amounts' }, { op: 'sum', column: 'amount', as: 'total' }],
    });
    expect(out.rows).toEqual([{ region: 'Tokyo', amounts: 1, total: 3 }]);
  });

  it('ignores non-finite numbers in sum and mean', () => {
    const broken: Table = { schema, rows: [{ region: 'Tokyo', amount: Number.NaN }, { region: 'Tokyo', amount: 10 }] };
    const out = groupByNode.execute([broken], {
      groupBy: ['region'],
      aggregates: [{ op: 'sum', column: 'amount', as: 'total' }, { op: 'mean', column: 'amount', as: 'average' }],
    });
    expect(out.rows).toEqual([{ region: 'Tokyo', total: 10, average: 10 }]);
  });

  it('returns no rows for an empty input (schema is still produced)', () => {
    const empty: Table = { schema, rows: [] };
    const out = groupByNode.execute([empty], { groupBy: ['region'], aggregates: [{ op: 'count', as: 'rows' }] });
    expect(out.rows).toEqual([]);
    expect(out.schema.columns.map((column) => column.name)).toEqual(['region', 'rows']);
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows);
    groupByNode.execute([table], { groupBy: ['region'], aggregates: [{ op: 'sum', column: 'amount', as: 'total' }] });
    expect(JSON.stringify(table.rows)).toBe(snapshot);
  });

  it('defends against invalid configs at run time', () => {
    expect(() => groupByNode.execute([table], { groupBy: ['nope'], aggregates: [{ op: 'count', as: 'rows' }] }))
      .toThrowError(SchemaError);
    expect(() => groupByNode.execute([table], { groupBy: ['region'], aggregates: [{ op: 'sum', column: 'status', as: 'total' }] }))
      .toThrowError('group-by: column(s) must be number: status');
    expect(() => groupByNode.execute([table], { groupBy: ['region'], aggregates: [{ op: 'sum', as: 'total' }] }))
      .toThrowError("group-by: aggregate 'total' requires a column for op 'sum'");
    expect(() => groupByNode.execute([table], { groupBy: ['region'], aggregates: [{ op: 'count', as: 'region' }] }))
      .toThrowError("group-by: input column 'region' conflicts with generated column");
  });

  it('treats a missing input as an empty table', () => {
    expect(() => groupByNode.execute([], { groupBy: ['region'], aggregates: [{ op: 'count', as: 'rows' }] }))
      .toThrowError('group-by: column(s) not found: region');
  });
});
