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
