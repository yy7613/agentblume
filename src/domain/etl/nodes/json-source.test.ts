import { describe, expect, it } from 'vitest';
import type { Row, Schema } from '../../data/types';
import { ConfigError } from '../errors';
import { jsonSourceNode } from './json-source';

describe('json-source: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(jsonSourceNode.type).toBe('json-source');
    expect(jsonSourceNode.kind).toBe('source');
    expect(jsonSourceNode.inputArity).toBe(0);
  });
});

describe('json-source: validateConfig', () => {
  it('accepts rows only', () => {
    const cfg = jsonSourceNode.validateConfig({ rows: [{ id: 1 }] });
    expect(cfg.rows).toEqual([{ id: 1 }]);
    expect(cfg.schema).toBeUndefined();
  });

  it('accepts rows + explicit schema', () => {
    const schema: Schema = { columns: [{ name: 'id', type: 'number', nullable: false }] };
    const cfg = jsonSourceNode.validateConfig({ rows: [{ id: 1 }], schema });
    expect(cfg.schema).toEqual(schema);
  });

  it('accepts Date and null cells (loose data validation)', () => {
    const rows = [{ when: new Date('2020-01-01T00:00:00Z'), maybe: null }];
    expect(() => jsonSourceNode.validateConfig({ rows })).not.toThrow();
  });

  it('throws ConfigError when rows is missing', () => {
    expect(() => jsonSourceNode.validateConfig({})).toThrowError(ConfigError);
  });

  it('throws ConfigError when rows is not an array', () => {
    expect(() => jsonSourceNode.validateConfig({ rows: 'nope' })).toThrowError(ConfigError);
  });

  it('throws ConfigError when a cell is an unsupported type', () => {
    expect(() =>
      jsonSourceNode.validateConfig({ rows: [{ bad: { nested: true } }] }),
    ).toThrowError(ConfigError);
  });

  it('ConfigError message includes zod detail', () => {
    try {
      jsonSourceNode.validateConfig({ rows: 'nope' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain('rows');
    }
  });
});

describe('json-source: inferSchema', () => {
  it('with explicit schema -> confirmed, schema echoed', () => {
    const schema: Schema = { columns: [{ name: 'id', type: 'number', nullable: false }] };
    const inf = jsonSourceNode.inferSchema([], { rows: [{ id: 1 }], schema });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema).toEqual(schema);
    expect(inf.issues).toEqual([]);
  });

  it('without schema -> inferred from rows', () => {
    const rows: Row[] = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    const inf = jsonSourceNode.inferSchema([], { rows });
    expect(inf.state).toBe('inferred');
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(inf.issues).toEqual([]);
  });

  it('empty rows without schema -> inferred empty schema', () => {
    const inf = jsonSourceNode.inferSchema([], { rows: [] });
    expect(inf.state).toBe('inferred');
    expect(inf.schema).toEqual({ columns: [] });
  });
});

describe('json-source: execute', () => {
  it('returns rows with inferred schema when no schema given', () => {
    const rows: Row[] = [{ id: 1 }, { id: 2 }];
    const table = jsonSourceNode.execute([], { rows });
    expect(table.rows).toEqual(rows);
    expect(table.schema.columns.map((c) => c.name)).toEqual(['id']);
  });

  it('returns rows with explicit schema when given', () => {
    const schema: Schema = { columns: [{ name: 'id', type: 'number', nullable: false }] };
    const rows: Row[] = [{ id: 1 }];
    const table = jsonSourceNode.execute([], { rows, schema });
    expect(table.schema).toEqual(schema);
    expect(table.rows).toEqual(rows);
  });

  it('does not mutate the input rows array (returns a copy)', () => {
    const rows: Row[] = [{ id: 1 }];
    const table = jsonSourceNode.execute([], { rows });
    expect(table.rows).not.toBe(rows);
    expect(table.rows).toEqual(rows);
  });
});
