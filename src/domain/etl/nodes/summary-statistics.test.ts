/**
 * `summary-statistics` の遅延 metric 評価・大規模入力・予約列衝突の回帰テスト。
 * 基本的な長形式出力の検証は analysis-nodes.test.ts が担う。
 */
import { describe, expect, it } from 'vitest';
import type { Row, Schema, Table } from '../../data/types';
import { SchemaError } from '../errors';
import { summaryStatisticsNode } from './summary-statistics';

const schema: Schema = {
  columns: [
    { name: 'group', type: 'string', nullable: false },
    { name: 'x', type: 'number', nullable: true },
  ],
};

const table: Table = {
  schema,
  rows: [
    { group: 'A', x: 1 },
    { group: 'A', x: 2 },
    { group: 'A', x: 3 },
    { group: 'A', x: 4 },
    { group: 'A', x: null },
  ],
};

const config = (patch: Partial<Parameters<typeof summaryStatisticsNode.execute>[1]> = {}) =>
  summaryStatisticsNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: ['group'], metrics: ['mean'], variance: 'sample', ...patch });

describe('summary-statistics: selected metrics only', () => {
  it('emits exactly the generated columns for the selected metrics', () => {
    const output = summaryStatisticsNode.execute([table], config({ metrics: ['sum'] }));
    expect(Object.keys(output.rows[0]!)).toEqual(['group', 'column', 'rowCount', 'sum']);
    expect(output.schema.columns.map((column) => column.name)).toEqual(['group', 'column', 'rowCount', 'sum']);
  });

  it('does not evaluate unselected metrics', () => {
    const output = summaryStatisticsNode.execute([table], config({ metrics: ['min'] }));
    expect(output.rows[0]).toEqual({ group: 'A', column: 'x', rowCount: 5, min: 1 });
    expect(output.rows[0]).not.toHaveProperty('max');
    expect(output.rows[0]).not.toHaveProperty('median');
  });

  it('keeps the metric order of the config', () => {
    const output = summaryStatisticsNode.execute([table], config({ metrics: ['max', 'min', 'mean'] }));
    expect(Object.keys(output.rows[0]!)).toEqual(['group', 'column', 'rowCount', 'max', 'min', 'mean']);
  });

  it('computes every metric with the documented values', () => {
    const output = summaryStatisticsNode.execute([table], config({ metrics: ['valid-count', 'missing-count', 'unique-count', 'sum', 'mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max'] }));
    expect(output.rows[0]).toEqual({
      group: 'A', column: 'x', rowCount: 5,
      'valid-count': 4, 'missing-count': 1, 'unique-count': 4,
      sum: 10, mean: 2.5, stddev: expect.closeTo(Math.sqrt(5 / 3), 12),
      min: 1, q1: 1.75, median: 2.5, q3: 3.25, max: 4,
    });
  });

  it('uses the population divisor when configured', () => {
    const output = summaryStatisticsNode.execute([table], config({ metrics: ['stddev'], variance: 'population' }));
    expect(output.rows[0]?.stddev).toBeCloseTo(Math.sqrt(1.25), 12);
  });

  it('returns null for statistical metrics of an empty group', () => {
    const output = summaryStatisticsNode.execute([{ schema, rows: [] }], summaryStatisticsNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: [], metrics: ['min', 'max', 'q1', 'median', 'q3', 'mean', 'stddev', 'valid-count', 'missing-count', 'unique-count', 'sum'], variance: 'sample' }));
    expect(output.rows[0]).toEqual({
      column: 'x', rowCount: 0,
      min: null, max: null, q1: null, median: null, q3: null, mean: null, stddev: null,
      'valid-count': 0, 'missing-count': 0, 'unique-count': 0, sum: 0,
    });
  });

  it('keeps min/max of a single value group', () => {
    const output = summaryStatisticsNode.execute([{ schema, rows: [{ group: 'A', x: 7 }] }], config({ metrics: ['min', 'max'] }));
    expect(output.rows[0]).toEqual({ group: 'A', column: 'x', rowCount: 1, min: 7, max: 7 });
  });

  it('finds min/max regardless of the value order', () => {
    const unordered: Row[] = [{ group: 'A', x: 3 }, { group: 'A', x: 1 }, { group: 'A', x: 4 }, { group: 'A', x: 2 }];
    const output = summaryStatisticsNode.execute([{ schema, rows: unordered }], config({ metrics: ['min', 'max', 'median'] }));
    expect(output.rows[0]).toEqual({ group: 'A', column: 'x', rowCount: 4, min: 1, max: 4, median: 2.5 });
  });

  it('treats non-finite numbers as missing', () => {
    const output = summaryStatisticsNode.execute([{ schema, rows: [{ group: 'A', x: Number.NaN }, { group: 'A', x: 5 }] }], config({ metrics: ['valid-count', 'missing-count', 'min', 'max'] }));
    expect(output.rows[0]).toEqual({ group: 'A', column: 'x', rowCount: 2, 'valid-count': 1, 'missing-count': 1, min: 5, max: 5 });
  });
});

describe('summary-statistics: large inputs', () => {
  const rowCount = 200_000;
  const rows: Row[] = Array.from({ length: rowCount }, (_, index) => ({ group: 'A', x: index }));

  it(`computes min/max/median over ${rowCount} rows without a stack overflow`, () => {
    const output = summaryStatisticsNode.execute([{ schema, rows }], config({ metrics: ['valid-count', 'min', 'max', 'sum', 'median'] }));
    expect(output.rows[0]).toEqual({
      group: 'A', column: 'x', rowCount,
      'valid-count': rowCount, min: 0, max: rowCount - 1,
      sum: (rowCount * (rowCount - 1)) / 2, median: (rowCount - 1) / 2,
    });
  }, 30_000);
});

describe('summary-statistics: reserved column conflicts', () => {
  const withColumnName: Schema = {
    columns: [
      { name: 'column', type: 'string', nullable: false },
      { name: 'x', type: 'number', nullable: true },
    ],
  };

  it('reports an error issue when a group column collides with a generated column', () => {
    const inference = summaryStatisticsNode.inferSchema([withColumnName], config({ groupBy: ['column'], metrics: ['sum'] }));
    expect(inference.state).toBe('mismatch');
    expect(inference.issues).toEqual([
      { severity: 'error', message: "summary-statistics: input column 'column' conflicts with generated column", column: 'column' },
    ]);
  });

  it('detects rowCount and metric name collisions too', () => {
    for (const name of ['rowCount', 'sum']) {
      const input: Schema = { columns: [{ name, type: 'number', nullable: false }, { name: 'x', type: 'number', nullable: true }] };
      const inference = summaryStatisticsNode.inferSchema([input], config({ groupBy: [name], metrics: ['sum'] }));
      expect(inference.issues).toEqual([
        { severity: 'error', message: `summary-statistics: input column '${name}' conflicts with generated column`, column: name },
      ]);
    }
  });

  it('throws SchemaError from execute instead of silently overwriting the group value', () => {
    const input: Table = { schema: withColumnName, rows: [{ column: 'kept', x: 1 }] };
    expect(() => summaryStatisticsNode.execute([input], config({ groupBy: ['column'], metrics: ['sum'] }))).toThrowError(SchemaError);
    expect(() => summaryStatisticsNode.execute([input], config({ groupBy: ['column'], metrics: ['sum'] }))).toThrowError(
      "summary-statistics: input column 'column' conflicts with generated column",
    );
  });

  it('accepts a group column whose name only collides with an unselected metric', () => {
    const input: Schema = { columns: [{ name: 'sum', type: 'string', nullable: false }, { name: 'x', type: 'number', nullable: true }] };
    const inference = summaryStatisticsNode.inferSchema([input], config({ groupBy: ['sum'], metrics: ['mean'] }));
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
  });

  it('does not flag input columns that never reach the output', () => {
    const input: Schema = {
      columns: [
        { name: 'group', type: 'string', nullable: false },
        { name: 'column', type: 'string', nullable: false },
        { name: 'rowCount', type: 'number', nullable: false },
        { name: 'x', type: 'number', nullable: true },
      ],
    };
    const inference = summaryStatisticsNode.inferSchema([input], config({ groupBy: ['group'], metrics: ['mean'] }));
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
  });

  it('reports only the missing column when a reserved group column does not exist', () => {
    const inference = summaryStatisticsNode.inferSchema([schema], config({ groupBy: ['rowCount'], metrics: ['sum'] }));
    expect(inference.issues).toEqual([
      { severity: 'error', message: 'summary-statistics: column not found: rowCount', column: 'rowCount' },
    ]);
  });
});
