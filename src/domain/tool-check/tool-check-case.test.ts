import { describe, expect, it } from 'vitest';
import { ToolCheckValidationError } from './errors';
import {
  createToolCheckCase, TOOL_CHECK_MAX_CELLS, TOOL_CHECK_MAX_COLUMNS, TOOL_CHECK_MAX_DURATION_MS, TOOL_CHECK_NAME_MAX_LENGTH,
  validateToolCheckExpectations, withToolCheckLastResult, type CreateToolCheckCaseProps, type ToolCheckCellExpectation, type ToolCheckExpectations,
} from './tool-check-case';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-12T00:00:00.000Z';

function props(overrides: Partial<CreateToolCheckCaseProps> = {}): CreateToolCheckCaseProps {
  return {
    scope, id: 'case-1', toolId: 'sales-tool', toolVersion: '1.2.0', name: 'Tokyo sales',
    arguments: { region: 'Tokyo', minimum: 10, active: true, note: null },
    expectations: { rowCount: { op: 'gte', value: 1 }, columns: ['region', 'amount'], cells: [{ column: 'region', op: 'eq', value: 'Tokyo', mode: 'all' }], maxDurationMs: 5000 },
    createdAt: at, updatedAt: at,
    ...overrides,
  };
}

function expectations(overrides: Partial<ToolCheckExpectations>): ToolCheckExpectations {
  return { ...overrides };
}

function cell(index: number): ToolCheckCellExpectation {
  return { column: `c${index}`, op: 'eq', value: index, mode: 'any' };
}

describe('createToolCheckCase', () => {
  describe('正常', () => {
    it('妥当な入力から不変条件を満たすケースを組み立てる（引数・期待は複製される）', () => {
      const input = props();
      const created = createToolCheckCase(input);
      expect(created).toEqual({ ...input, scope: { ...scope } });
      expect(created.arguments).not.toBe(input.arguments);
      expect(created.expectations.columns).not.toBe(input.expectations.columns);
      expect(created.lastResult).toBeUndefined();
    });

    it('id を省略すると注入した makeId で生成する', () => {
      const created = createToolCheckCase(props({ id: undefined }), () => 'generated-id');
      expect(created.id).toBe('generated-id');
    });

    it('toolVersion 省略（最新版を追う）・期待なし・引数なしでも作れる', () => {
      const created = createToolCheckCase(props({ toolVersion: undefined, arguments: {}, expectations: {} }));
      expect(created.toolVersion).toBeUndefined();
      expect(created.arguments).toEqual({});
      expect(created.expectations).toEqual({});
    });

    it('name は前後の空白を落として保存する', () => {
      expect(createToolCheckCase(props({ name: '  Tokyo  ' })).name).toBe('Tokyo');
    });

    it('lastResult を持つケースも復元できる', () => {
      const lastResult = { status: 'failed' as const, checkedAt: at, toolVersion: '1.2.0', summary: 'failed 1/3: row count == 3 → row count 5' };
      expect(createToolCheckCase(props({ lastResult })).lastResult).toEqual(lastResult);
    });
  });

  describe('異常: 名前・識別子', () => {
    it.each([
      ['空文字', ''],
      ['空白のみ', '   '],
    ])('name が %s なら拒否', (_label, name) => {
      expect(() => createToolCheckCase(props({ name }))).toThrow(ToolCheckValidationError);
      expect(() => createToolCheckCase(props({ name }))).toThrow('createToolCheckCase: name must be a non-empty string');
    });

    it('toolId が空なら拒否', () => {
      expect(() => createToolCheckCase(props({ toolId: '' }))).toThrow('createToolCheckCase: toolId must be a non-empty string');
    });

    it('id が空で makeId も無ければ拒否', () => {
      expect(() => createToolCheckCase(props({ id: undefined }))).toThrow('createToolCheckCase: id must be a non-empty string');
      expect(() => createToolCheckCase(props({ id: '' }))).toThrow(ToolCheckValidationError);
    });

    it('toolVersion が SemVer でなければ拒否（メッセージに値を含む）', () => {
      expect(() => createToolCheckCase(props({ toolVersion: 'latest' }))).toThrow('createToolCheckCase: toolVersion must be a valid SemVer: latest');
    });

    it('scope が欠けていれば拒否', () => {
      expect(() => createToolCheckCase(props({ scope: { tenantId: '', workspaceId: 'w' } }))).toThrow('createToolCheckCase: scope.tenantId must be a non-empty string');
    });

    it('createdAt / updatedAt が ISO 8601 でなければ拒否', () => {
      expect(() => createToolCheckCase(props({ createdAt: 'yesterday' }))).toThrow('createToolCheckCase: createdAt must be an ISO 8601 date-time string');
      expect(() => createToolCheckCase(props({ updatedAt: '' }))).toThrow('createToolCheckCase: updatedAt must be an ISO 8601 date-time string');
    });
  });

  describe('異常: 引数', () => {
    it('引数名が空なら拒否', () => {
      expect(() => createToolCheckCase(props({ arguments: { '': 1 } }))).toThrow('createToolCheckCase: argument names must be non-empty strings');
    });

    it('JSON セル以外の値（オブジェクト・NaN・undefined）は拒否', () => {
      expect(() => createToolCheckCase(props({ arguments: { nested: { a: 1 } as unknown as string } }))).toThrow("createToolCheckCase: argument 'nested' must be a string, number, boolean or null");
      expect(() => createToolCheckCase(props({ arguments: { n: Number.NaN } }))).toThrow(ToolCheckValidationError);
      expect(() => createToolCheckCase(props({ arguments: { u: undefined as unknown as string } }))).toThrow(ToolCheckValidationError);
    });

    it('arguments が配列や null なら拒否', () => {
      expect(() => createToolCheckCase(props({ arguments: [] as unknown as Record<string, string> }))).toThrow('createToolCheckCase: arguments must be an object');
    });
  });

  describe('境界: 名前の長さ', () => {
    it(`${TOOL_CHECK_NAME_MAX_LENGTH} 文字は受理し、${TOOL_CHECK_NAME_MAX_LENGTH + 1} 文字は拒否`, () => {
      expect(createToolCheckCase(props({ name: 'a'.repeat(TOOL_CHECK_NAME_MAX_LENGTH) })).name).toHaveLength(TOOL_CHECK_NAME_MAX_LENGTH);
      expect(() => createToolCheckCase(props({ name: 'a'.repeat(TOOL_CHECK_NAME_MAX_LENGTH + 1) }))).toThrow(`createToolCheckCase: name must be at most ${TOOL_CHECK_NAME_MAX_LENGTH} characters`);
    });

    it('空白込みで上限を超えても、trim 後に収まれば受理', () => {
      expect(createToolCheckCase(props({ name: ` ${'a'.repeat(TOOL_CHECK_NAME_MAX_LENGTH)} ` })).name).toHaveLength(TOOL_CHECK_NAME_MAX_LENGTH);
    });
  });

  describe('境界: 期待（rowCount）', () => {
    it('0 は受理、-1 と 1.5 は拒否', () => {
      expect(createToolCheckCase(props({ expectations: expectations({ rowCount: { op: 'eq', value: 0 } }) })).expectations.rowCount).toEqual({ op: 'eq', value: 0 });
      expect(() => createToolCheckCase(props({ expectations: expectations({ rowCount: { op: 'eq', value: -1 } }) }))).toThrow('createToolCheckCase: expectations.rowCount.value must be a non-negative integer');
      expect(() => createToolCheckCase(props({ expectations: expectations({ rowCount: { op: 'eq', value: 1.5 } }) }))).toThrow(ToolCheckValidationError);
    });

    it('op が eq / gte / lte 以外なら拒否', () => {
      expect(() => createToolCheckCase(props({ expectations: expectations({ rowCount: { op: 'neq' as 'eq', value: 1 } }) }))).toThrow('createToolCheckCase: expectations.rowCount.op must be one of eq, gte, lte');
    });
  });

  describe('境界: 期待（columns）', () => {
    it(`${TOOL_CHECK_MAX_COLUMNS} 列は受理、${TOOL_CHECK_MAX_COLUMNS + 1} 列は拒否`, () => {
      const fifty = Array.from({ length: TOOL_CHECK_MAX_COLUMNS }, (_, index) => `c${index}`);
      expect(createToolCheckCase(props({ expectations: expectations({ columns: fifty }) })).expectations.columns).toHaveLength(TOOL_CHECK_MAX_COLUMNS);
      expect(() => createToolCheckCase(props({ expectations: expectations({ columns: [...fifty, 'extra'] }) }))).toThrow(`createToolCheckCase: expectations.columns must have at most ${TOOL_CHECK_MAX_COLUMNS} entries`);
    });

    it('重複・空文字の列名は拒否', () => {
      expect(() => createToolCheckCase(props({ expectations: expectations({ columns: ['a', 'a'] }) }))).toThrow('createToolCheckCase: expectations.columns contains a duplicate: a');
      expect(() => createToolCheckCase(props({ expectations: expectations({ columns: [''] }) }))).toThrow('createToolCheckCase: expectations.columns[] must be a non-empty string');
    });

    it('columns が配列でなければ拒否', () => {
      expect(() => createToolCheckCase(props({ expectations: expectations({ columns: 'a' as unknown as string[] }) }))).toThrow('createToolCheckCase: expectations.columns must be an array');
    });
  });

  describe('境界: 期待（cells）', () => {
    it(`${TOOL_CHECK_MAX_CELLS} 件は受理、${TOOL_CHECK_MAX_CELLS + 1} 件は拒否`, () => {
      const fifty = Array.from({ length: TOOL_CHECK_MAX_CELLS }, (_, index) => cell(index));
      expect(createToolCheckCase(props({ expectations: expectations({ cells: fifty }) })).expectations.cells).toHaveLength(TOOL_CHECK_MAX_CELLS);
      expect(() => createToolCheckCase(props({ expectations: expectations({ cells: [...fifty, cell(99)] }) }))).toThrow(`createToolCheckCase: expectations.cells must have at most ${TOOL_CHECK_MAX_CELLS} entries`);
    });

    it('不正な op / mode / 空の column / 非 JSON セル値は位置つきで拒否', () => {
      expect(() => createToolCheckCase(props({ expectations: expectations({ cells: [{ ...cell(0), op: 'like' as 'eq' }] }) }))).toThrow('createToolCheckCase: expectations.cells[0].op must be one of eq, neq, gte, lte, contains');
      expect(() => createToolCheckCase(props({ expectations: expectations({ cells: [cell(0), { ...cell(1), mode: 'none' as 'any' }] }) }))).toThrow('createToolCheckCase: expectations.cells[1].mode must be one of any, all');
      expect(() => createToolCheckCase(props({ expectations: expectations({ cells: [{ ...cell(0), column: ' ' }] }) }))).toThrow('createToolCheckCase: expectations.cells[0].column must be a non-empty string');
      expect(() => createToolCheckCase(props({ expectations: expectations({ cells: [{ ...cell(0), value: new Date() as unknown as string }] }) }))).toThrow('createToolCheckCase: expectations.cells[0].value must be a string, number, boolean or null');
    });

    it('null を期待値にできる（「空セルである」の検査）', () => {
      expect(createToolCheckCase(props({ expectations: expectations({ cells: [{ ...cell(0), value: null }] }) })).expectations.cells?.[0]?.value).toBeNull();
    });
  });

  describe('境界: 期待（maxDurationMs）', () => {
    it.each([1, TOOL_CHECK_MAX_DURATION_MS])('%d ms は受理', (max) => {
      expect(createToolCheckCase(props({ expectations: expectations({ maxDurationMs: max }) })).expectations.maxDurationMs).toBe(max);
    });

    it.each([0, TOOL_CHECK_MAX_DURATION_MS + 1, 10.5])('%s ms は拒否', (max) => {
      expect(() => createToolCheckCase(props({ expectations: expectations({ maxDurationMs: max }) }))).toThrow(`createToolCheckCase: expectations.maxDurationMs must be a positive integer up to ${TOOL_CHECK_MAX_DURATION_MS}`);
    });
  });

  describe('期待: outcome（実行の結末）', () => {
    it.each(['success', 'error'] as const)("正常: outcome '%s' は受理してそのまま保持する", (outcome) => {
      expect(createToolCheckCase(props({ expectations: expectations({ outcome }) })).expectations.outcome).toBe(outcome);
    });

    it('境界: outcome を省略すると期待にキー自体が現れない（従来データと同じ形）', () => {
      expect('outcome' in createToolCheckCase(props({ expectations: expectations({}) })).expectations).toBe(false);
    });

    it.each(['failed', 'ERROR', '', 1, null])('異常: outcome %s は拒否', (outcome) => {
      expect(() => createToolCheckCase(props({ expectations: expectations({ outcome: outcome as 'error' }) }))).toThrow(new ToolCheckValidationError('createToolCheckCase: expectations.outcome must be one of success, error'));
    });
  });

  describe('validateToolCheckExpectations（単体で使える期待の検証）', () => {
    it('正常: 妥当な期待を正規化して返し、集約の検証と同じ結果になる', () => {
      const value = { rowCount: { op: 'lte', value: 3 }, outcome: 'error', maxDurationMs: 10 };
      expect(validateToolCheckExpectations(value)).toEqual(createToolCheckCase(props({ expectations: value as ToolCheckExpectations })).expectations);
    });

    it('例外: 不正な期待は集約と同じ ToolCheckValidationError を投げる', () => {
      expect(() => validateToolCheckExpectations({ rowCount: { op: 'eq', value: -1 } })).toThrow(new ToolCheckValidationError('createToolCheckCase: expectations.rowCount.value must be a non-negative integer'));
      expect(() => validateToolCheckExpectations([])).toThrow(ToolCheckValidationError);
    });
  });

  describe('例外: 型の壊れた入力', () => {
    it('expectations がオブジェクトでなければ ToolCheckValidationError', () => {
      expect(() => createToolCheckCase(props({ expectations: null as unknown as ToolCheckExpectations }))).toThrow(new ToolCheckValidationError('createToolCheckCase: expectations must be an object'));
    });

    it('lastResult の status が不正なら拒否', () => {
      expect(() => createToolCheckCase(props({ lastResult: { status: 'skipped' as 'passed', checkedAt: at, toolVersion: '1.0.0', summary: '' } }))).toThrow('createToolCheckCase: lastResult.status must be one of passed, failed, error');
    });

    it('props 自体が無ければ拒否', () => {
      expect(() => createToolCheckCase(null as unknown as CreateToolCheckCaseProps)).toThrow(ToolCheckValidationError);
    });
  });
});

describe('withToolCheckLastResult', () => {
  it('lastResult だけを差し替え、updatedAt と定義は変えない', () => {
    const base = createToolCheckCase(props());
    const updated = withToolCheckLastResult(base, { status: 'passed', checkedAt: '2026-09-12T01:00:00.000Z', toolVersion: '1.2.0', summary: 'passed 4/4' });
    expect(updated.lastResult).toEqual({ status: 'passed', checkedAt: '2026-09-12T01:00:00.000Z', toolVersion: '1.2.0', summary: 'passed 4/4' });
    expect(updated.updatedAt).toBe(base.updatedAt);
    expect({ ...updated, lastResult: undefined }).toEqual({ ...base, lastResult: undefined });
    expect(base.lastResult).toBeUndefined();
  });

  it('checkedAt が ISO 8601 でなければ拒否', () => {
    expect(() => withToolCheckLastResult(createToolCheckCase(props()), { status: 'passed', checkedAt: 'now', toolVersion: '1.2.0', summary: '' })).toThrow('createToolCheckCase: lastResult.checkedAt must be an ISO 8601 date-time string');
  });
});
