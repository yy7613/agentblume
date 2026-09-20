import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import { CASE_FOLD_OPS, FILTER_OPS, filterNode, operatorArgumentSummaries, ORDER_OPS, valueBindingsOf, VALUELESS_OPS } from './filter';

const schema: Schema = {
  columns: [
    { name: 'id', type: 'number', nullable: false },
    { name: 'name', type: 'string', nullable: true },
    { name: 'age', type: 'number', nullable: false },
    { name: 'joined', type: 'date', nullable: false },
    { name: 'active', type: 'boolean', nullable: false },
  ],
};

const d = (s: string): Date => new Date(s);

const table: Table = {
  schema,
  rows: [
    { id: 1, name: 'Alice', age: 30, joined: d('2020-01-01T00:00:00Z'), active: true },
    { id: 2, name: 'Bob', age: 17, joined: d('2021-06-01T00:00:00Z'), active: false },
    { id: 3, name: null, age: 40, joined: d('2019-03-15T00:00:00Z'), active: true },
  ],
};

describe('filter: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(filterNode.type).toBe('filter');
    expect(filterNode.kind).toBe('transform');
    expect(filterNode.inputArity).toBe(1);
  });
});

describe('filter: validateConfig', () => {
  it('accepts a valid config with value', () => {
    const cfg = filterNode.validateConfig({ column: 'age', op: 'gte', value: 18 });
    expect(cfg).toEqual({ column: 'age', op: 'gte', value: 18 });
  });

  it('accepts an Agent input binding while retaining a design-time sample value', () => {
    expect(filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'minimumAge' } })).toMatchObject({ valueBinding: { source: 'agent-input', field: 'minimumAge' } });
  });

  it('accepts a config without value (isNull)', () => {
    const cfg = filterNode.validateConfig({ column: 'name', op: 'isNull' });
    expect(cfg).toEqual({ column: 'name', op: 'isNull' });
  });

  it('throws ConfigError on an unknown op', () => {
    expect(() => filterNode.validateConfig({ column: 'age', op: 'between' })).toThrowError(
      ConfigError,
    );
  });

  it('throws ConfigError when column missing', () => {
    expect(() => filterNode.validateConfig({ op: 'eq' })).toThrowError(ConfigError);
  });

  it('keeps the legacy flat shape unchanged (saved Tools must not be rewritten)', () => {
    expect(filterNode.validateConfig({ column: 'name', op: 'contains', value: 'li' }))
      .toEqual({ column: 'name', op: 'contains', value: 'li' });
  });

  it('accepts the multi-condition shape and defaults combine to and', () => {
    expect(filterNode.validateConfig({ conditions: [{ column: 'age', op: 'gte', value: 18 }] }))
      .toEqual({ conditions: [{ column: 'age', op: 'gte', value: 18 }], combine: 'and' });
    expect(filterNode.validateConfig({
      conditions: [{ column: 'name', op: 'eq', value: 'Alice' }, { column: 'name', op: 'eq', value: 'Bob' }],
      combine: 'or',
    })).toMatchObject({ combine: 'or' });
  });

  it('accepts a per-condition Agent input binding', () => {
    expect(filterNode.validateConfig({
      conditions: [{ column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'minimumAge' } }],
      combine: 'and',
    })).toMatchObject({ conditions: [{ valueBinding: { source: 'agent-input', field: 'minimumAge' } }] });
  });

  it('rejects an empty conditions array, an unknown combine and an invalid condition', () => {
    expect(() => filterNode.validateConfig({ conditions: [], combine: 'and' })).toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ conditions: [{ column: 'age', op: 'eq' }], combine: 'xor' })).toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ conditions: [{ op: 'eq' }] })).toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ conditions: 'age' })).toThrowError(ConfigError);
  });

  it('keeps the runtime skip marker for both shapes', () => {
    expect(filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, disabled: true }))
      .toEqual({ column: 'age', op: 'gte', value: 18, disabled: true });
    expect(filterNode.validateConfig({ conditions: [{ column: 'age', op: 'gte', value: 18, disabled: false }] }))
      .toEqual({ conditions: [{ column: 'age', op: 'gte', value: 18, disabled: false }], combine: 'and' });
    expect(() => filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, disabled: 'yes' })).toThrowError(ConfigError);
  });

  it('keeps the Zod detail in the message for both shapes (no union collapse)', () => {
    expect(() => filterNode.validateConfig({ column: 'age', op: 'between' })).toThrowError(/op: Invalid option/);
    expect(() => filterNode.validateConfig({ conditions: [{ column: 'age', op: 'between' }] }))
      .toThrowError(/conditions\.0\.op: Invalid option/);
  });

  it('accepts an operator binding with and without an allowed list', () => {
    expect(filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp' } }))
      .toMatchObject({ opBinding: { source: 'agent-input', field: 'ageOp' } });
    expect(filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lt'] } }))
      .toMatchObject({ opBinding: { allowed: ['gte', 'lt'] } });
  });

  it('rejects an empty allowed list and an unknown operator inside allowed', () => {
    expect(() => filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: [] } }))
      .toThrowError(ConfigError);
    expect(() => filterNode.validateConfig({ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'between'] } }))
      .toThrowError(ConfigError);
  });

  it('accepts a per-condition operator binding in the conditions shape', () => {
    expect(filterNode.validateConfig({
      conditions: [{ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] } }],
      combine: 'and',
    })).toMatchObject({ conditions: [{ opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] } }] });
  });

  it('accepts caseInsensitive in both shapes and rejects a non-boolean', () => {
    expect(filterNode.validateConfig({ column: 'name', op: 'eq', value: 'a', caseInsensitive: true }))
      .toMatchObject({ caseInsensitive: true });
    expect(filterNode.validateConfig({ conditions: [{ column: 'name', op: 'contains', value: 'a', caseInsensitive: false }], combine: 'or' }))
      .toMatchObject({ conditions: [{ caseInsensitive: false }] });
    expect(() => filterNode.validateConfig({ column: 'name', op: 'eq', value: 'a', caseInsensitive: 'yes' }))
      .toThrowError(ConfigError);
  });
});

describe('filter: inferSchema', () => {
  it('valid op on existing column -> confirmed, schema unchanged', () => {
    const inf = filterNode.inferSchema([schema], { column: 'age', op: 'gte', value: 18 });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    expect(inf.schema).toEqual(schema);
  });

  it('missing column -> mismatch with error', () => {
    const inf = filterNode.inferSchema([schema], { column: 'nope', op: 'eq', value: 1 });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.column).toBe('nope');
  });

  it('order op on non-number/date column -> mismatch (type error)', () => {
    const inf = filterNode.inferSchema([schema], { column: 'name', op: 'gt', value: 'x' });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.message).toContain('number|date');
  });

  it('order op on date column -> confirmed', () => {
    const inf = filterNode.inferSchema([schema], {
      column: 'joined',
      op: 'lt',
      value: d('2020-06-01T00:00:00Z'),
    });
    expect(inf.state).toBe('confirmed');
  });

  it('order op on boolean column -> mismatch', () => {
    const inf = filterNode.inferSchema([schema], { column: 'active', op: 'gte', value: true });
    expect(inf.state).toBe('mismatch');
  });

  it('contains on string column (non-order op) -> confirmed', () => {
    const inf = filterNode.inferSchema([schema], { column: 'name', op: 'contains', value: 'li' });
    expect(inf.state).toBe('confirmed');
  });

  it('multi-condition: all valid -> confirmed, schema unchanged', () => {
    const inf = filterNode.inferSchema([schema], {
      conditions: [{ column: 'name', op: 'eq', value: 'Alice' }, { column: 'age', op: 'gte', value: 18 }],
      combine: 'or',
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.schema).toEqual(schema);
  });

  it('multi-condition: collects one issue per bad condition', () => {
    const inf = filterNode.inferSchema([schema], {
      conditions: [{ column: 'nope', op: 'eq', value: 1 }, { column: 'name', op: 'gt', value: 'x' }, { column: 'age', op: 'gte', value: 1 }],
      combine: 'and',
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(2);
    expect(inf.issues[0]?.column).toBe('nope');
    expect(inf.issues[1]?.message).toContain('number|date');
  });

  it('multi-condition without combine behaves like and', () => {
    expect(filterNode.inferSchema([schema], { conditions: [{ column: 'age', op: 'gte', value: 1 }] }).state).toBe('confirmed');
  });

  it('missing input is treated as an empty schema', () => {
    expect(filterNode.inferSchema([], { column: 'age', op: 'eq', value: 1 }).state).toBe('mismatch');
  });

  it('disabled conditions are inspected as if they did not exist', () => {
    // 単独（フラット）で disabled: 列が無くても mismatch にしない。
    expect(filterNode.inferSchema([schema], { column: 'nope', op: 'eq', value: 1, disabled: true }))
      .toEqual({ schema, state: 'confirmed', issues: [] });
    // conditions 形式でも disabled の条件だけ検査対象から外れる。
    const inf = filterNode.inferSchema([schema], {
      conditions: [{ column: 'nope', op: 'eq', value: 1, disabled: true }, { column: 'age', op: 'gte', value: 18 }],
      combine: 'and',
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
    // 全条件が disabled でもスキーマは不変のまま confirmed。
    expect(filterNode.inferSchema([schema], {
      conditions: [{ column: 'nope', op: 'gt', value: 1, disabled: true }],
      combine: 'or',
    })).toEqual({ schema, state: 'confirmed', issues: [] });
  });

  it('disabled: false is still inspected (backward compatible with an explicit marker)', () => {
    expect(filterNode.inferSchema([schema], { column: 'nope', op: 'eq', value: 1, disabled: false }).state).toBe('mismatch');
  });

  it('opBinding without allowed on a string column -> error (any order op could be picked at runtime)', () => {
    const inf = filterNode.inferSchema([schema], {
      column: 'name', op: 'eq', value: 'Alice',
      opBinding: { source: 'agent-input', field: 'nameOp' },
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.message).toContain('restrict opBinding.allowed');
  });

  it('opBinding on a string column restricted to non-order ops -> confirmed', () => {
    const inf = filterNode.inferSchema([schema], {
      column: 'name', op: 'eq', value: 'Alice',
      opBinding: { source: 'agent-input', field: 'nameOp', allowed: ['eq', 'contains'] },
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
  });

  it('opBinding allowing order ops on a number column -> confirmed', () => {
    const inf = filterNode.inferSchema([schema], {
      column: 'age', op: 'gte', value: 18,
      opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] },
    });
    expect(inf.state).toBe('confirmed');
    expect(inf.issues).toEqual([]);
  });

  it('design-time op outside opBinding.allowed -> error (it is the runtime fallback)', () => {
    const inf = filterNode.inferSchema([schema], {
      column: 'age', op: 'eq', value: 18,
      opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] },
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues[0]?.severity).toBe('error');
    expect(inf.issues[0]?.message).toContain('is not in opBinding.allowed');
  });

  it('static order-op error merges into the opBinding orderable error when they share a root cause', () => {
    // string 列に op:'gte' + allowed 省略（全演算子）: 静的 op エラーは orderable エラーと同根なので1件に統合される。
    const inf = filterNode.inferSchema([schema], {
      column: 'name', op: 'gte', value: 'x',
      opBinding: { source: 'agent-input', field: 'nameOp' },
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(1);
    expect(inf.issues[0]?.message).toContain('restrict opBinding.allowed');
  });

  it('op outside a non-orderable allowed on a string column -> static error plus allowed error (2 issues)', () => {
    // allowed:['eq'] は orderable を許さないため orderable エラーは出ない。静的 op エラーと
    // 「not in allowed」エラーは別根なので両方残る。
    const inf = filterNode.inferSchema([schema], {
      column: 'name', op: 'gte', value: 'x',
      opBinding: { source: 'agent-input', field: 'nameOp', allowed: ['eq'] },
    });
    expect(inf.state).toBe('mismatch');
    expect(inf.issues).toHaveLength(2);
    expect(inf.issues[0]?.message).toContain("operator 'gte' requires column type number|date");
    expect(inf.issues[1]?.message).toContain('is not in opBinding.allowed');
  });
});

describe('filter: exported operator sets', () => {
  it('VALUELESS_OPS is exactly isNull/notNull', () => {
    expect([...VALUELESS_OPS].sort()).toEqual(['isNull', 'notNull']);
  });

  it('ORDER_OPS is exactly gt/gte/lt/lte', () => {
    expect([...ORDER_OPS].sort()).toEqual(['gt', 'gte', 'lt', 'lte']);
  });

  it('CASE_FOLD_OPS is exactly eq/neq/contains', () => {
    expect([...CASE_FOLD_OPS].sort()).toEqual(['contains', 'eq', 'neq']);
  });

  it('all sets contain only canonical FILTER_OPS entries', () => {
    for (const op of [...VALUELESS_OPS, ...ORDER_OPS, ...CASE_FOLD_OPS]) expect(FILTER_OPS).toContain(op);
  });
});

describe('filter: valueBindingsOf', () => {
  it('collects the binding from the legacy flat shape', () => {
    expect(valueBindingsOf({ column: 'age', op: 'gte', value: 18, valueBinding: { source: 'agent-input', field: 'minimumAge' } }))
      .toEqual([{ field: 'minimumAge', column: 'age' }]);
  });

  it('collects every binding from the conditions shape in order', () => {
    expect(valueBindingsOf({ conditions: [
      { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'region' } },
      { column: 'age', op: 'gte', value: 18 },
      { column: 'month', op: 'eq', value: '2026-05', valueBinding: { source: 'agent-input', field: 'month' } },
    ], combine: 'and' })).toEqual([
      { field: 'region', column: 'region' },
      { field: 'month', column: 'month' },
    ]);
  });

  it('ignores malformed bindings and tolerates a missing column', () => {
    expect(valueBindingsOf({ column: 'age', op: 'gte' })).toEqual([]);
    expect(valueBindingsOf({ column: 'age', op: 'gte', valueBinding: { source: 'other', field: 'x' } })).toEqual([]);
    expect(valueBindingsOf({ column: 'age', op: 'gte', valueBinding: { source: 'agent-input', field: 42 } })).toEqual([]);
    expect(valueBindingsOf({ column: 'age', op: 'gte', valueBinding: { source: 'agent-input', field: '' } })).toEqual([]);
    expect(valueBindingsOf(null)).toEqual([]);
    // 条件が null・column 欠損でも落ちずに拾えるものだけ拾う（column は空文字で表す）。
    expect(valueBindingsOf({ conditions: [null, { valueBinding: { source: 'agent-input', field: 'x' } }] }))
      .toEqual([{ field: 'x', column: '' }]);
  });
});

describe('filter: operatorArgumentSummaries', () => {
  it('aggregates one summary per field with the FILTER_OPS-ordered intersection of allowed lists', () => {
    const summaries = operatorArgumentSummaries([
      { column: 'note', op: 'eq', value: 'paid', opBinding: { source: 'agent-input', field: 'textOp', allowed: ['contains', 'neq', 'eq'] } },
      { conditions: [
        { column: 'category', op: 'eq', value: 'gold', opBinding: { source: 'agent-input', field: 'textOp', allowed: ['isNull', 'eq', 'neq'] } },
      ], combine: 'and' },
    ]);
    expect(summaries).toEqual([{ field: 'textOp', columns: ['note', 'category'], allowed: ['eq', 'neq'], defaultOp: 'eq', defaultOpMixed: false }]);
  });

  it('omitting allowed expands to every operator', () => {
    expect(operatorArgumentSummaries([{ column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp' } }]))
      .toEqual([{ field: 'ageOp', columns: ['age'], allowed: [...FILTER_OPS], defaultOp: 'gte', defaultOpMixed: false }]);
  });

  it('deduplicates columns and drops empty column names', () => {
    const summaries = operatorArgumentSummaries([
      { conditions: [
        { column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] } },
        { column: 'age', op: 'gte', value: 65, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] } },
        { op: 'gte', opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte'] } },
      ], combine: 'or' },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.columns).toEqual(['age']);
    expect(summaries[0]?.allowed).toEqual(['gte']);
  });

  it('an empty intersection stays representable (allowed: []) so save-time validation can reject it', () => {
    const summaries = operatorArgumentSummaries([
      { column: 'note', op: 'eq', value: 'a', opBinding: { source: 'agent-input', field: 'textOp', allowed: ['eq'] } },
      { column: 'category', op: 'neq', value: 'b', opBinding: { source: 'agent-input', field: 'textOp', allowed: ['neq'] } },
    ]);
    expect(summaries[0]?.allowed).toEqual([]);
    expect(summaries[0]?.defaultOp).toBeUndefined();
    expect(summaries[0]?.defaultOpMixed).toBe(true);
  });

  it('sanitizes unknown operators inside allowed before intersecting', () => {
    const summaries = operatorArgumentSummaries([
      { column: 'note', op: 'eq', value: 'a', opBinding: { source: 'agent-input', field: 'textOp', allowed: ['eq', 'between'] } },
    ]);
    expect(summaries[0]?.allowed).toEqual(['eq']);
  });

  it('mixed default operators set defaultOpMixed and omit defaultOp', () => {
    const summaries = operatorArgumentSummaries([
      { column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] } },
      { column: 'age', op: 'lte', value: 65, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte', 'lte'] } },
    ]);
    expect(summaries[0]?.defaultOp).toBeUndefined();
    expect(summaries[0]?.defaultOpMixed).toBe(true);
  });

  it('keeps separate fields as separate summaries and ignores conditions without an opBinding', () => {
    const summaries = operatorArgumentSummaries([
      { conditions: [
        { column: 'age', op: 'gte', value: 18, opBinding: { source: 'agent-input', field: 'ageOp', allowed: ['gte'] } },
        { column: 'name', op: 'eq', value: 'Alice' },
        { column: 'name', op: 'eq', value: 'Alice', opBinding: { source: 'agent-input', field: 'nameOp', allowed: ['eq', 'contains'] } },
      ], combine: 'and' },
    ]);
    expect(summaries.map((summary) => summary.field)).toEqual(['ageOp', 'nameOp']);
  });
});

describe('filter: execute', () => {
  it('gte on number keeps matching rows', () => {
    const out = filterNode.execute([table], { column: 'age', op: 'gte', value: 18 });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
    expect(out.schema).toBe(table.schema);
  });

  it('gt / lt / lte on number', () => {
    expect(
      filterNode.execute([table], { column: 'age', op: 'gt', value: 30 }).rows.map((r) => r.id),
    ).toEqual([3]);
    expect(
      filterNode.execute([table], { column: 'age', op: 'lt', value: 30 }).rows.map((r) => r.id),
    ).toEqual([2]);
    expect(
      filterNode.execute([table], { column: 'age', op: 'lte', value: 30 }).rows.map((r) => r.id),
    ).toEqual([1, 2]);
  });

  it('eq / neq exact equality', () => {
    expect(
      filterNode.execute([table], { column: 'id', op: 'eq', value: 2 }).rows.map((r) => r.id),
    ).toEqual([2]);
    expect(
      filterNode.execute([table], { column: 'id', op: 'neq', value: 2 }).rows.map((r) => r.id),
    ).toEqual([1, 3]);
  });

  it('eq on Date compares by time value', () => {
    const out = filterNode.execute([table], {
      column: 'joined',
      op: 'eq',
      value: d('2020-01-01T00:00:00Z'),
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('lt/gt on Date compares chronologically', () => {
    const out = filterNode.execute([table], {
      column: 'joined',
      op: 'lt',
      value: d('2020-06-01T00:00:00Z'),
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('contains stringifies both operands', () => {
    const out = filterNode.execute([table], { column: 'name', op: 'contains', value: 'li' });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('contains against null cell -> String(null) has no match unless value in "null"', () => {
    // row id:3 has name null -> String(null) === 'null'
    const out = filterNode.execute([table], { column: 'name', op: 'contains', value: 'ul' });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });

  it('isNull keeps rows where cell is null', () => {
    const out = filterNode.execute([table], { column: 'name', op: 'isNull' });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });

  it('caseInsensitive eq/neq folds both string operands (default remains exact-case)', () => {
    expect(filterNode.execute([table], { column: 'name', op: 'eq', value: 'alice' }).rows).toEqual([]);
    expect(
      filterNode.execute([table], { column: 'name', op: 'eq', value: 'alice', caseInsensitive: true }).rows.map((r) => r.id),
    ).toEqual([1]);
    // null セルは string ではないので折り畳み対象外（=== 比較のまま非一致 → neq は残す）。
    expect(
      filterNode.execute([table], { column: 'name', op: 'neq', value: 'ALICE', caseInsensitive: true }).rows.map((r) => r.id),
    ).toEqual([2, 3]);
  });

  it('caseInsensitive contains folds after stringification', () => {
    expect(filterNode.execute([table], { column: 'name', op: 'contains', value: 'AL' }).rows).toEqual([]);
    expect(
      filterNode.execute([table], { column: 'name', op: 'contains', value: 'AL', caseInsensitive: true }).rows.map((r) => r.id),
    ).toEqual([1]);
  });

  it('caseInsensitive does not affect number or Date comparison', () => {
    expect(
      filterNode.execute([table], { column: 'id', op: 'eq', value: 2, caseInsensitive: true }).rows.map((r) => r.id),
    ).toEqual([2]);
    expect(
      filterNode.execute([table], { column: 'joined', op: 'eq', value: d('2020-01-01T00:00:00Z'), caseInsensitive: true }).rows.map((r) => r.id),
    ).toEqual([1]);
  });

  it('caseInsensitive works inside the conditions shape', () => {
    const out = filterNode.execute([table], { conditions: [
      { column: 'name', op: 'eq', value: 'BOB', caseInsensitive: true },
    ], combine: 'and' });
    expect(out.rows.map((r) => r.id)).toEqual([2]);
  });

  it('notNull keeps rows where cell is not null', () => {
    const out = filterNode.execute([table], { column: 'name', op: 'notNull' });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('order comparison with non-comparable value yields no rows', () => {
    // value undefined -> null -> NaN comparable -> excluded.
    const out = filterNode.execute([table], { column: 'age', op: 'gt' });
    expect(out.rows).toEqual([]);
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(table.rows.map((r) => ({ ...r, joined: undefined })));
    filterNode.execute([table], { column: 'age', op: 'gte', value: 18 });
    expect(JSON.stringify(table.rows.map((r) => ({ ...r, joined: undefined })))).toBe(snapshot);
  });

  it('combine:or keeps rows matching any condition (Tokyo or Osaka)', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'name', op: 'eq', value: 'Alice' }, { column: 'name', op: 'eq', value: 'Bob' }],
      combine: 'or',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('combine:and requires every condition', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'age', op: 'gte', value: 18 }, { column: 'active', op: 'eq', value: true }],
      combine: 'and',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('conditions without combine default to and', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'age', op: 'gte', value: 18 }, { column: 'name', op: 'notNull' }],
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('a single condition behaves exactly like the legacy flat config', () => {
    const legacy = filterNode.execute([table], { column: 'age', op: 'gte', value: 18 });
    const wrapped = filterNode.execute([table], { conditions: [{ column: 'age', op: 'gte', value: 18 }], combine: 'or' });
    expect(wrapped.rows).toEqual(legacy.rows);
  });

  it('missing column in one condition simply matches nothing (null cell)', () => {
    const out = filterNode.execute([table], {
      conditions: [{ column: 'ghost', op: 'isNull' }, { column: 'age', op: 'gte', value: 40 }],
      combine: 'and',
    });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });

  it('missing input is treated as an empty table', () => {
    expect(filterNode.execute([], { column: 'age', op: 'gte', value: 1 })).toEqual({ schema: { columns: [] }, rows: [] });
  });

  it('a disabled flat condition passes every row through unchanged', () => {
    const out = filterNode.execute([table], { column: 'age', op: 'gte', value: 40, disabled: true });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.schema).toBe(table.schema);
    expect(out.rows).not.toBe(table.rows);
  });

  it('combine:and evaluates only the conditions that are not disabled', () => {
    const out = filterNode.execute([table], {
      conditions: [
        { column: 'name', op: 'eq', value: 'Alice', disabled: true },
        { column: 'age', op: 'gte', value: 18 },
      ],
      combine: 'and',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('combine:or evaluates only the conditions that are not disabled', () => {
    const out = filterNode.execute([table], {
      conditions: [
        { column: 'name', op: 'eq', value: 'Alice' },
        { column: 'name', op: 'eq', value: 'Bob', disabled: true },
      ],
      combine: 'or',
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it.each(['and', 'or'] as const)('all conditions disabled -> pass-through (%s)', (combine) => {
    const out = filterNode.execute([table], {
      conditions: [
        { column: 'name', op: 'eq', value: 'Alice', disabled: true },
        { column: 'age', op: 'gte', value: 40, disabled: true },
      ],
      combine,
    });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(out.schema).toBe(table.schema);
  });

  it('disabled: false keeps the condition active (backward compatible)', () => {
    const out = filterNode.execute([table], { column: 'age', op: 'gte', value: 40, disabled: false });
    expect(out.rows.map((r) => r.id)).toEqual([3]);
  });
});

/**
 * 日付列の比較値を ISO 文字列で書ける（保存済み config は JSON なので Date リテラルを持てず、
 * Agent Tool の引数も文字列で届く）。修正前はここが NaN 比較になり、エラー無しで 0 行だった。
 */
describe('filter: 日付列のISO文字列', () => {
  const isoTable: Table = table;

  it.each([
    ['gte', '2020-01-01', [1, 2]],
    ['gt', '2020-01-01', [2]],
    ['lte', '2020-01-01', [1, 3]],
    ['lt', '2020-01-01', [3]],
    ['eq', '2020-01-01', [1]],
    ['neq', '2020-01-01', [2, 3]],
  ] as const)('正常: %s に ISO 日付文字列を渡すと Date と同じ結果になる', (op, value, expected) => {
    const out = filterNode.execute([isoTable], { column: 'joined', op, value });
    expect(out.rows.map((row) => row.id)).toEqual(expected);
    // Date で書いた場合と1行もずれない。
    expect(out.rows).toEqual(filterNode.execute([isoTable], { column: 'joined', op, value: d(`${value}T00:00:00Z`) }).rows);
  });

  it('正常: 日時（時刻つき）の ISO 文字列も解釈する', () => {
    const out = filterNode.execute([isoTable], { column: 'joined', op: 'gte', value: '2021-06-01T00:00:00.000Z' });
    expect(out.rows.map((row) => row.id)).toEqual([2]);
  });

  it('正常: エージェント引数（valueBinding）で届いた文字列も同じ規則で日付になる', () => {
    // 実行時に application 層が value を実引数へ差し替えた形（binding は残る）。
    const out = filterNode.execute([isoTable], {
      column: 'joined', op: 'gte', value: '2021-01-01',
      valueBinding: { source: 'agent-input', field: 'since' },
    });
    expect(out.rows.map((row) => row.id)).toEqual([2]);
  });

  it('境界: 複数条件の範囲指定（gte + lte）が ISO 文字列だけで成立する', () => {
    const out = filterNode.execute([isoTable], {
      conditions: [
        { column: 'joined', op: 'gte', value: '2019-06-01' },
        { column: 'joined', op: 'lte', value: '2020-12-31' },
      ],
      combine: 'and',
    });
    expect(out.rows.map((row) => row.id)).toEqual([1]);
  });

  it('境界: スキーマが型を持たない（unknown）列でもセルが Date なら日付として比べる', () => {
    const loose: Table = {
      schema: { columns: [{ name: 'joined', type: 'unknown', nullable: false }] },
      rows: [{ joined: d('2020-01-01T00:00:00Z') }, { joined: d('2018-01-01T00:00:00Z') }],
    };
    const out = filterNode.execute([loose], { column: 'joined', op: 'gte', value: '2019-01-01' });
    expect(out.rows).toHaveLength(1);
  });

  it('境界: contains は文字列包含のままで日付として解釈しない（従来どおり）', () => {
    const out = filterNode.execute([isoTable], { column: 'joined', op: 'contains', value: '2020' });
    expect(out.rows.map((row) => row.id)).toEqual([1]);
  });

  it('境界: 従来どおり — 文字列列の比較は日付らしい値でも文字列のまま（日付化しない）', () => {
    const texts: Table = {
      schema: { columns: [{ name: 'when', type: 'string', nullable: false }] },
      rows: [{ when: '2020-01-01' }, { when: '2020-01-02' }],
    };
    const out = filterNode.execute([texts], { column: 'when', op: 'eq', value: '2020-01-01' });
    expect(out.rows).toEqual([{ when: '2020-01-01' }]);
  });

  it('異常: 日付として読めない文字列は inferSchema が error issue にする', () => {
    const inference = filterNode.inferSchema([schema], { column: 'joined', op: 'gte', value: '2020/01/01' });
    expect(inference.state).toBe('mismatch');
    expect(inference.issues).toEqual([
      { severity: 'error', message: "filter: value for date column 'joined' must be an ISO date (YYYY-MM-DD): 2020/01/01", column: 'joined' },
    ]);
  });

  it('境界: 従来どおり — 読める ISO 文字列なら inferSchema は issue を出さない（誤検知しない）', () => {
    expect(filterNode.inferSchema([schema], { column: 'joined', op: 'gte', value: '2020-01-01' })).toEqual({ schema, state: 'confirmed', issues: [] });
  });

  it('例外: 日付として読めない文字列は execute で SchemaError（黙って0行にしない）', () => {
    expect(() => filterNode.execute([isoTable], { column: 'joined', op: 'gte', value: '昨日' }))
      .toThrowError(new SchemaError("filter: value for date column 'joined' must be an ISO date (YYYY-MM-DD): 昨日"));
  });

  it('例外: 月が範囲外（13月）の ISO 風文字列も読めない値として SchemaError', () => {
    // `2020-02-30` のような「桁は正しいが実在しない日」は JS が 3/1 へ繰り上げる（csv-source の date 化と同じ挙動）。
    expect(() => filterNode.execute([isoTable], { column: 'joined', op: 'eq', value: '2020-13-01' })).toThrowError(SchemaError);
  });
});
