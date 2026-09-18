/**
 * 期待（expectations）の評価のうち、行を特定した期待（rows）と AI 判定の期待（judgments）のテスト。
 *
 * `expected` / `actual` の定型文は UI が正規表現で日本語化するので、文言まで固定する
 * （rowCount / columns / cells / duration / outcome は run-tool-check.test.ts が実行経由で押さえている）。
 */
import { describe, expect, it } from 'vitest';
import type { Table } from '../../domain/data/types';
import type { ToolCheckJudgmentExpectation, ToolCheckRowExpectation } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckJudgmentTable } from './judgments';
import { evaluateExpectations, evaluateSuccessfulRun, type ToolCheckAssertion } from './tool-check-result';

const output: Table = {
  schema: { columns: [
    { name: 'id', type: 'string', nullable: false },
    { name: 'amount', type: 'number', nullable: false },
    { name: 'note', type: 'string', nullable: true },
    { name: 'soldAt', type: 'date', nullable: false },
  ] },
  rows: [
    { id: 'E1', amount: 12000, note: '交通費 精算', soldAt: new Date('2026-01-05T00:00:00.000Z') },
    { id: 'E2', amount: 500, note: null, soldAt: new Date('2026-01-06T00:00:00.000Z') },
  ],
};

const judgeTable: ToolCheckJudgmentTable = {
  nodeId: 'judge',
  verdictColumn: 'aiVerdict',
  reasonColumn: 'aiReason',
  table: {
    schema: { columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'amount', type: 'number', nullable: false },
      { name: 'aiVerdict', type: 'string', nullable: false },
      { name: 'aiReason', type: 'string', nullable: true },
    ] },
    rows: [
      { id: 'E1', amount: 12000, aiVerdict: 'yes', aiReason: '交通費として規程に合う' },
      { id: 'E2', amount: 500, aiVerdict: 'no', aiReason: '領収書が無い' },
      { id: 'E3', amount: 100, aiVerdict: 'unclear', aiReason: '' },
    ],
  },
};

/** rows だけを評価する（所要時間の期待は置かない）。 */
function evaluateRows(...rows: readonly ToolCheckRowExpectation[]): readonly ToolCheckAssertion[] {
  return evaluateExpectations({ rows }, output, 0);
}

/** judgments だけを評価する（既定で judge の判定表を渡す）。 */
function evaluateJudgments(judgments: readonly ToolCheckJudgmentExpectation[], tables: readonly ToolCheckJudgmentTable[] = [judgeTable]): readonly ToolCheckAssertion[] {
  return evaluateExpectations({ judgments }, output, 0, tables);
}

describe('evaluateExpectations: rows（行を特定した期待）', () => {
  describe('正常: 行の存在', () => {
    it('存在する行は合格、無い行は不合格で、actual は present / absent', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E1' } })).toEqual([
        { kind: 'row', passed: true, expected: 'row[id == "E1"] present', actual: 'present' },
      ]);
      expect(evaluateRows({ where: { column: 'id', value: 'E9' } })).toEqual([
        { kind: 'row', passed: false, expected: 'row[id == "E9"] present', actual: 'absent' },
      ]);
    });

    it('present: true を明示しても省略と同じ（present の定型文）', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E1' }, present: true })).toEqual([
        { kind: 'row', passed: true, expected: 'row[id == "E1"] present', actual: 'present' },
      ]);
    });

    it('present: false は「その行が無い」ことの期待（absent の定型文）', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E9' }, present: false })).toEqual([
        { kind: 'row', passed: true, expected: 'row[id == "E9"] absent', actual: 'absent' },
      ]);
      expect(evaluateRows({ where: { column: 'id', value: 'E1' }, present: false })).toEqual([
        { kind: 'row', passed: false, expected: 'row[id == "E1"] absent', actual: 'present' },
      ]);
    });

    it('present: false は cells を評価しない（存在の assertion だけ）', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E9' }, present: false, cells: [{ column: 'amount', op: 'eq', value: 1 }] })).toHaveLength(1);
    });

    it('数値 / 真偽値 / null の特定条件も JSON 表現で定型文になる', () => {
      expect(evaluateRows({ where: { column: 'amount', value: 500 } })[0]).toMatchObject({ passed: true, expected: 'row[amount == 500] present' });
      expect(evaluateRows({ where: { column: 'note', value: null } })[0]).toMatchObject({ passed: true, expected: 'row[note == null] present', actual: 'present' });
    });
  });

  describe('正常: 特定した行のセル', () => {
    it.each([
      ['eq', 'amount', 12000, true, 'row[id == "E1"].amount == 12000', '12000'],
      ['eq', 'amount', 1, false, 'row[id == "E1"].amount == 1', '12000'],
      ['neq', 'amount', 1, true, 'row[id == "E1"].amount != 1', '12000'],
      ['gte', 'amount', 12000, true, 'row[id == "E1"].amount >= 12000', '12000'],
      ['gte', 'amount', 12001, false, 'row[id == "E1"].amount >= 12001', '12000'],
      ['lte', 'amount', 12000, true, 'row[id == "E1"].amount <= 12000', '12000'],
      ['lte', 'amount', 11999, false, 'row[id == "E1"].amount <= 11999', '12000'],
      ['contains', 'note', '交通費', true, 'row[id == "E1"].note contains "交通費"', '"交通費 精算"'],
      ['contains', 'note', '宿泊', false, 'row[id == "E1"].note contains "宿泊"', '"交通費 精算"'],
    ] as const)('%s %s %s', (op, column, value, passed, expected, actual) => {
      expect(evaluateRows({ where: { column: 'id', value: 'E1' }, cells: [{ column, op, value }] })).toEqual([
        { kind: 'row', passed, expected, actual },
      ]);
    });

    it('1 セル 1 assertion（複数セルは順に並ぶ）', () => {
      const assertions = evaluateRows({ where: { column: 'id', value: 'E1' }, cells: [
        { column: 'amount', op: 'gte', value: 10000 },
        { column: 'note', op: 'contains', value: '精算' },
      ] });
      expect(assertions.map((assertion) => [assertion.kind, assertion.passed])).toEqual([['row', true], ['row', true]]);
      expect(assertions.map((assertion) => assertion.expected)).toEqual(['row[id == "E1"].amount >= 10000', 'row[id == "E1"].note contains "精算"']);
    });

    it('Date セルは ISO 文字列へ寄せて比較し、actual もその表現になる', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E1' }, cells: [{ column: 'soldAt', op: 'eq', value: '2026-01-05T00:00:00.000Z' }] })).toEqual([
        { kind: 'row', passed: true, expected: 'row[id == "E1"].soldAt == "2026-01-05T00:00:00.000Z"', actual: '"2026-01-05T00:00:00.000Z"' },
      ]);
    });

    it('null セルは eq null にだけ一致し、actual は null', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E2' }, cells: [{ column: 'note', op: 'eq', value: null }, { column: 'note', op: 'contains', value: 'x' }] })).toEqual([
        { kind: 'row', passed: true, expected: 'row[id == "E2"].note == null', actual: 'null' },
        { kind: 'row', passed: false, expected: 'row[id == "E2"].note contains "x"', actual: 'null' },
      ]);
    });

    it('複数行が一致する特定条件は最初の行を見る', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E1' }, cells: [{ column: 'amount', op: 'eq', value: 12000 }] })[0]?.passed).toBe(true);
    });
  });

  describe('異常: 列や行が無い', () => {
    it('特定条件の列が出力に無ければ不合格で、actual が列の欠落を示す（present / absent どちらも）', () => {
      expect(evaluateRows({ where: { column: 'ghost', value: 'E1' } })).toEqual([
        { kind: 'row', passed: false, expected: 'row[ghost == "E1"] present', actual: "column 'ghost' not in output" },
      ]);
      expect(evaluateRows({ where: { column: 'ghost', value: 'E1' }, present: false })).toEqual([
        { kind: 'row', passed: false, expected: 'row[ghost == "E1"] absent', actual: "column 'ghost' not in output" },
      ]);
    });

    it('行が見つからなければセルの assertion は row not found', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E9' }, cells: [{ column: 'amount', op: 'eq', value: 1 }, { column: 'note', op: 'eq', value: null }] })).toEqual([
        { kind: 'row', passed: false, expected: 'row[id == "E9"].amount == 1', actual: 'row not found' },
        { kind: 'row', passed: false, expected: 'row[id == "E9"].note == null', actual: 'row not found' },
      ]);
    });

    it('セルの列が出力に無ければ不合格で、actual が列の欠落を示す', () => {
      expect(evaluateRows({ where: { column: 'id', value: 'E1' }, cells: [{ column: 'ghost', op: 'eq', value: 1 }] })).toEqual([
        { kind: 'row', passed: false, expected: 'row[id == "E1"].ghost == 1', actual: "column 'ghost' not in output" },
      ]);
    });
  });
});

describe('evaluateExpectations: judgments（AI 判定の期待）', () => {
  describe('正常', () => {
    it('判定値がいずれかに一致すれば合格で、actual は「判定値 (理由)」', () => {
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes', 'unclear'] }])).toEqual([
        { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E1"] in ["yes", "unclear"]', actual: 'yes (交通費として規程に合う)' },
      ]);
    });

    it('keep / exclude で終端から消えた行の判定も検証できる（判定表はノードの入力行）', () => {
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'id', value: 'E3' }, verdict: ['unclear'] }])).toEqual([
        { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E3"] in ["unclear"]', actual: 'unclear ()' },
      ]);
    });

    it('判定値が一致しなければ不合格（実際の判定と理由を actual に見せる）', () => {
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['yes'] }])).toEqual([
        { kind: 'judgment', passed: false, expected: 'judgment[judge][id == "E2"] in ["yes"]', actual: 'no (領収書が無い)' },
      ]);
    });

    it('reasonContains は判定値とは別の 2 本目の assertion になる（合格・不合格とも actual は理由の JSON）', () => {
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'], reasonContains: '領収書' }])).toEqual([
        { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E2"] in ["no"]', actual: 'no (領収書が無い)' },
        { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E2"] reason contains "領収書"', actual: '"領収書が無い"' },
      ]);
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'], reasonContains: '規程' }])[1]).toEqual(
        { kind: 'judgment', passed: false, expected: 'judgment[judge][id == "E2"] reason contains "規程"', actual: '"領収書が無い"' },
      );
    });

    it('複数ノードの判定表から nodeId で選ぶ', () => {
      const second: ToolCheckJudgmentTable = {
        nodeId: 'second',
        verdictColumn: 'category',
        reasonColumn: 'why',
        table: { schema: { columns: [{ name: 'id', type: 'string', nullable: false }, { name: 'category', type: 'string', nullable: false }, { name: 'why', type: 'string', nullable: true }] }, rows: [{ id: 'E1', category: '旅費', why: '移動の実費' }] },
      };
      expect(evaluateJudgments([{ nodeId: 'second', where: { column: 'id', value: 'E1' }, verdict: ['旅費'] }], [judgeTable, second])).toEqual([
        { kind: 'judgment', passed: true, expected: 'judgment[second][id == "E1"] in ["旅費"]', actual: '旅費 (移動の実費)' },
      ]);
    });
  });

  describe('異常: ノード・列・行が無い', () => {
    it('そのノードの判定が無ければ不合格（判定表が空のときも同じ）', () => {
      const expected = { kind: 'judgment', passed: false, expected: 'judgment[missing][id == "E1"] in ["yes"]', actual: "node 'missing' not judged" };
      expect(evaluateJudgments([{ nodeId: 'missing', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }])).toEqual([expected]);
      expect(evaluateJudgments([{ nodeId: 'missing', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }], [])).toEqual([expected]);
    });

    it('特定条件の列がノードの入力に無ければ不合格（終端出力ではなく入力を見ていることの確認）', () => {
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'note', value: null }, verdict: ['yes'] }])).toEqual([
        { kind: 'judgment', passed: false, expected: 'judgment[judge][note == null] in ["yes"]', actual: "column 'note' not in node input" },
      ]);
    });

    it('行が見つからなければ不合格（reasonContains があれば 2 本とも同じ actual で落ちる）', () => {
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'id', value: 'E9' }, verdict: ['yes'], reasonContains: '規程' }])).toEqual([
        { kind: 'judgment', passed: false, expected: 'judgment[judge][id == "E9"] in ["yes"]', actual: 'row not found' },
        { kind: 'judgment', passed: false, expected: 'judgment[judge][id == "E9"] reason contains "規程"', actual: 'row not found' },
      ]);
    });

    it('ノードが無い / 列が無いときも reasonContains の assertion を落として見せる', () => {
      expect(evaluateJudgments([{ nodeId: 'missing', where: { column: 'id', value: 'E1' }, verdict: ['yes'], reasonContains: 'x' }]).map((assertion) => assertion.actual))
        .toEqual(["node 'missing' not judged", "node 'missing' not judged"]);
      expect(evaluateJudgments([{ nodeId: 'judge', where: { column: 'ghost', value: 1 }, verdict: ['yes'], reasonContains: 'x' }]).map((assertion) => assertion.actual))
        .toEqual(["column 'ghost' not in node input", "column 'ghost' not in node input"]);
    });
  });

  describe('境界', () => {
    it('judgments を渡さなくても rows / cells の評価は従来どおり動く（判定の期待だけが落ちる）', () => {
      expect(evaluateExpectations({ rowCount: { op: 'eq', value: 2 } }, output, 0)).toEqual([
        { kind: 'rowCount', passed: true, expected: 'row count == 2', actual: 'row count 2' },
      ]);
      expect(evaluateExpectations({ judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }] }, output, 0)[0]?.actual).toBe("node 'judge' not judged");
    });

    it('assertion の並びは rowCount → columns → cells → rows → judgments → duration', () => {
      const assertions = evaluateExpectations({
        rowCount: { op: 'eq', value: 2 },
        columns: ['id'],
        cells: [{ column: 'amount', op: 'gte', value: 0, mode: 'all' }],
        rows: [{ where: { column: 'id', value: 'E1' } }],
        judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }],
        maxDurationMs: 1000,
      }, output, 10, [judgeTable]);
      expect(assertions.map((assertion) => assertion.kind)).toEqual(['rowCount', 'column', 'cell', 'row', 'judgment', 'duration']);
      expect(assertions.every((assertion) => assertion.passed)).toBe(true);
    });
  });
});

describe('evaluateSuccessfulRun: judgments を含む合否', () => {
  it('判定の期待がすべて合格なら passed', () => {
    const { status, assertions } = evaluateSuccessfulRun({ judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'], reasonContains: '規程' }] }, output, 5, [judgeTable]);
    expect(status).toBe('passed');
    expect(assertions).toHaveLength(2);
  });

  it('判定の期待が 1 つでも落ちれば failed（他の期待が合格でも）', () => {
    const { status, assertions } = evaluateSuccessfulRun({
      rowCount: { op: 'eq', value: 2 },
      judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['yes'] }],
    }, output, 5, [judgeTable]);
    expect(status).toBe('failed');
    expect(assertions.filter((assertion) => !assertion.passed)).toEqual([
      { kind: 'judgment', passed: false, expected: 'judgment[judge][id == "E2"] in ["yes"]', actual: 'no (領収書が無い)' },
    ]);
  });

  it('行を特定した期待が落ちても failed', () => {
    const { status } = evaluateSuccessfulRun({ rows: [{ where: { column: 'id', value: 'E1' }, present: false }] }, output, 5, [judgeTable]);
    expect(status).toBe('failed');
  });

  it('判定表を渡さなければ判定の期待は落ちる（配線漏れを黙って合格にしない）', () => {
    expect(evaluateSuccessfulRun({ judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }] }, output, 5).status).toBe('failed');
  });
});
