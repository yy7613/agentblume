/**
 * `time-series-analysis` の Intl.DateTimeFormat キャッシュ（性能）回帰テストと、
 * 欠損 bucket 補完（fill）の上限テスト。
 * バケット境界・fill・window・comparison の出力検証は analysis-nodes.test.ts が担う。
 */
import { describe, expect, it } from 'vitest';
import type { Row, Schema } from '../../data/types';
import { SchemaError } from '../errors';
import { MAX_TIME_SERIES_FILL_BUCKETS, timeSeriesAnalysisNode } from './time-series-analysis';

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

const FILL_CAP_MESSAGE = 'time-series-analysis: fill would generate more than 100000 buckets; narrow the time range or choose a coarser interval';

const groupedSchema: Schema = { columns: [...schema.columns, { name: 'group', type: 'string', nullable: false }] };

/** 先頭と末尾の 2 行だけで `buckets` 個のバケットにまたがる疎なデータ（間は全部 fill で埋まる）。 */
function sparseRows(buckets: number, unitMs: number, group = 'A'): Row[] {
  const start = Date.UTC(2020, 0, 1);
  return [{ at: new Date(start), x: 1, group }, { at: new Date(start + unitMs * (buckets - 1)), x: 2, group }];
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('time-series-analysis: minute バケット', () => {
  it('minute バケットは時を保つ（11:19 の行が 00:19 に潰れない）', () => {
    // 上限テストで露見した既存バグ: interval:'minute' で hour が 0 に落ち、1 日分の分が同じ時刻へ重なっていた。
    const rows = [{ at: new Date('2020-01-04T11:19:30Z'), x: 1 }, { at: new Date('2020-01-04T11:19:45Z'), x: 2 }, { at: new Date('2020-01-04T00:19:00Z'), x: 4 }];
    const output = timeSeriesAnalysisNode.execute([{ schema, rows }], config({ interval: 'minute' }));
    expect(output.rows.map((row) => [(row.bucketStart as Date).toISOString(), row.value])).toEqual([
      ['2020-01-04T00:19:00.000Z', 4],
      ['2020-01-04T11:19:00.000Z', 3],
    ]);
  });
});

describe('time-series-analysis: fill の上限', () => {
  it('上限定数は 100,000 バケット/パーティションとして公開される', () => {
    expect(MAX_TIME_SERIES_FILL_BUCKETS).toBe(100_000);
  });

  it.each([
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
  ] as const)('%s: ちょうど上限のバケット数は補完でき、1 つ超えると SchemaError で止まる', (interval, unitMs) => {
    const atCap = timeSeriesAnalysisNode.execute([{ schema, rows: sparseRows(MAX_TIME_SERIES_FILL_BUCKETS, unitMs) }], config({ interval, fill: 'zero' }));
    expect(atCap.rows).toHaveLength(MAX_TIME_SERIES_FILL_BUCKETS);
    expect(atCap.rows[1]).toMatchObject({ value: 0, sampleCount: 0 });
    expect(atCap.rows.at(-1)).toMatchObject({ value: 2, sampleCount: 1 });

    const error = caught(() => timeSeriesAnalysisNode.execute([{ schema, rows: sparseRows(MAX_TIME_SERIES_FILL_BUCKETS + 1, unitMs) }], config({ interval, fill: 'zero' })));
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).message).toBe(FILL_CAP_MESSAGE);
  }, 60_000);

  it('上限はパーティション（group × series）ごとに数える: 各 60,000 バケットの 2 グループは合計 120,000 でも通る', () => {
    const rows = [...sparseRows(60_000, 60_000, 'A'), ...sparseRows(60_000, 60_000, 'B')];
    const output = timeSeriesAnalysisNode.execute([{ schema: groupedSchema, rows }], config({ interval: 'minute', fill: 'forward', groupBy: ['group'] }));
    expect(output.rows).toHaveLength(120_000);
    expect(output.rows.filter((row) => row.group === 'B')).toHaveLength(60_000);
  }, 60_000);

  it("fill:'none' は補完しないので、20 年 × minute でも上限に触れず 2 行を返す", () => {
    const rows = [{ at: new Date(Date.UTC(2000, 0, 1)), x: 1 }, { at: new Date(Date.UTC(2020, 0, 1)), x: 2 }];
    const output = timeSeriesAnalysisNode.execute([{ schema, rows }], config({ interval: 'minute', fill: 'none' }));
    expect(output.rows).toHaveLength(2);
  });

  it('20 年 × minute の疎データ（約 1,050 万バケット）は、確保する前に歩きながら数えて打ち切る', () => {
    // 修正前は 100 秒・+3 GB で単一プロセスのサーバを止めていた（POST /tool-drafts/preview から到達可能）。
    const rows = [{ at: new Date(Date.UTC(2000, 0, 1)), x: 1 }, { at: new Date(Date.UTC(2020, 0, 1)), x: 2 }];
    const error = caught(() => timeSeriesAnalysisNode.execute([{ schema, rows }], config({ interval: 'minute', fill: 'zero' })));
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).message).toBe(FILL_CAP_MESSAGE);
  }, 60_000);

  it('無効な日付（NaN）の行は従来どおり読み飛ばし、残りの行で補完する', () => {
    const rows = [{ at: new Date(Number.NaN), x: 100 }, { at: new Date(Date.UTC(2026, 0, 1)), x: 1 }, { at: new Date(Date.UTC(2026, 0, 3)), x: 3 }];
    const output = timeSeriesAnalysisNode.execute([{ schema, rows }], config({ interval: 'day', fill: 'zero' }));
    expect(output.rows.map((row) => row.value)).toEqual([1, 0, 3]);
    expect(output.rows.map((row) => row.sampleCount)).toEqual([1, 0, 1]);
  });
});
