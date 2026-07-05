import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { distinctNode } from './distinct';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'dept', type: 'string', nullable: true },
  ],
};

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Alice', dept: 'eng' },
    { id: 2, name: 'Bob', dept: 'hr' },
    { id: 1, name: 'Alice', dept: 'eng' }, // 全列重複（行1と同一）
    { id: 3, name: 'Alice', dept: 'eng' }, // id だけ異なる
  ],
};

describe('distinct: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(distinctNode.type).toBe('distinct');
    expect(distinctNode.kind).toBe('transform');
    expect(distinctNode.inputArity).toBe(1);
  });
});

describe('distinct: validateConfig', () => {
  it('accepts empty config (all columns)', () => {
    expect(distinctNode.validateConfig({}).columns).toBeUndefined();
  });

  it('accepts an explicit columns array', () => {
    expect(distinctNode.validateConfig({ columns: ['a'] }).columns).toEqual(['a']);
  });

  it('throws ConfigError when columns is not an array of strings', () => {
    expect(() => distinctNode.validateConfig({ columns: [1] })).toThrowError(ConfigError);
  });
});

describe('distinct: inferSchema', () => {
  it('existing columns -> schema unchanged, confirmed', () => {
    const inf = distinctNode.inferSchema([schema], { columns: ['name'] });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema).toBe(schema);
  });

  it('omitted columns -> confirmed (all columns)', () => {
    const inf = distinctNode.inferSchema([schema], {});
    expect(inf.state).toBe('confirmed');
  });

  it('missing column -> error issue with column, mismatch', () => {
    const inf = distinctNode.inferSchema([schema], { columns: ['nope'] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });
});

describe('distinct: execute', () => {
  it('all columns (omitted): removes only fully duplicated rows, keeps first', () => {
    const out = distinctNode.execute([table], {});
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', dept: 'eng' },
      { id: 2, name: 'Bob', dept: 'hr' },
      { id: 3, name: 'Alice', dept: 'eng' },
    ]);
  });

  it('empty columns array means all columns as well', () => {
    const out = distinctNode.execute([table], { columns: [] });
    expect(out.rows).toHaveLength(3);
  });

  it('specified columns: keeps the first row per key tuple, in order', () => {
    const out = distinctNode.execute([table], { columns: ['name', 'dept'] });
    // Alice/eng は行1が最初 → id:1 が残り、id:3 は落ちる。
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', dept: 'eng' },
      { id: 2, name: 'Bob', dept: 'hr' },
    ]);
  });

  it('treats Date cells by ISO value and null as its own token', () => {
    const t: Table = {
      schema: {
        columns: [{ name: 'day', type: 'date', nullable: true }],
      },
      rows: [
        { day: new Date('2026-01-01T00:00:00Z') },
        { day: new Date('2026-01-01T00:00:00Z') }, // 同時刻の別インスタンス
        { day: null },
        { day: null },
        { day: new Date('2026-01-02T00:00:00Z') },
      ],
    };
    const out = distinctNode.execute([t], {});
    expect(out.rows).toEqual([
      { day: new Date('2026-01-01T00:00:00Z') },
      { day: null },
      { day: new Date('2026-01-02T00:00:00Z') },
    ]);
  });

  it('does not confuse values of different types with the same string form', () => {
    const t: Table = {
      schema: { columns: [{ name: 'v', type: 'unknown', nullable: true }] },
      rows: [{ v: 1 }, { v: '1' }, { v: true }, { v: 'true' }, { v: null }, { v: 'null' }],
    };
    const out = distinctNode.execute([t], {});
    expect(out.rows).toHaveLength(6);
  });

  it('throws SchemaError when a specified column is missing', () => {
    expect(() => distinctNode.execute([table], { columns: ['missing'] })).toThrowError(SchemaError);
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows);
    distinctNode.execute([table], {});
    expect(JSON.stringify(table.rows)).toBe(snapshot);
    expect(table.rows).toHaveLength(4);
  });
});
