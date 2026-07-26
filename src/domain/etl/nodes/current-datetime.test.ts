import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../errors';
import { currentDatetimeNode } from './current-datetime';

/** 決定的に検証するための固定 instant（UTC 土曜 / Asia/Tokyo では翌日曜）。 */
const FIXED = new Date('2026-07-25T15:30:45.000Z');

function freeze(): void {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED);
}

afterEach(() => vi.useRealTimers());

describe('current-datetime: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(currentDatetimeNode.type).toBe('current-datetime');
    expect(currentDatetimeNode.kind).toBe('source');
    expect(currentDatetimeNode.inputArity).toBe(0);
  });
});

describe('current-datetime: validateConfig', () => {
  it('accepts an empty config (system local timezone)', () => {
    expect(currentDatetimeNode.validateConfig({})).toEqual({});
  });

  it('accepts an IANA timezone', () => {
    expect(currentDatetimeNode.validateConfig({ timezone: 'Asia/Tokyo' })).toEqual({ timezone: 'Asia/Tokyo' });
  });

  it('ignores unknown keys', () => {
    expect(currentDatetimeNode.validateConfig({ timezone: 'UTC', other: 1 })).toEqual({ timezone: 'UTC' });
  });

  it('throws ConfigError on a non-string timezone', () => {
    expect(() => currentDatetimeNode.validateConfig({ timezone: 9 })).toThrowError(ConfigError);
  });

  it('throws ConfigError on an empty timezone', () => {
    expect(() => currentDatetimeNode.validateConfig({ timezone: '' })).toThrowError(ConfigError);
  });
});

describe('current-datetime: inferSchema', () => {
  it('returns the fixed five-column schema as confirmed', () => {
    const inference = currentDatetimeNode.inferSchema([], {});
    expect(inference.state).toBe('confirmed');
    expect(inference.issues).toEqual([]);
    expect(inference.schema).toEqual({
      columns: [
        { name: 'now', type: 'date', nullable: false },
        { name: 'date', type: 'string', nullable: false },
        { name: 'yearMonth', type: 'string', nullable: false },
        { name: 'time', type: 'string', nullable: false },
        { name: 'weekday', type: 'string', nullable: false },
      ],
    });
  });

  it('keeps the same schema for an explicit timezone', () => {
    expect(currentDatetimeNode.inferSchema([], { timezone: 'Asia/Tokyo' }).schema)
      .toEqual(currentDatetimeNode.inferSchema([], {}).schema);
  });

  it('reports an error issue and mismatch for an unsupported timezone', () => {
    const inference = currentDatetimeNode.inferSchema([], { timezone: 'Mars/Olympus' });
    expect(inference.state).toBe('mismatch');
    expect(inference.issues).toEqual([{ severity: 'error', message: 'current-datetime: unsupported IANA timezone: Mars/Olympus' }]);
  });
});

describe('current-datetime: execute', () => {
  it('returns exactly one row matching the declared schema', () => {
    const table = currentDatetimeNode.execute([], {});
    expect(table.schema).toEqual(currentDatetimeNode.inferSchema([], {}).schema);
    expect(table.rows).toHaveLength(1);
    expect(Object.keys(table.rows[0]!)).toEqual(['now', 'date', 'yearMonth', 'time', 'weekday']);
  });

  it('formats each column and uses the current instant', () => {
    const before = Date.now();
    const row = currentDatetimeNode.execute([], {}).rows[0]!;
    const after = Date.now();
    expect(row['now']).toBeInstanceOf(Date);
    expect((row['now'] as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((row['now'] as Date).getTime()).toBeLessThanOrEqual(after);
    expect(row['date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row['yearMonth']).toMatch(/^\d{4}-\d{2}$/);
    expect(row['time']).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row['weekday']).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
    expect(row['yearMonth']).toBe((row['date'] as string).slice(0, 7));
  });

  it('applies UTC exactly as Intl does', () => {
    freeze();
    const row = currentDatetimeNode.execute([], { timezone: 'UTC' }).rows[0]!;
    expect(row['now']).toEqual(FIXED);
    expect(row['date']).toBe('2026-07-25');
    expect(row['yearMonth']).toBe('2026-07');
    expect(row['time']).toBe('15:30:45');
    expect(row['weekday']).toBe(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(FIXED));
    expect(row['weekday']).toBe('Sat');
  });

  it('shifts the calendar day across the timezone boundary', () => {
    freeze();
    const tokyo = currentDatetimeNode.execute([], { timezone: 'Asia/Tokyo' }).rows[0]!;
    const utc = currentDatetimeNode.execute([], { timezone: 'UTC' }).rows[0]!;
    // 同じ instant なのに暦日・曜日は timezone で変わる（now は共通）。
    expect(tokyo['now']).toEqual(utc['now']);
    expect(tokyo['date']).toBe('2026-07-26');
    expect(tokyo['time']).toBe('00:30:45');
    expect(tokyo['weekday']).toBe('Sun');
  });

  it('throws ConfigError for an unsupported timezone', () => {
    expect(() => currentDatetimeNode.execute([], { timezone: 'Mars/Olympus' })).toThrowError(ConfigError);
  });

  it('reuses the cached formatter across calls', () => {
    freeze();
    const first = currentDatetimeNode.execute([], { timezone: 'Asia/Tokyo' }).rows[0]!;
    const second = currentDatetimeNode.execute([], { timezone: 'Asia/Tokyo' }).rows[0]!;
    expect(second).toEqual(first);
  });
});
