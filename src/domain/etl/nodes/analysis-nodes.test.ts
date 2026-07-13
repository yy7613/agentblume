import { describe, expect, it } from 'vitest';
import { correlationAnalysisNode } from './correlation-analysis';
import { outlierFilterNode } from './outlier-filter';
import { summaryStatisticsNode } from './summary-statistics';
import { timeSeriesAnalysisNode } from './time-series-analysis';

const table = {
  schema: { columns: [{ name: 'group', type: 'string' as const, nullable: false }, { name: 'x', type: 'number' as const, nullable: true }, { name: 'y', type: 'number' as const, nullable: true }, { name: 'at', type: 'date' as const, nullable: false }] },
  rows: [
    { group: 'A', x: 1, y: 2, at: new Date('2026-01-01T12:00:00Z') },
    { group: 'A', x: 2, y: 4, at: new Date('2026-01-02T12:00:00Z') },
    { group: 'A', x: 3, y: 6, at: new Date('2026-01-03T12:00:00Z') },
    { group: 'B', x: 100, y: 8, at: new Date('2026-01-03T13:00:00Z') },
  ],
};

describe('analysis nodes', () => {
  it('calculates grouped statistics in a stable long form', () => {
    const config = summaryStatisticsNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: ['group'], metrics: ['valid-count', 'mean', 'q1', 'median', 'q3'], variance: 'sample' });
    const output = summaryStatisticsNode.execute([table], config);
    expect(output.rows).toEqual(expect.arrayContaining([expect.objectContaining({ group: 'A', column: 'x', rowCount: 3, 'valid-count': 3, mean: 2, median: 2 })]));
    expect(summaryStatisticsNode.inferSchema([table.schema], config).state).toBe('confirmed');
  });

  it('keeps null metrics explicit for empty and single-value statistical groups', () => {
    const config = summaryStatisticsNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: [], metrics: ['valid-count', 'mean', 'stddev'], variance: 'sample' });
    const empty = summaryStatisticsNode.execute([{ ...table, rows: [] }], config);
    expect(empty.rows).toEqual([expect.objectContaining({ column: 'x', rowCount: 0, 'valid-count': 0, mean: null, stddev: null })]);
    const single = summaryStatisticsNode.execute([{ ...table, rows: [table.rows[0]!] }], config);
    expect(single.rows).toEqual([expect.objectContaining({ rowCount: 1, mean: 1, stddev: null })]);
  });

  it('calculates Pearson and Spearman pair tables', () => {
    const config = correlationAnalysisNode.validateConfig({ configVersion: 1, columns: ['x', 'y'], method: 'pearson', missing: 'pairwise', minPairs: 2, includeDiagonal: false });
    expect(correlationAnalysisNode.execute([table], config).rows).toEqual([expect.objectContaining({ columnX: 'x', columnY: 'y', coefficient: expect.closeTo(0.785, 3), pairCount: 4 })]);
    const spearman = correlationAnalysisNode.execute([table], { ...config, method: 'spearman' });
    expect(spearman.rows[0]?.coefficient).toBeCloseTo(1, 8);
  });

  it('distinguishes pairwise and listwise missing-value policies and reports constant columns', () => {
    const missing = { schema: { columns: [...table.schema.columns, { name: 'z', type: 'number' as const, nullable: true }, { name: 'constant', type: 'number' as const, nullable: false }] }, rows: [
      { group: 'A', x: 1, y: 2, z: 4, constant: 1, at: new Date('2026-01-01T00:00:00Z') },
      { group: 'A', x: 2, y: 4, z: null, constant: 1, at: new Date('2026-01-02T00:00:00Z') },
      { group: 'A', x: 3, y: 6, z: 6, constant: 1, at: new Date('2026-01-03T00:00:00Z') },
    ] };
    const base = correlationAnalysisNode.validateConfig({ configVersion: 1, columns: ['x', 'y', 'z', 'constant'], method: 'pearson', missing: 'pairwise', minPairs: 2, includeDiagonal: false });
    const pairwise = correlationAnalysisNode.execute([missing], base).rows.find((row) => row.columnX === 'x' && row.columnY === 'y');
    const listwise = correlationAnalysisNode.execute([missing], { ...base, missing: 'listwise' }).rows.find((row) => row.columnX === 'x' && row.columnY === 'y');
    const constant = correlationAnalysisNode.execute([missing], base).rows.find((row) => row.columnX === 'x' && row.columnY === 'constant');
    expect(pairwise).toMatchObject({ pairCount: 3, coefficient: 1 });
    expect(listwise).toMatchObject({ pairCount: 2, coefficient: 1 });
    expect(constant).toMatchObject({ coefficient: null, pairCount: 3 });
  });

  it('flags or excludes outliers without mutating the input table', () => {
    const config = outlierFilterNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: [], method: 'z-score', threshold: 1, action: 'flag', nulls: 'keep', flagColumns: { isOutlier: 'outlier', score: 'score', reason: 'reason' } });
    const flagged = outlierFilterNode.execute([table], config);
    expect(flagged.rows.find((row) => row.x === 100)).toMatchObject({ outlier: true, reason: 'x' });
    const excluded = outlierFilterNode.execute([table], { ...config, action: 'exclude' });
    expect(excluded.rows.some((row) => row.x === 100)).toBe(false);
    expect(table.rows).toHaveLength(4);
  });

  it('supports IQR and MAD while treating a zero-scale group as non-outlying', () => {
    const values = { ...table, rows: [
      { group: 'A', x: 1, y: 1, at: new Date('2026-01-01T00:00:00Z') },
      { group: 'A', x: 2, y: 1, at: new Date('2026-01-02T00:00:00Z') },
      { group: 'A', x: 3, y: 1, at: new Date('2026-01-03T00:00:00Z') },
      { group: 'A', x: 100, y: 1, at: new Date('2026-01-04T00:00:00Z') },
      { group: 'B', x: 5, y: 1, at: new Date('2026-01-04T00:00:00Z') },
      { group: 'B', x: 5, y: 1, at: new Date('2026-01-05T00:00:00Z') },
    ] };
    const iqr = outlierFilterNode.execute([values], outlierFilterNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: ['group'], method: 'iqr', threshold: 1.5, action: 'flag', nulls: 'keep', flagColumns: { isOutlier: 'outlier', score: 'score', reason: 'reason' } }));
    expect(iqr.rows.find((row) => row.x === 100)).toMatchObject({ outlier: true });
    const mad = outlierFilterNode.execute([values], outlierFilterNode.validateConfig({ configVersion: 1, columns: ['x'], groupBy: ['group'], method: 'mad', threshold: 3.5, action: 'flag', nulls: 'keep', flagColumns: { isOutlier: 'outlier', score: 'score', reason: 'reason' } }));
    expect(mad.rows.filter((row) => row.group === 'B').every((row) => row.outlier === false)).toBe(true);
  });

  it('buckets dated values and adds moving and comparison values', () => {
    const config = timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x'], groupBy: ['group'], timezone: 'UTC', interval: 'day', aggregate: 'sum', fill: 'none', window: { operation: 'moving-mean', size: 2 }, comparison: { lag: 1, output: ['delta'] } });
    const output = timeSeriesAnalysisNode.execute([table], config);
    expect(output.rows.find((row) => row.group === 'A' && (row.bucketStart as Date).toISOString().startsWith('2026-01-02'))).toMatchObject({ value: 2, movingValue: 1.5, delta: 1 });
  });

  it('fills missing UTC buckets before calculating windows and comparisons', () => {
    const sparse = { ...table, rows: [table.rows[0]!, table.rows[2]!] };
    const zero = timeSeriesAnalysisNode.execute([sparse], timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x'], groupBy: ['group'], timezone: 'UTC', interval: 'day', aggregate: 'sum', fill: 'zero', window: { operation: 'moving-sum', size: 2 }, comparison: { lag: 1, output: ['delta'] } }));
    const filled = zero.rows.find((row) => (row.bucketStart as Date).toISOString().startsWith('2026-01-02'));
    expect(filled).toMatchObject({ value: 0, sampleCount: 0, movingValue: 1, delta: -1 });
    const forward = timeSeriesAnalysisNode.execute([sparse], timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x'], groupBy: ['group'], timezone: 'UTC', interval: 'day', aggregate: 'sum', fill: 'forward' }));
    expect(forward.rows.find((row) => (row.bucketStart as Date).toISOString().startsWith('2026-01-02'))).toMatchObject({ value: 1, sampleCount: 0 });
  });

  it('uses IANA timezone calendar boundaries and rejects invalid timezones', () => {
    const localMidnight = { ...table, rows: [{ group: 'A', x: 2, y: 1, at: new Date('2026-01-01T15:30:00Z') }] };
    const config = timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x'], groupBy: ['group'], timezone: 'Asia/Tokyo', interval: 'day', aggregate: 'sum', fill: 'none' });
    expect((timeSeriesAnalysisNode.execute([localMidnight], config).rows[0]?.bucketStart as Date).toISOString()).toBe('2026-01-01T15:00:00.000Z');
    const invalid = { ...config, timezone: 'Not/AZone' };
    expect(timeSeriesAnalysisNode.inferSchema([table.schema], invalid)).toMatchObject({ state: 'mismatch', issues: [expect.objectContaining({ severity: 'error' })] });
  });

  it('keeps a local calendar day stable across a daylight-saving transition', () => {
    const dst = { ...table, rows: [{ group: 'A', x: 1, y: 1, at: new Date('2026-03-08T06:30:00Z') }, { group: 'A', x: 2, y: 1, at: new Date('2026-03-08T07:30:00Z') }] };
    const config = timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x'], groupBy: ['group'], timezone: 'America/New_York', interval: 'day', aggregate: 'sum', fill: 'none' });
    const output = timeSeriesAnalysisNode.execute([dst], config);
    expect(output.rows).toHaveLength(1);
    expect(output.rows[0]).toMatchObject({ value: 3 });
    expect((output.rows[0]?.bucketStart as Date).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('does not forward-fill values across groups or time-series columns', () => {
    const partitioned = { ...table, rows: [
      { group: 'A', x: 3, y: 10, at: new Date('2026-01-01T00:00:00Z') },
      { group: 'A', x: 5, y: 20, at: new Date('2026-01-03T00:00:00Z') },
      { group: 'B', x: 7, y: 30, at: new Date('2026-01-02T00:00:00Z') },
    ] };
    const output = timeSeriesAnalysisNode.execute([partitioned], timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x', 'y'], groupBy: ['group'], timezone: 'UTC', interval: 'day', aggregate: 'sum', fill: 'forward' }));
    expect(output.rows.find((row) => row.group === 'A' && row.series === 'x' && (row.bucketStart as Date).toISOString().startsWith('2026-01-02'))).toMatchObject({ value: 3, sampleCount: 0 });
    expect(output.rows.find((row) => row.group === 'A' && row.series === 'y' && (row.bucketStart as Date).toISOString().startsWith('2026-01-02'))).toMatchObject({ value: 10, sampleCount: 0 });
    expect(output.rows.some((row) => row.group === 'B' && (row.bucketStart as Date).toISOString().startsWith('2026-01-01'))).toBe(false);
  });
});
