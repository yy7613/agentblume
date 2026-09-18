import { describe, expect, it } from 'vitest';
import { ToolCheckValidationError } from './errors';
import {
  createToolCheckCase, TOOL_CHECK_MAX_CELLS, TOOL_CHECK_MAX_COLUMNS, TOOL_CHECK_MAX_DURATION_MS, TOOL_CHECK_NAME_MAX_LENGTH,
  TOOL_CHECK_MAX_JUDGMENTS, TOOL_CHECK_MAX_ROW_CELLS, TOOL_CHECK_MAX_ROWS, TOOL_CHECK_MAX_VERDICTS,
  validateToolCheckExpectations, withToolCheckLastResult, type CreateToolCheckCaseProps, type ToolCheckCellExpectation, type ToolCheckExpectations,
  type ToolCheckJudgmentExpectation, type ToolCheckRowExpectation,
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

/** 行を特定した期待の雛形。 */
function rowExpectation(overrides: Partial<ToolCheckRowExpectation> = {}): ToolCheckRowExpectation {
  return { where: { column: 'id', value: 'E1' }, ...overrides };
}

/** AI 判定への期待の雛形。 */
function judgmentExpectation(overrides: Partial<ToolCheckJudgmentExpectation> = {}): ToolCheckJudgmentExpectation {
  return { nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'], ...overrides };
}

/** `expectations.rows` を検証して、指定のメッセージで落ちることを確かめる。 */
function rejectRows(rows: unknown, message: string): void {
  expect(() => validateToolCheckExpectations({ rows })).toThrow(new ToolCheckValidationError(message));
}

/** `expectations.judgments` を検証して、指定のメッセージで落ちることを確かめる。 */
function rejectJudgments(judgments: unknown, message: string): void {
  expect(() => validateToolCheckExpectations({ judgments })).toThrow(new ToolCheckValidationError(message));
}

describe('validateToolCheckExpectations: rows（終端出力の行を特定した期待）', () => {
  describe('正常', () => {
    it('where / present / cells を正規化して返す（present 省略時はキー自体が現れない）', () => {
      const result = validateToolCheckExpectations({ rows: [
        { where: { column: 'id', value: 'E1' }, cells: [{ column: 'amount', op: 'gte', value: 10000 }, { column: 'note', op: 'contains', value: '交通費' }] },
        { where: { column: 'id', value: 'E2' }, present: false },
        { where: { column: 'id', value: 'E3' }, present: true },
      ] });
      expect(result.rows).toEqual([
        { where: { column: 'id', value: 'E1' }, cells: [{ column: 'amount', op: 'gte', value: 10000 }, { column: 'note', op: 'contains', value: '交通費' }] },
        { where: { column: 'id', value: 'E2' }, present: false },
        { where: { column: 'id', value: 'E3' }, present: true },
      ]);
      expect('present' in (result.rows?.[0] ?? {})).toBe(false);
      expect('cells' in (result.rows?.[1] ?? {})).toBe(false);
    });

    it('where.value は null / 数値 / 真偽値も取れる（行の特定は JSON セルの一致）', () => {
      const result = validateToolCheckExpectations({ rows: [
        rowExpectation({ where: { column: 'id', value: null } }),
        rowExpectation({ where: { column: 'seq', value: 3 } }),
        rowExpectation({ where: { column: 'paid', value: false } }),
      ] });
      expect(result.rows?.map((row) => row.where.value)).toEqual([null, 3, false]);
    });

    it('期待は複製される（元の配列・where・cells と参照を共有しない）', () => {
      const rows: ToolCheckRowExpectation[] = [rowExpectation({ cells: [{ column: 'amount', op: 'eq', value: 1 }] })];
      const created = createToolCheckCase(props({ expectations: { rows } }));
      expect(created.expectations.rows).toEqual(rows);
      expect(created.expectations.rows).not.toBe(rows);
      expect(created.expectations.rows?.[0]?.where).not.toBe(rows[0]?.where);
      expect(created.expectations.rows?.[0]?.cells?.[0]).not.toBe(rows[0]?.cells?.[0]);
    });
  });

  describe('境界', () => {
    it(`rows は ${TOOL_CHECK_MAX_ROWS} 件は受理、${TOOL_CHECK_MAX_ROWS + 1} 件は拒否`, () => {
      const rows = Array.from({ length: TOOL_CHECK_MAX_ROWS }, (_, index) => rowExpectation({ where: { column: 'id', value: `E${index}` } }));
      expect(validateToolCheckExpectations({ rows }).rows).toHaveLength(TOOL_CHECK_MAX_ROWS);
      rejectRows([...rows, rowExpectation()], `createToolCheckCase: expectations.rows must have at most ${TOOL_CHECK_MAX_ROWS} entries`);
    });

    it(`cells は ${TOOL_CHECK_MAX_ROW_CELLS} 件まで受理、${TOOL_CHECK_MAX_ROW_CELLS + 1} 件は拒否`, () => {
      const cells = Array.from({ length: TOOL_CHECK_MAX_ROW_CELLS }, (_, index) => ({ column: `c${index}`, op: 'eq' as const, value: index }));
      expect(validateToolCheckExpectations({ rows: [rowExpectation({ cells })] }).rows?.[0]?.cells).toHaveLength(TOOL_CHECK_MAX_ROW_CELLS);
      rejectRows([rowExpectation({ cells: [...cells, { column: 'x', op: 'eq', value: 1 }] })], `createToolCheckCase: expectations.rows[0].cells must have at most ${TOOL_CHECK_MAX_ROW_CELLS} entries`);
    });

    it('空配列・cells 空配列は受理する（「行の存在だけ」を見る期待）', () => {
      expect(validateToolCheckExpectations({ rows: [] }).rows).toEqual([]);
      expect(validateToolCheckExpectations({ rows: [rowExpectation({ cells: [] })] }).rows?.[0]?.cells).toEqual([]);
    });
  });

  describe('異常', () => {
    it('配列でなければ拒否', () => {
      rejectRows({ where: { column: 'id', value: 'E1' } }, 'createToolCheckCase: expectations.rows must be an array');
      rejectRows('E1', 'createToolCheckCase: expectations.rows must be an array');
    });

    it('where が無い / オブジェクトでなければ位置つきで拒否', () => {
      rejectRows([{ cells: [] }], 'createToolCheckCase: expectations.rows[0].where must be an object with column and value');
      rejectRows([rowExpectation(), { where: 'id' }], 'createToolCheckCase: expectations.rows[1].where must be an object with column and value');
      rejectRows([null], 'createToolCheckCase: expectations.rows[0].where must be an object with column and value');
    });

    it('where.column が空 / where.value が JSON セルでなければ拒否', () => {
      rejectRows([{ where: { column: ' ', value: 'E1' } }], 'createToolCheckCase: expectations.rows[0].where.column must be a non-empty string');
      rejectRows([{ where: { column: 'id', value: { nested: true } } }], 'createToolCheckCase: expectations.rows[0].where.value must be a string, number, boolean or null');
      rejectRows([{ where: { column: 'id', value: new Date() } }], 'createToolCheckCase: expectations.rows[0].where.value must be a string, number, boolean or null');
    });

    it('present が真偽値でなければ拒否', () => {
      rejectRows([rowExpectation({ present: 'false' as unknown as boolean })], 'createToolCheckCase: expectations.rows[0].present must be a boolean');
      rejectRows([rowExpectation({ present: 0 as unknown as boolean })], 'createToolCheckCase: expectations.rows[0].present must be a boolean');
    });

    it('cells が配列でない / 列が空 / op が不正 / 値が JSON セルでなければ位置つきで拒否', () => {
      rejectRows([rowExpectation({ cells: 'amount' as unknown as [] })], 'createToolCheckCase: expectations.rows[0].cells must be an array');
      rejectRows([rowExpectation({ cells: [{ column: '', op: 'eq', value: 1 }] })], 'createToolCheckCase: expectations.rows[0].cells[0].column must be a non-empty string');
      rejectRows([rowExpectation({ cells: [{ column: 'a', op: 'eq', value: 1 }, { column: 'b', op: 'like' as 'eq', value: 1 }] })], 'createToolCheckCase: expectations.rows[0].cells[1].op must be one of eq, neq, gte, lte, contains');
      rejectRows([rowExpectation({ cells: [{ column: 'a', op: 'eq', value: undefined as unknown as string }] })], 'createToolCheckCase: expectations.rows[0].cells[0].value must be a string, number, boolean or null');
    });
  });
});

describe('validateToolCheckExpectations: judgments（AI 判定への期待）', () => {
  describe('正常', () => {
    it('nodeId / where / verdict / reasonContains を正規化して返す（reasonContains 省略時はキーが現れない）', () => {
      const result = validateToolCheckExpectations({ judgments: [
        { nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes', 'unclear'] },
        { nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'], reasonContains: '規程' },
      ] });
      expect(result.judgments).toEqual([
        { nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes', 'unclear'] },
        { nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'], reasonContains: '規程' },
      ]);
      expect('reasonContains' in (result.judgments?.[0] ?? {})).toBe(false);
    });

    it('期待は複製される（元の配列・where・verdict と参照を共有しない）', () => {
      const judgments: ToolCheckJudgmentExpectation[] = [judgmentExpectation({ verdict: ['yes', 'no'] })];
      const created = createToolCheckCase(props({ expectations: { judgments } }));
      expect(created.expectations.judgments).toEqual(judgments);
      expect(created.expectations.judgments).not.toBe(judgments);
      expect(created.expectations.judgments?.[0]?.where).not.toBe(judgments[0]?.where);
      expect(created.expectations.judgments?.[0]?.verdict).not.toBe(judgments[0]?.verdict);
    });
  });

  describe('境界', () => {
    it(`judgments は ${TOOL_CHECK_MAX_JUDGMENTS} 件は受理、${TOOL_CHECK_MAX_JUDGMENTS + 1} 件は拒否`, () => {
      const judgments = Array.from({ length: TOOL_CHECK_MAX_JUDGMENTS }, (_, index) => judgmentExpectation({ where: { column: 'id', value: `E${index}` } }));
      expect(validateToolCheckExpectations({ judgments }).judgments).toHaveLength(TOOL_CHECK_MAX_JUDGMENTS);
      rejectJudgments([...judgments, judgmentExpectation()], `createToolCheckCase: expectations.judgments must have at most ${TOOL_CHECK_MAX_JUDGMENTS} entries`);
    });

    it(`verdict は 1 件から ${TOOL_CHECK_MAX_VERDICTS} 件まで受理、${TOOL_CHECK_MAX_VERDICTS + 1} 件は拒否`, () => {
      const verdict = Array.from({ length: TOOL_CHECK_MAX_VERDICTS }, (_, index) => `v${index}`);
      expect(validateToolCheckExpectations({ judgments: [judgmentExpectation({ verdict })] }).judgments?.[0]?.verdict).toHaveLength(TOOL_CHECK_MAX_VERDICTS);
      expect(validateToolCheckExpectations({ judgments: [judgmentExpectation({ verdict: ['yes'] })] }).judgments?.[0]?.verdict).toEqual(['yes']);
      rejectJudgments([judgmentExpectation({ verdict: [...verdict, 'extra'] })], `createToolCheckCase: expectations.judgments[0].verdict must have at most ${TOOL_CHECK_MAX_VERDICTS} entries`);
    });

    it('空配列は受理する（判定への期待なし）', () => {
      expect(validateToolCheckExpectations({ judgments: [] }).judgments).toEqual([]);
    });
  });

  describe('異常', () => {
    it('配列でなければ拒否', () => {
      rejectJudgments({ nodeId: 'judge' }, 'createToolCheckCase: expectations.judgments must be an array');
    });

    it('nodeId が空文字 / 欠落なら位置つきで拒否', () => {
      rejectJudgments([judgmentExpectation({ nodeId: '' })], 'createToolCheckCase: expectations.judgments[0].nodeId must be a non-empty string');
      rejectJudgments([judgmentExpectation(), { where: { column: 'id', value: 'E1' }, verdict: ['yes'] }], 'createToolCheckCase: expectations.judgments[1].nodeId must be a non-empty string');
      rejectJudgments([null], 'createToolCheckCase: expectations.judgments[0].nodeId must be a non-empty string');
    });

    it('where が無い / column が空 / value が JSON セルでなければ拒否', () => {
      rejectJudgments([{ nodeId: 'judge', verdict: ['yes'] }], 'createToolCheckCase: expectations.judgments[0].where must be an object with column and value');
      rejectJudgments([judgmentExpectation({ where: { column: '', value: 'E1' } })], 'createToolCheckCase: expectations.judgments[0].where.column must be a non-empty string');
      rejectJudgments([judgmentExpectation({ where: { column: 'id', value: [] as unknown as string } })], 'createToolCheckCase: expectations.judgments[0].where.value must be a string, number, boolean or null');
    });

    it('verdict が配列でない / 空配列なら拒否', () => {
      rejectJudgments([judgmentExpectation({ verdict: [] })], 'createToolCheckCase: expectations.judgments[0].verdict must be a non-empty array of strings');
      rejectJudgments([judgmentExpectation({ verdict: 'yes' as unknown as string[] })], 'createToolCheckCase: expectations.judgments[0].verdict must be a non-empty array of strings');
    });

    it('verdict に空文字 / 文字列でない値があれば拒否', () => {
      rejectJudgments([judgmentExpectation({ verdict: ['yes', ''] })], 'createToolCheckCase: expectations.judgments[0].verdict[] must be a non-empty string');
      rejectJudgments([judgmentExpectation({ verdict: ['  '] })], 'createToolCheckCase: expectations.judgments[0].verdict[] must be a non-empty string');
      rejectJudgments([judgmentExpectation({ verdict: [1 as unknown as string] })], 'createToolCheckCase: expectations.judgments[0].verdict[] must be a non-empty string');
    });

    it('reasonContains が空文字 / 文字列でなければ拒否', () => {
      rejectJudgments([judgmentExpectation({ reasonContains: '' })], 'createToolCheckCase: expectations.judgments[0].reasonContains must be a non-empty string');
      rejectJudgments([judgmentExpectation({ reasonContains: 1 as unknown as string })], 'createToolCheckCase: expectations.judgments[0].reasonContains must be a non-empty string');
    });
  });
});
