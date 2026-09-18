import { describe, expect, it } from 'vitest';
import { ToolCheckValidationError } from './errors';
import { deserializeToolCheckCase, serializeToolCheckCase } from './serialization';
import { createToolCheckCase, type ToolCheckCase } from './tool-check-case';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-12T00:00:00.000Z';

function full(): ToolCheckCase {
  return createToolCheckCase({
    scope, id: 'case-1', toolId: 'sales-tool', toolVersion: '1.2.0', name: 'Tokyo sales',
    arguments: { region: 'Tokyo', minimum: 10, active: true, note: null },
    expectations: { rowCount: { op: 'gte', value: 1 }, columns: ['region', 'amount'], cells: [{ column: 'region', op: 'eq', value: 'Tokyo', mode: 'all' }, { column: 'amount', op: 'gte', value: 0, mode: 'any' }], maxDurationMs: 5000, outcome: 'success' },
    lastResult: { status: 'failed', checkedAt: at, toolVersion: '1.2.0', summary: 'failed 1/4: row count >= 1 → row count 0' },
    createdAt: at, updatedAt: at,
  });
}

function minimal(): ToolCheckCase {
  return createToolCheckCase({ scope, id: 'case-2', toolId: 'sales-tool', name: 'latest', arguments: {}, expectations: {}, createdAt: at, updatedAt: at });
}

describe('serializeToolCheckCase / deserializeToolCheckCase', () => {
  it('正常: lastResult と全期待を持つケースが JSON 経由で往復する', () => {
    const item = full();
    const restored = deserializeToolCheckCase(JSON.parse(JSON.stringify(serializeToolCheckCase(item))));
    expect(restored).toEqual(item);
  });

  it('正常: toolVersion / lastResult / 期待なしの最小ケースも往復し、省略キーは現れない', () => {
    const item = minimal();
    const serialized = serializeToolCheckCase(item);
    expect('toolVersion' in serialized).toBe(false);
    expect('lastResult' in serialized).toBe(false);
    expect(serialized.expectations).toEqual({});
    expect(deserializeToolCheckCase(JSON.parse(JSON.stringify(serialized)))).toEqual(item);
  });

  it("正常: outcome 'error' の異常系ケースも往復し、省略時はキーが現れない", () => {
    const item = createToolCheckCase({ scope, id: 'case-3', toolId: 'sales-tool', name: 'rejects', arguments: { region: 1 }, expectations: { outcome: 'error' }, createdAt: at, updatedAt: at });
    const serialized = serializeToolCheckCase(item);
    expect(serialized.expectations).toEqual({ outcome: 'error' });
    expect(deserializeToolCheckCase(JSON.parse(JSON.stringify(serialized)))).toEqual(item);
    expect('outcome' in serializeToolCheckCase(minimal()).expectations).toBe(false);
  });

  it('異常: 保存データの outcome が success / error 以外なら ToolCheckValidationError（パス付き）', () => {
    const broken = { ...serializeToolCheckCase(minimal()), expectations: { outcome: 'skipped' } };
    expect(() => deserializeToolCheckCase(broken)).toThrow(ToolCheckValidationError);
    expect(() => deserializeToolCheckCase(broken)).toThrow('expectations.outcome');
  });

  it('境界: 直列化結果は元と参照を共有しない（あとで元を変えても影響しない）', () => {
    const item = full();
    const serialized = serializeToolCheckCase(item);
    expect(serialized.arguments).not.toBe(item.arguments);
    expect(serialized.expectations.columns).not.toBe(item.expectations.columns);
    expect(serialized.expectations.cells?.[0]).not.toBe(item.expectations.cells?.[0]);
    expect(serialized.lastResult).not.toBe(item.lastResult);
  });

  it('境界: 未知の余分なキーは読み捨てる（新しいコードが書いたデータを古いコードが読める）', () => {
    const serialized = { ...serializeToolCheckCase(full()), futureField: 'x', expectations: { rowCount: { op: 'eq', value: 1 }, unknownExpectation: true } };
    const restored = deserializeToolCheckCase(serialized);
    expect(restored.expectations).toEqual({ rowCount: { op: 'eq', value: 1 } });
    expect('futureField' in restored).toBe(false);
  });

  it('異常: 形の壊れた JSON は ToolCheckValidationError（問題のパスを含む）', () => {
    expect(() => deserializeToolCheckCase({ ...serializeToolCheckCase(full()), arguments: { a: { nested: true } } })).toThrow(ToolCheckValidationError);
    expect(() => deserializeToolCheckCase({ ...serializeToolCheckCase(full()), name: 42 })).toThrow('deserializeToolCheckCase: invalid SerializedToolCheckCase: name:');
    expect(() => deserializeToolCheckCase('not an object')).toThrow(ToolCheckValidationError);
  });

  it('例外: 形は合っていても不変条件を破る保存データは createToolCheckCase の検証で落ちる', () => {
    expect(() => deserializeToolCheckCase({ ...serializeToolCheckCase(full()), name: '' })).toThrow('createToolCheckCase: name must be a non-empty string');
    expect(() => deserializeToolCheckCase({ ...serializeToolCheckCase(full()), expectations: { rowCount: { op: 'eq', value: -1 } } })).toThrow('createToolCheckCase: expectations.rowCount.value must be a non-negative integer');
  });
});

/** 行の特定・AI 判定の期待を持つケース（rows / judgments の往復用）。 */
function judged(): ToolCheckCase {
  return createToolCheckCase({
    scope, id: 'case-4', toolId: 'expense-tool', name: 'judged rows', arguments: { month: '2026-09' },
    expectations: {
      rows: [
        { where: { column: 'id', value: 'E1' }, cells: [{ column: 'amount', op: 'gte', value: 10000 }, { column: 'note', op: 'contains', value: '交通費' }] },
        { where: { column: 'id', value: 'E2' }, present: false },
        { where: { column: 'seq', value: 3 }, present: true },
      ],
      judgments: [
        { nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes', 'unclear'] },
        { nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'], reasonContains: '規程' },
      ],
    },
    createdAt: at, updatedAt: at,
  });
}

describe('serializeToolCheckCase / deserializeToolCheckCase: rows と judgments', () => {
  it('正常: 行の特定（present:false を含む）と AI 判定（reasonContains を含む）の期待が JSON 経由で往復する', () => {
    const item = judged();
    const restored = deserializeToolCheckCase(JSON.parse(JSON.stringify(serializeToolCheckCase(item))));
    expect(restored).toEqual(item);
    expect(restored.expectations.rows?.[1]?.present).toBe(false);
    expect(restored.expectations.judgments?.[1]?.reasonContains).toBe('規程');
  });

  it('境界: present / reasonContains を省いたケースでは、直列化した形にもキーが現れない', () => {
    const serialized = serializeToolCheckCase(judged());
    // キーが「無い」だけでは旧コード（rows を写さない）でも通るので、写されていること自体も固定する。
    expect(serialized.expectations.rows).toHaveLength(judged().expectations.rows?.length ?? -1);
    expect(serialized.expectations.judgments).toHaveLength(judged().expectations.judgments?.length ?? -1);
    expect('present' in (serialized.expectations.rows?.[0] ?? {})).toBe(false);
    expect('cells' in (serialized.expectations.rows?.[1] ?? {})).toBe(false);
    expect('reasonContains' in (serialized.expectations.judgments?.[0] ?? {})).toBe(false);
    expect('rows' in serializeToolCheckCase(minimal()).expectations).toBe(false);
    expect('judgments' in serializeToolCheckCase(minimal()).expectations).toBe(false);
  });

  it('境界: 直列化結果は元と参照を共有しない（rows / judgments の入れ子まで複製する）', () => {
    const item = judged();
    const serialized = serializeToolCheckCase(item);
    expect(serialized.expectations.rows).not.toBe(item.expectations.rows);
    expect(serialized.expectations.rows?.[0]).not.toBe(item.expectations.rows?.[0]);
    expect(serialized.expectations.rows?.[0]?.where).not.toBe(item.expectations.rows?.[0]?.where);
    expect(serialized.expectations.rows?.[0]?.cells?.[0]).not.toBe(item.expectations.rows?.[0]?.cells?.[0]);
    expect(serialized.expectations.judgments).not.toBe(item.expectations.judgments);
    expect(serialized.expectations.judgments?.[0]).not.toBe(item.expectations.judgments?.[0]);
    expect(serialized.expectations.judgments?.[0]?.where).not.toBe(item.expectations.judgments?.[0]?.where);
    expect(serialized.expectations.judgments?.[0]?.verdict).not.toBe(item.expectations.judgments?.[0]?.verdict);
    expect(serialized.expectations.rows).toEqual(item.expectations.rows);
    expect(serialized.expectations.judgments).toEqual(item.expectations.judgments);
  });

  it('境界: rows / judgments の未知のキーは読み捨てる（新しいコードが書いたデータを古いコードが読める）', () => {
    const serialized = {
      ...serializeToolCheckCase(judged()),
      expectations: {
        rows: [{ where: { column: 'id', value: 'E1', hint: 'x' }, present: true, mode: 'first', cells: [{ column: 'amount', op: 'gte', value: 1, tolerance: 2 }] }],
        judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'], confidence: 0.5 }],
      },
    };
    const restored = deserializeToolCheckCase(serialized);
    expect(restored.expectations).toEqual({
      rows: [{ where: { column: 'id', value: 'E1' }, present: true, cells: [{ column: 'amount', op: 'gte', value: 1 }] }],
      judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }],
    });
  });

  it('異常: 保存データの rows / judgments が形を破っていれば ToolCheckValidationError（パス付き）', () => {
    const base = serializeToolCheckCase(judged());
    expect(() => deserializeToolCheckCase({ ...base, expectations: { rows: [{ where: { column: 'id', value: 'E1' }, present: 'no' }] } })).toThrow('expectations.rows.0.present');
    expect(() => deserializeToolCheckCase({ ...base, expectations: { judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: 'yes' }] } })).toThrow('expectations.judgments.0.verdict');
    expect(() => deserializeToolCheckCase({ ...base, expectations: { judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: [] }] } })).toThrow(ToolCheckValidationError);
  });

  it('例外: 形は合っていても不変条件（verdict 非空・nodeId 非空）を破る保存データは createToolCheckCase で落ちる', () => {
    const base = serializeToolCheckCase(judged());
    expect(() => deserializeToolCheckCase({ ...base, expectations: { judgments: [{ nodeId: '', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }] } })).toThrow('createToolCheckCase: expectations.judgments[0].nodeId must be a non-empty string');
    expect(() => deserializeToolCheckCase({ ...base, expectations: { judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: [] }] } })).toThrow('createToolCheckCase: expectations.judgments[0].verdict must be a non-empty array of strings');
    expect(() => deserializeToolCheckCase({ ...base, expectations: { rows: [{ where: { column: '', value: 'E1' } }] } })).toThrow('createToolCheckCase: expectations.rows[0].where.column must be a non-empty string');
  });
});
