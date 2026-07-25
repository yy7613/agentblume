/**
 * `time-series-analysis` の Intl.DateTimeFormat キャッシュ（性能）回帰テスト。
 * バケット境界・fill・window・comparison の出力検証は analysis-nodes.test.ts が担う。
 */
import { describe, expect, it } from 'vitest';
import type { Row, Schema } from '../../data/types';
import { timeSeriesAnalysisNode } from './time-series-analysis';

const schema: Schema = {
  columns: [
    { name: 'at', type: 'date', nullable: false },
    { name: 'x', type: 'number', nullable: true },
    { name: 'y', type: 'number', nullable: true },
  ],
};

/** `count` 行を1分間隔で生成する（1日あたり1440行 → 複数バケットにまたがる）。 */
function minuteRows(count: number): Row[] {
  const start = Date.UTC(2026, 0, 1, 0, 0);
  return Array.from({ length: count }, (_, index) => ({ at: new Date(start + index * 60_000), x: index, y: index * 2 }));
}

const config = (patch: Record<string, unknown> = {}) =>
  timeSeriesAnalysisNode.validateConfig({ configVersion: 1, timeColumn: 'at', valueColumns: ['x'], groupBy: [], timezone: 'UTC', interval: 'day', aggregate: 'sum', fill: 'none', ...patch });

/** Intl.DateTimeFormat のコンストラクタ呼び出しを timeZone つきで記録する。 */
function recordFormatterConstruction<T>(run: () => T): { readonly result: T; readonly timeZones: readonly (string | undefined)[] } {
  const intl = Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat };
  const original = intl.DateTimeFormat;
  const timeZones: (string | undefined)[] = [];
  intl.DateTimeFormat = function patched(locales?: unknown, options?: Intl.DateTimeFormatOptions) {
    timeZones.push(options?.timeZone);
    return new original(locales as string | undefined, options);
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    return { result: run(), timeZones };
  } finally {
    intl.DateTimeFormat = original;
  }
}

describe('time-series-analysis: formatter cache', () => {
  it('creates one formatter per timezone regardless of the row count', () => {
    // 他のテストと共有しない timezone を使い、モジュールスコープのキャッシュ状態に依存しない。
    const timezone = 'Europe/Berlin';
    const rows = minuteRows(5_000);
    const { result, timeZones } = recordFormatterConstruction(() =>
      timeSeriesAnalysisNode.execute([{ schema, rows }], config({ timezone, valueColumns: ['x', 'y'] })),
    );
    expect(timeZones.filter((zone) => zone === timezone)).toHaveLength(1);
    // 4日 × 2系列（1分間隔5000行 = 3日と11時間ぶん）。
    expect(result.rows).toHaveLength(8);
  });

  it('reuses the cached formatter across executions', () => {
    const timezone = 'Europe/Lisbon';
    const rows = minuteRows(10);
    timeSeriesAnalysisNode.execute([{ schema, rows }], config({ timezone }));
    const { timeZones } = recordFormatterConstruction(() =>
      timeSeriesAnalysisNode.execute([{ schema, rows }], config({ timezone })),
    );
    expect(timeZones.filter((zone) => zone === timezone)).toHaveLength(0);
  });

  it('caches the unsupported-timezone verdict without constructing a formatter twice', () => {
    const timezone = 'Not/AZone';
    expect(timeSeriesAnalysisNode.inferSchema([schema], config({ timezone })).state).toBe('mismatch');
    const { timeZones } = recordFormatterConstruction(() =>
      timeSeriesAnalysisNode.inferSchema([schema], config({ timezone })),
    );
    expect(timeZones.filter((zone) => zone === timezone)).toHaveLength(0);
  });
});

describe('time-series-analysis: bucket reuse', () => {
  it('produces identical output for cached and distinct instants', () => {
    // 同一 instant を重複させても（bucket メモ化の経路）集計結果は変わらない。
    const repeated: Row[] = [
      { at: new Date('2026-05-10T01:00:00Z'), x: 1, y: 1 },
      { at: new Date('2026-05-10T01:00:00Z'), x: 2, y: 2 },
      { at: new Date('2026-05-11T02:00:00Z'), x: 4, y: 4 },
    ];
    const output = timeSeriesAnalysisNode.execute([{ schema, rows: repeated }], config({ timezone: 'Asia/Tokyo' }));
    expect(output.rows.map((row) => [(row.bucketStart as Date).toISOString(), row.value, row.sampleCount])).toEqual([
      ['2026-05-09T15:00:00.000Z', 3, 2],
      ['2026-05-10T15:00:00.000Z', 4, 1],
    ]);
  });

  it('fills gaps with the shared next-bucket cache', () => {
    const sparse: Row[] = [
      { at: new Date('2026-02-01T00:00:00Z'), x: 1, y: 1 },
      { at: new Date('2026-02-05T00:00:00Z'), x: 5, y: 5 },
    ];
    const output = timeSeriesAnalysisNode.execute([{ schema, rows: sparse }], config({ fill: 'zero' }));
    expect(output.rows.map((row) => row.value)).toEqual([1, 0, 0, 0, 5]);
  });

  it('aggregates min/max over a large bucket without a stack overflow', () => {
    const rows = minuteRows(150_000);
    const min = timeSeriesAnalysisNode.execute([{ schema, rows }], config({ interval: 'month', aggregate: 'min' }));
    const max = timeSeriesAnalysisNode.execute([{ schema, rows }], config({ interval: 'month', aggregate: 'max' }));
    expect(min.rows[0]?.value).toBe(0);
    expect(max.rows.at(-1)?.value).toBe(149_999);
  }, 60_000);
});
