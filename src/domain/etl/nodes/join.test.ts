import { describe, expect, it } from 'vitest';
import type { Row, Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { MAX_JOIN_ROWS, joinNode } from './join';

const leftSchema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: false },
    { name: 'deptId', type: 'string', nullable: true },
  ],
};

const rightSchema: Schema = {
  columns: [
    { name: 'code', type: 'string', nullable: false },
    { name: 'deptName', type: 'string', nullable: false },
  ],
};

const leftTable: Table = {
  schema: leftSchema,
  rows: [
    { id: 1, name: 'Alice', deptId: 'eng' },
    { id: 2, name: 'Bob', deptId: null },
    { id: 3, name: 'Carol', deptId: 'hr' },
    { id: 4, name: 'Dave', deptId: 'sales' },
  ],
};

const rightTable: Table = {
  schema: rightSchema,
  rows: [
    { code: 'eng', deptName: 'Engineering' },
    { code: 'hr', deptName: 'HR' },
    { code: 'fin', deptName: 'Finance' },
  ],
};

const keys = [{ left: 'deptId', right: 'code' }];

describe('join: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(joinNode.type).toBe('join');
    expect(joinNode.kind).toBe('transform');
    expect(joinNode.inputArity).toBe(2);
  });
});

describe('join: validateConfig', () => {
  it('accepts a valid config and keeps rightSuffix optional', () => {
    const config = joinNode.validateConfig({ mode: 'inner', keys });
    expect(config.mode).toBe('inner');
    expect(config.keys).toEqual(keys);
    expect(config.rightSuffix).toBeUndefined();
  });

  it('accepts an explicit rightSuffix', () => {
    const config = joinNode.validateConfig({ mode: 'left', keys, rightSuffix: '_r' });
    expect(config.rightSuffix).toBe('_r');
  });

  it('throws ConfigError for an unknown mode', () => {
    expect(() => joinNode.validateConfig({ mode: 'cross', keys })).toThrowError(ConfigError);
  });

  it('throws ConfigError when keys is empty', () => {
    expect(() => joinNode.validateConfig({ mode: 'inner', keys: [] })).toThrowError(ConfigError);
  });

  it('throws ConfigError when a key pair is malformed', () => {
    expect(() =>
      joinNode.validateConfig({ mode: 'inner', keys: [{ left: 'a' }] }),
    ).toThrowError(ConfigError);
  });
});

describe('join: inferSchema', () => {
  it('normal case -> left columns + right non-key columns, confirmed', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'inner', keys });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    // 右のキー列 code は出力から除かれる。
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'deptId', 'deptName']);
  });

  it('inner join keeps original nullable on both sides', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'inner', keys });
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(false);
    expect(byName.get('deptName')?.nullable).toBe(false);
  });

  it('left join makes right-derived columns nullable', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'left', keys });
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(false);
    expect(byName.get('deptName')?.nullable).toBe(true);
  });

  it('right join makes left-derived columns nullable', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'right', keys });
    const byName = new Map(inf.schema.columns.map((c) => [c.name, c]));
    expect(byName.get('id')?.nullable).toBe(true);
    expect(byName.get('name')?.nullable).toBe(true);
    expect(byName.get('deptName')?.nullable).toBe(false);
  });

  it('full join makes both sides nullable', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], { mode: 'full', keys });
    for (const c of inf.schema.columns) {
      expect(c.nullable).toBe(true);
    }
  });

  it('missing left key column -> error issue with column, mismatch', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], {
      mode: 'inner',
      keys: [{ left: 'nope', right: 'code' }],
    });
    expect(inf.state).toBe('mismatch');
    const errors = inf.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('nope');
  });

  it('missing right key column -> error issue with column, mismatch', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], {
      mode: 'inner',
      keys: [{ left: 'deptId', right: 'nope' }],
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('key type mismatch -> error + mismatch', () => {
    const inf = joinNode.inferSchema([leftSchema, rightSchema], {
      mode: 'inner',
      keys: [{ left: 'id', right: 'code' }], // number vs string
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('key type mismatch with unknown side -> warning only, confirmed', () => {
    const unknownRight: Schema = {
      columns: [{ name: 'code', type: 'unknown', nullable: true }],
    };
    const inf = joinNode.inferSchema([leftSchema, unknownRight], {
      mode: 'inner',
      keys: [{ left: 'deptId', right: 'code' }],
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.severity).toBe('warning');
  });

  it('colliding right column gets the default suffix _right', () => {
    const rightWithName: Schema = {
      columns: [
        { name: 'code', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    };
    const inf = joinNode.inferSchema([leftSchema, rightWithName], { mode: 'inner', keys });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'deptId', 'name_right']);
  });

  it('collision remaining after suffix -> error + mismatch', () => {
    const leftWithSuffixed: Schema = {
      columns: [
        { name: 'name', type: 'string', nullable: false },
        { name: 'name_right', type: 'string', nullable: false },
        { name: 'deptId', type: 'string', nullable: true },
      ],
    };
    const rightWithName: Schema = {
      columns: [
        { name: 'code', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    };
    const inf = joinNode.inferSchema([leftWithSuffixed, rightWithName], { mode: 'inner', keys });
    expect(inf.state).toBe('mismatch');
    const errors = inf.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.column).toBe('name');
  });

  it('missing input schemas -> everything missing, mismatch', () => {
    const inf = joinNode.inferSchema([], { mode: 'inner', keys });
    expect(inf.state).toBe('mismatch');
  });
});

describe('join: execute', () => {
  it('inner join keeps only matched pairs (null keys never match)', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'inner', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
    ]);
  });

  it('left join keeps unmatched left rows with null-filled right columns', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'left', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 2, name: 'Bob', deptId: null, deptName: null },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
      { id: 4, name: 'Dave', deptId: 'sales', deptName: null },
    ]);
  });

  it('right join appends unmatched right rows with null-filled left columns', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'right', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
      { id: null, name: null, deptId: null, deptName: 'Finance' },
    ]);
  });

  it('full join outputs matched, unmatched-left, then unmatched-right rows', () => {
    const out = joinNode.execute([leftTable, rightTable], { mode: 'full', keys });
    expect(out.rows).toEqual([
      { id: 1, name: 'Alice', deptId: 'eng', deptName: 'Engineering' },
      { id: 2, name: 'Bob', deptId: null, deptName: null },
      { id: 3, name: 'Carol', deptId: 'hr', deptName: 'HR' },
      { id: 4, name: 'Dave', deptId: 'sales', deptName: null },
      { id: null, name: null, deptId: null, deptName: 'Finance' },
    ]);
  });

  it('multiple matches produce the cartesian product in right row order', () => {
    const right: Table = {
      schema: rightSchema,
      rows: [
        { code: 'eng', deptName: 'Engineering-1' },
        { code: 'eng', deptName: 'Engineering-2' },
      ],
    };
    const left: Table = {
      schema: leftSchema,
      rows: [{ id: 1, name: 'Alice', deptId: 'eng' }],
    };
    const out = joinNode.execute([left, right], { mode: 'inner', keys });
    expect(out.rows.map((r) => r['deptName'])).toEqual(['Engineering-1', 'Engineering-2']);
  });

  it('null keys stay unmatched even when both sides are null', () => {
    const left: Table = {
      schema: leftSchema,
      rows: [{ id: 1, name: 'Alice', deptId: null }],
    };
    const right: Table = {
      schema: rightSchema,
      rows: [{ code: null, deptName: 'Nowhere' }],
    };
    // inner: null 同士でもマッチしない → 0 行。
    expect(joinNode.execute([left, right], { mode: 'inner', keys }).rows).toEqual([]);
    // full: 両方が無マッチ行として残る。
    const full = joinNode.execute([left, right], { mode: 'full', keys });
    expect(full.rows).toEqual([
      { id: 1, name: 'Alice', deptId: null, deptName: null },
      { id: null, name: null, deptId: null, deptName: 'Nowhere' },
    ]);
  });

  it('supports composite keys and Date key equality by time value', () => {
    const left: Table = {
      schema: {
        columns: [
          { name: 'day', type: 'date', nullable: false },
          { name: 'code', type: 'string', nullable: false },
        ],
      },
      rows: [
        { day: new Date('2026-01-01T00:00:00Z'), code: 'a' },
        { day: new Date('2026-01-02T00:00:00Z'), code: 'a' },
      ],
    };
    const right: Table = {
      schema: {
        columns: [
          { name: 'day', type: 'date', nullable: false },
          { name: 'code', type: 'string', nullable: false },
          { name: 'value', type: 'number', nullable: false },
        ],
      },
      rows: [{ day: new Date('2026-01-01T00:00:00Z'), code: 'a', value: 10 }],
    };
    const out = joinNode.execute([left, right], {
      mode: 'inner',
      keys: [
        { left: 'day', right: 'day' },
        { left: 'code', right: 'code' },
      ],
    });
    expect(out.rows).toEqual([{ day: new Date('2026-01-01T00:00:00Z'), code: 'a', value: 10 }]);
  });

  it('applies rightSuffix to colliding right columns in rows', () => {
    const right: Table = {
      schema: {
        columns: [
          { name: 'code', type: 'string', nullable: false },
          { name: 'name', type: 'string', nullable: false },
        ],
      },
      rows: [{ code: 'eng', deptName: 'x', name: 'Engineering' }],
    };
    const out = joinNode.execute([leftTable, right], { mode: 'inner', keys });
    expect(out.rows[0]).toEqual({ id: 1, name: 'Alice', deptId: 'eng', name_right: 'Engineering' });
  });

  it('throws SchemaError when a key column is missing', () => {
    expect(() =>
      joinNode.execute([leftTable, rightTable], {
        mode: 'inner',
        keys: [{ left: 'missing', right: 'code' }],
      }),
    ).toThrowError(SchemaError);
  });

  it('throws SchemaError when suffix cannot resolve a collision', () => {
    const left: Table = {
      schema: {
        columns: [
          { name: 'name', type: 'string', nullable: false },
          { name: 'name_right', type: 'string', nullable: false },
          { name: 'deptId', type: 'string', nullable: true },
        ],
      },
      rows: [],
    };
    const right: Table = {
      schema: {
        columns: [
          { name: 'code', type: 'string', nullable: false },
          { name: 'name', type: 'string', nullable: false },
        ],
      },
      rows: [],
    };
    expect(() => joinNode.execute([left, right], { mode: 'inner', keys })).toThrowError(SchemaError);
  });

  it('does not mutate the input tables', () => {
    const leftSnapshot = JSON.stringify(leftTable.rows);
    const rightSnapshot = JSON.stringify(rightTable.rows);
    joinNode.execute([leftTable, rightTable], { mode: 'full', keys });
    expect(JSON.stringify(leftTable.rows)).toBe(leftSnapshot);
    expect(JSON.stringify(rightTable.rows)).toBe(rightSnapshot);
  });
});

// ---------------------------------------------------------------------------
// キー型検査（execute が無言の0行を返さない）と coerceKeys
// ---------------------------------------------------------------------------

/** CSV のゼロ埋め ID が number に推論された側（`001` → 1）。 */
const numberIdLeft: Table = {
  schema: {
    columns: [
      { name: 'id', type: 'number', nullable: false },
      { name: 'label', type: 'string', nullable: false },
    ],
  },
  rows: [
    { id: 1, label: 'one' },
    { id: 2, label: 'two' },
  ],
};

/** JSON の string ID 側。 */
const stringIdRight: Table = {
  schema: {
    columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'note', type: 'string', nullable: false },
    ],
  },
  rows: [
    { id: '1', note: 'from JSON' },
    { id: '3', note: 'other' },
  ],
};

const idKeys = [{ left: 'id', right: 'id' }];

describe('join: execute key type check', () => {
  it('throws SchemaError instead of silently returning zero rows on a key type mismatch', () => {
    expect(() => joinNode.execute([numberIdLeft, stringIdRight], { mode: 'inner', keys: idKeys })).toThrowError(
      SchemaError,
    );
    expect(() => joinNode.execute([numberIdLeft, stringIdRight], { mode: 'inner', keys: idKeys })).toThrowError(
      "join: key type mismatch: id ('number') vs id ('string')",
    );
  });

  it('uses the same message as the inferSchema error issue', () => {
    const issue = joinNode
      .inferSchema([numberIdLeft.schema, stringIdRight.schema], { mode: 'inner', keys: idKeys })
      .issues.find((candidate) => candidate.severity === 'error');
    let message = '';
    try {
      joinNode.execute([numberIdLeft, stringIdRight], { mode: 'left', keys: idKeys });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe(issue?.message);
  });

  it('checks the type for every mode including outer joins', () => {
    for (const mode of ['inner', 'left', 'right', 'full'] as const) {
      expect(() => joinNode.execute([numberIdLeft, stringIdRight], { mode, keys: idKeys })).toThrowError(SchemaError);
    }
  });

  it('tolerates an unknown-typed key column and still matches by value', () => {
    const unknownLeft: Table = {
      schema: {
        columns: [
          { name: 'id', type: 'unknown', nullable: true },
          { name: 'label', type: 'string', nullable: false },
        ],
      },
      rows: [{ id: '1', label: 'one' }],
    };
    const out = joinNode.execute([unknownLeft, stringIdRight], { mode: 'inner', keys: idKeys });
    expect(out.rows).toEqual([{ id: '1', label: 'one', note: 'from JSON' }]);
  });

  it('does not check the type when the key column is missing (missing column wins)', () => {
    expect(() =>
      joinNode.execute([numberIdLeft, stringIdRight], { mode: 'inner', keys: [{ left: 'nope', right: 'id' }] }),
    ).toThrowError('join: key column(s) not found: nope');
  });
});

describe('join: coerceKeys', () => {
  it('validateConfig keeps coerceKeys optional for already saved tools', () => {
    expect(joinNode.validateConfig({ mode: 'inner', keys }).coerceKeys).toBeUndefined();
  });

  it('validateConfig accepts none/string and rejects anything else', () => {
    expect(joinNode.validateConfig({ mode: 'inner', keys, coerceKeys: 'none' }).coerceKeys).toBe('none');
    expect(joinNode.validateConfig({ mode: 'inner', keys, coerceKeys: 'string' }).coerceKeys).toBe('string');
    expect(() => joinNode.validateConfig({ mode: 'inner', keys, coerceKeys: 'number' })).toThrowError(ConfigError);
  });

  it("matches 1 with '1' when comparing keys as text", () => {
    const out = joinNode.execute([numberIdLeft, stringIdRight], {
      mode: 'inner',
      keys: idKeys,
      coerceKeys: 'string',
    });
    expect(out.rows).toEqual([{ id: 1, label: 'one', note: 'from JSON' }]);
  });

  it("keeps 1 and '1' apart with the default (none)", () => {
    const sameType: Table = {
      schema: {
        columns: [
          { name: 'id', type: 'unknown', nullable: false },
          { name: 'note', type: 'string', nullable: false },
        ],
      },
      rows: [{ id: '1', note: 'from JSON' }],
    };
    expect(joinNode.execute([numberIdLeft, sameType], { mode: 'inner', keys: idKeys }).rows).toEqual([]);
    expect(
      joinNode.execute([numberIdLeft, sameType], { mode: 'inner', keys: idKeys, coerceKeys: 'none' }).rows,
    ).toEqual([]);
  });

  it('never matches null keys even when comparing keys as text', () => {
    const left: Table = {
      schema: leftSchema,
      rows: [{ id: 1, name: 'Alice', deptId: null }],
    };
    const right: Table = {
      schema: rightSchema,
      rows: [{ code: null, deptName: 'Nowhere' }],
    };
    expect(
      joinNode.execute([left, right], { mode: 'inner', keys, coerceKeys: 'string' }).rows,
    ).toEqual([]);
  });

  it('compares boolean and date keys as text without changing equality', () => {
    const left: Table = {
      schema: {
        columns: [
          { name: 'day', type: 'date', nullable: false },
          { name: 'flag', type: 'boolean', nullable: false },
        ],
      },
      rows: [
        { day: new Date('2026-01-01T00:00:00Z'), flag: true },
        { day: new Date('2026-01-02T00:00:00Z'), flag: false },
      ],
    };
    const right: Table = {
      schema: {
        columns: [
          { name: 'day', type: 'date', nullable: false },
          { name: 'flag', type: 'boolean', nullable: false },
          { name: 'value', type: 'number', nullable: false },
        ],
      },
      rows: [{ day: new Date('2026-01-01T00:00:00Z'), flag: true, value: 10 }],
    };
    const out = joinNode.execute([left, right], {
      mode: 'inner',
      keys: [
        { left: 'day', right: 'day' },
        { left: 'flag', right: 'flag' },
      ],
      coerceKeys: 'string',
    });
    expect(out.rows).toEqual([{ day: new Date('2026-01-01T00:00:00Z'), flag: true, value: 10 }]);
  });

  it('relaxes the inferSchema type mismatch to a warning', () => {
    const inf = joinNode.inferSchema([numberIdLeft.schema, stringIdRight.schema], {
      mode: 'inner',
      keys: idKeys,
      coerceKeys: 'string',
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([
      { severity: 'warning', message: "join: keys compared as text: id ('number') vs id ('string')", column: 'id' },
    ]);
  });

  it('still reports the unknown-side warning when comparing keys as text', () => {
    const unknownRight: Schema = { columns: [{ name: 'code', type: 'unknown', nullable: true }] };
    const inf = joinNode.inferSchema([leftSchema, unknownRight], { mode: 'inner', keys, coerceKeys: 'string' });
    expect(inf.issues).toEqual([
      {
        severity: 'warning',
        message: "join: key type may mismatch: deptId ('string') vs code ('unknown')",
        column: 'deptId',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 直積ガード
// ---------------------------------------------------------------------------

const bigLeftSchema: Schema = {
  columns: [
    { name: 'k', type: 'string', nullable: false },
    { name: 'l', type: 'number', nullable: false },
  ],
};
const bigRightSchema: Schema = {
  columns: [
    { name: 'k', type: 'string', nullable: false },
    { name: 'r', type: 'number', nullable: false },
  ],
};
const bigKeys = [{ left: 'k', right: 'k' }];
const leftRows = (count: number, k = 'a'): Row[] => Array.from({ length: count }, (_, i) => ({ k, l: i }));
const rightRows = (count: number, k = 'a'): Row[] => Array.from({ length: count }, (_, i) => ({ k, r: i }));
const overflowMessage = `join: output exceeded ${MAX_JOIN_ROWS} rows; check join keys`;

describe('join: cartesian product guard', () => {
  it(`allows exactly ${MAX_JOIN_ROWS} output rows`, () => {
    const out = joinNode.execute(
      [
        { schema: bigLeftSchema, rows: leftRows(400) },
        { schema: bigRightSchema, rows: rightRows(250) },
      ],
      { mode: 'inner', keys: bigKeys },
    );
    expect(out.rows).toHaveLength(MAX_JOIN_ROWS);
  });

  it('stops the cartesian product as soon as the limit is exceeded', () => {
    const call = (): unknown =>
      joinNode.execute(
        [
          { schema: bigLeftSchema, rows: leftRows(400) },
          { schema: bigRightSchema, rows: rightRows(251) },
        ],
        { mode: 'inner', keys: bigKeys },
      );
    expect(call).toThrowError(SchemaError);
    expect(call).toThrowError(overflowMessage);
  });

  it('applies the limit while appending unmatched right rows', () => {
    const right = { schema: bigRightSchema, rows: [...rightRows(249), ...rightRows(401, 'b')] };
    expect(() =>
      joinNode.execute([{ schema: bigLeftSchema, rows: leftRows(400) }, right], { mode: 'full', keys: bigKeys }),
    ).toThrowError(overflowMessage);
  });

  it('applies the limit to unmatched left rows as well', () => {
    expect(() =>
      joinNode.execute(
        [
          { schema: bigLeftSchema, rows: leftRows(MAX_JOIN_ROWS + 1, 'x') },
          { schema: bigRightSchema, rows: rightRows(1) },
        ],
        { mode: 'left', keys: bigKeys },
      ),
    ).toThrowError(overflowMessage);
  });
});
