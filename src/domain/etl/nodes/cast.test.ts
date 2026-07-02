import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { castNode } from './cast';

const schema: Schema = {
  columns: [
    { name: 'idStr', type: 'string', nullable: false },
    { name: 'flagStr', type: 'string', nullable: false },
    { name: 'num', type: 'number', nullable: false },
    { name: 'flag', type: 'boolean', nullable: false },
    { name: 'when', type: 'date', nullable: false },
  ],
};

const D = new Date('2020-01-02T03:04:05Z');

const table: Table = {
  schema,
  rows: [
    { idStr: '42', flagStr: 'true', num: 7, flag: true, when: D },
    { idStr: 'x', flagStr: 'nope', num: 0, flag: false, when: D },
  ],
};

describe('cast: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(castNode.type).toBe('cast');
    expect(castNode.kind).toBe('transform');
    expect(castNode.inputArity).toBe(1);
  });
});

describe('cast: validateConfig', () => {
  it('accepts a valid casts array', () => {
    const cfg = castNode.validateConfig({ casts: [{ column: 'a', to: 'number' }] });
    expect(cfg.casts).toEqual([{ column: 'a', to: 'number' }]);
  });

  it('throws ConfigError when to is not an allowed target', () => {
    expect(() => castNode.validateConfig({ casts: [{ column: 'a', to: 'null' }] })).toThrowError(
      ConfigError,
    );
    expect(() => castNode.validateConfig({ casts: [{ column: 'a', to: 'unknown' }] })).toThrowError(
      ConfigError,
    );
  });

  it('throws ConfigError when casts is missing', () => {
    expect(() => castNode.validateConfig({})).toThrowError(ConfigError);
  });
});

describe('cast: inferSchema', () => {
  it('supported cast -> confirmed, target type, nullable:true', () => {
    const inf = castNode.inferSchema([schema], { casts: [{ column: 'idStr', to: 'number' }] });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    const col = inf.schema.columns.find((c) => c.name === 'idStr');
    expect(col).toEqual({ name: 'idStr', type: 'number', nullable: true });
  });

  it('leaves untargeted columns unchanged', () => {
    const inf = castNode.inferSchema([schema], { casts: [{ column: 'idStr', to: 'number' }] });
    expect(inf.schema.columns.find((c) => c.name === 'num')).toEqual({
      name: 'num',
      type: 'number',
      nullable: false,
    });
  });

  it('missing column -> mismatch with error', () => {
    const inf = castNode.inferSchema([schema], { casts: [{ column: 'nope', to: 'number' }] });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('unsupported cast pair -> warning, state stays confirmed', () => {
    // boolean -> number is not in the supported set.
    const inf = castNode.inferSchema([schema], { casts: [{ column: 'flag', to: 'number' }] });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('warning');
    // Output schema still reflects the requested target type.
    expect(inf.schema.columns.find((c) => c.name === 'flag')?.type).toBe('number');
  });

  it('date -> number is unsupported -> warning', () => {
    const inf = castNode.inferSchema([schema], { casts: [{ column: 'when', to: 'number' }] });
    expect(inf.issues[0]?.severity).toBe('warning');
  });
});

describe('cast: execute', () => {
  it('string -> number (NaN becomes null)', () => {
    const out = castNode.execute([table], { casts: [{ column: 'idStr', to: 'number' }] });
    expect(out.rows[0]?.idStr).toBe(42);
    expect(out.rows[1]?.idStr).toBeNull();
  });

  it('string -> boolean (true/1 -> true, false/0 -> false, else null)', () => {
    const t: Table = {
      schema: { columns: [{ name: 's', type: 'string', nullable: false }] },
      rows: [{ s: 'true' }, { s: '1' }, { s: 'false' }, { s: '0' }, { s: 'maybe' }],
    };
    const out = castNode.execute([t], { casts: [{ column: 's', to: 'boolean' }] });
    expect(out.rows.map((r) => r.s)).toEqual([true, true, false, false, null]);
  });

  it('string -> date (invalid becomes null)', () => {
    const t: Table = {
      schema: { columns: [{ name: 's', type: 'string', nullable: false }] },
      rows: [{ s: '2020-01-02T03:04:05Z' }, { s: 'not-a-date' }],
    };
    const out = castNode.execute([t], { casts: [{ column: 's', to: 'date' }] });
    expect(out.rows[0]?.s).toBeInstanceOf(Date);
    expect((out.rows[0]?.s as Date).toISOString()).toBe('2020-01-02T03:04:05.000Z');
    expect(out.rows[1]?.s).toBeNull();
  });

  it('number -> string', () => {
    const out = castNode.execute([table], { casts: [{ column: 'num', to: 'string' }] });
    expect(out.rows[0]?.num).toBe('7');
    expect(out.rows[1]?.num).toBe('0');
  });

  it('boolean -> string', () => {
    const out = castNode.execute([table], { casts: [{ column: 'flag', to: 'string' }] });
    expect(out.rows[0]?.flag).toBe('true');
    expect(out.rows[1]?.flag).toBe('false');
  });

  it('date -> string (ISO)', () => {
    const out = castNode.execute([table], { casts: [{ column: 'when', to: 'string' }] });
    expect(out.rows[0]?.when).toBe(D.toISOString());
  });

  it('number -> boolean (0 -> false, non-zero -> true)', () => {
    const out = castNode.execute([table], { casts: [{ column: 'num', to: 'boolean' }] });
    expect(out.rows[0]?.num).toBe(true);
    expect(out.rows[1]?.num).toBe(false);
  });

  it('null cells stay null', () => {
    const t: Table = {
      schema: { columns: [{ name: 's', type: 'string', nullable: true }] },
      rows: [{ s: null }],
    };
    const out = castNode.execute([t], { casts: [{ column: 's', to: 'number' }] });
    expect(out.rows[0]?.s).toBeNull();
  });

  it('throws SchemaError when a target column is missing', () => {
    expect(() => castNode.execute([table], { casts: [{ column: 'nope', to: 'number' }] })).toThrowError(
      SchemaError,
    );
  });

  it('output column becomes nullable and target type', () => {
    const out = castNode.execute([table], { casts: [{ column: 'idStr', to: 'number' }] });
    expect(out.schema.columns.find((c) => c.name === 'idStr')).toEqual({
      name: 'idStr',
      type: 'number',
      nullable: true,
    });
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows.map((r) => ({ ...r, when: undefined })));
    castNode.execute([table], { casts: [{ column: 'idStr', to: 'number' }] });
    expect(JSON.stringify(table.rows.map((r) => ({ ...r, when: undefined })))).toBe(snapshot);
  });
});
