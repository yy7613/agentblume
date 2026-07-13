import { describe, expect, it } from 'vitest';
import { DATA_TYPES, cellText, coerceCell, coerceScalar, columnsText, parseColumns, parsePairs, parseReplaceRules, parseSortKeys, splitList } from './node-config-utils';

describe('node config utils', () => {
  it('normalizes comma-delimited values and scalar cell input', () => {
    expect(splitList(' id, name, , active ')).toEqual(['id', 'name', 'active']);
    expect(coerceScalar('42', 'number')).toBe(42);
    expect(coerceScalar('true', 'boolean')).toBe(true);
    expect(coerceScalar('FALSE', 'boolean')).toBe('FALSE');
    expect(coerceScalar('', 'number')).toBe('');
    expect(coerceCell('null', 'string')).toBeNull();
    expect(cellText(null)).toBe('null');
    expect(cellText(undefined)).toBe('');
  });

  it('parses advanced transform editors with type-aware replacement values', () => {
    expect(parsePairs(' old : new \n amount : number ', 'to')).toEqual([{ from: 'old', to: 'new' }, { from: 'amount', to: 'number' }]);
    expect(parsePairs(' amount : number ', 'type')).toEqual([{ column: 'amount', to: 'number' }]);
    expect(parseSortKeys('created_at:desc:last\nname:invalid:first')).toEqual([
      { column: 'created_at', direction: 'desc', nulls: 'last' },
      { column: 'name', nulls: 'first' },
    ]);
    expect(parseReplaceRules('amount:1:2\nactive:false:true\ncomment:null:done', [
      { name: 'amount', type: 'number', nullable: false },
      { name: 'active', type: 'boolean', nullable: false },
      { name: 'comment', type: 'string', nullable: true },
    ])).toEqual([
      { column: 'amount', from: 1, to: 2 },
      { column: 'active', from: false, to: true },
      { column: 'comment', from: null, to: 'done' },
    ]);
  });

  it('round-trips schema text and rejects incomplete or unsupported columns', () => {
    expect(DATA_TYPES).toContain('date');
    const schema = { columns: [{ name: 'id', type: 'number' as const, nullable: false }, { name: 'note', type: 'string' as const, nullable: true }] };
    expect(columnsText(schema)).toBe('id:number:required\nnote:string:optional');
    expect(parseColumns(columnsText(schema))).toEqual(schema.columns);
    expect(() => parseColumns(':string:required')).toThrow('列名が必要です');
    expect(() => parseColumns('id:uuid:required')).toThrow('未対応の型です');
    expect(() => parseColumns('id:string:maybe')).toThrow('required/optional');
  });
});
