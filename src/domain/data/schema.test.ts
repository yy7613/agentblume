import { describe, expect, it } from 'vitest';
import type { Cell, Row, Schema } from './types';
import {
  columnNames,
  findColumn,
  hasColumn,
  inferCellType,
  inferColumn,
  inferSchemaFromRows,
  unifyTypes,
} from './schema';

describe('inferCellType', () => {
  it('maps null to "null"', () => {
    expect(inferCellType(null)).toBe('null');
  });

  it('maps finite number to "number"', () => {
    expect(inferCellType(0)).toBe('number');
    expect(inferCellType(-3.14)).toBe('number');
    expect(inferCellType(42)).toBe('number');
  });

  it('maps NaN / Infinity to "unknown"', () => {
    expect(inferCellType(Number.NaN)).toBe('unknown');
    expect(inferCellType(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(inferCellType(Number.NEGATIVE_INFINITY)).toBe('unknown');
  });

  it('maps boolean to "boolean"', () => {
    expect(inferCellType(true)).toBe('boolean');
    expect(inferCellType(false)).toBe('boolean');
  });

  it('maps valid Date to "date"', () => {
    expect(inferCellType(new Date('2020-01-01T00:00:00Z'))).toBe('date');
  });

  it('maps Invalid Date to "unknown"', () => {
    expect(inferCellType(new Date('not-a-date'))).toBe('unknown');
  });

  it('maps string to "string"', () => {
    expect(inferCellType('hello')).toBe('string');
    expect(inferCellType('')).toBe('string');
  });
});

describe('findColumn / hasColumn / columnNames', () => {
  const schema: Schema = {
    columns: [
      { name: 'id', type: 'number', nullable: false },
      { name: 'name', type: 'string', nullable: true },
    ],
  };

  it('findColumn returns the matching column', () => {
    expect(findColumn(schema, 'name')).toEqual({
      name: 'name',
      type: 'string',
      nullable: true,
    });
  });

  it('findColumn returns undefined when absent', () => {
    expect(findColumn(schema, 'missing')).toBeUndefined();
  });

  it('hasColumn reflects presence', () => {
    expect(hasColumn(schema, 'id')).toBe(true);
    expect(hasColumn(schema, 'missing')).toBe(false);
  });

  it('columnNames returns names in declared order', () => {
    expect(columnNames(schema)).toEqual(['id', 'name']);
  });

  it('columnNames on empty schema returns []', () => {
    expect(columnNames({ columns: [] })).toEqual([]);
  });
});

describe('unifyTypes', () => {
  it('same type returns that type', () => {
    expect(unifyTypes('number', 'number')).toBe('number');
    expect(unifyTypes('string', 'string')).toBe('string');
    expect(unifyTypes('null', 'null')).toBe('null');
    expect(unifyTypes('unknown', 'unknown')).toBe('unknown');
  });

  it('one side unknown yields unknown', () => {
    expect(unifyTypes('unknown', 'number')).toBe('unknown');
    expect(unifyTypes('number', 'unknown')).toBe('unknown');
  });

  it('differing types yield unknown', () => {
    expect(unifyTypes('number', 'string')).toBe('unknown');
    expect(unifyTypes('boolean', 'date')).toBe('unknown');
    // 'null' treated as an ordinary type here (differs from 'number').
    expect(unifyTypes('null', 'number')).toBe('unknown');
  });
});

describe('inferColumn', () => {
  it('numbers only -> number / nullable:false', () => {
    expect(inferColumn('age', [1, 2, 3])).toEqual({
      name: 'age',
      type: 'number',
      nullable: false,
    });
  });

  it('with null mixed -> nullable:true, type from non-null values', () => {
    expect(inferColumn('age', [1, null, 3])).toEqual({
      name: 'age',
      type: 'number',
      nullable: true,
    });
  });

  it('mixed non-null types -> unknown', () => {
    expect(inferColumn('mix', [1, 'a', true])).toEqual({
      name: 'mix',
      type: 'unknown',
      nullable: false,
    });
  });

  it('empty array -> unknown / nullable:true', () => {
    expect(inferColumn('empty', [])).toEqual({
      name: 'empty',
      type: 'unknown',
      nullable: true,
    });
  });

  it('all null -> unknown / nullable:true', () => {
    expect(inferColumn('n', [null, null])).toEqual({
      name: 'n',
      type: 'unknown',
      nullable: true,
    });
  });

  it('single value -> that type / nullable:false', () => {
    expect(inferColumn('flag', [true])).toEqual({
      name: 'flag',
      type: 'boolean',
      nullable: false,
    });
  });

  it('NaN present makes the column unknown', () => {
    const values: Cell[] = [1, Number.NaN];
    expect(inferColumn('n', values)).toEqual({
      name: 'n',
      type: 'unknown',
      nullable: false,
    });
  });
});

describe('inferSchemaFromRows', () => {
  it('infers types and nullability from homogeneous rows', () => {
    const rows: Row[] = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ];
    expect(inferSchemaFromRows(rows)).toEqual({
      columns: [
        { name: 'id', type: 'number', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    });
  });

  it('empty rows -> empty schema', () => {
    expect(inferSchemaFromRows([])).toEqual({ columns: [] });
  });

  it('uses first-seen order for the key union across rows', () => {
    const rows: Row[] = [
      { b: 1, a: 2 },
      { c: 3, a: 4 },
    ];
    expect(columnNames(inferSchemaFromRows(rows))).toEqual(['b', 'a', 'c']);
  });

  it('missing key in some rows -> treated as null -> nullable:true', () => {
    const rows: Row[] = [{ id: 1, extra: 'x' }, { id: 2 }];
    const schema = inferSchemaFromRows(rows);
    expect(findColumn(schema, 'extra')).toEqual({
      name: 'extra',
      type: 'string',
      nullable: true,
    });
    expect(findColumn(schema, 'id')).toEqual({
      name: 'id',
      type: 'number',
      nullable: false,
    });
  });

  it('explicit null value is treated the same as missing key', () => {
    const rows: Row[] = [
      { id: 1, opt: null },
      { id: 2, opt: 5 },
    ];
    expect(findColumn(inferSchemaFromRows(rows), 'opt')).toEqual({
      name: 'opt',
      type: 'number',
      nullable: true,
    });
  });

  it('does not mutate the input rows', () => {
    const rows: Row[] = [{ id: 1 }, { id: 2, name: 'b' }];
    const snapshot = JSON.stringify(rows);
    inferSchemaFromRows(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});
